-- Every new/replacement catalog image is measured and explicitly reviewed before the existing product RPC publishes it.
-- Existing images and metadata-only saves require no job. Approval only stages an immutable URL.
begin;

alter table public.product add column if not exists image_revision integer not null default 0;

create table public.product_image_approval (
  approval_id uuid primary key,
  reviewer_id uuid not null references public.users(user_id),
  product_id uuid references public.product(product_id),
  expected_version integer not null check (expected_version >= 0),
  job_id uuid not null,
  selection text not null check (selection in ('original', 'enhanced')),
  asset_url text not null unique,
  source_revision text not null check (source_revision ~ '^[a-f0-9]{64}$'),
  image_revision text not null check (image_revision ~ '^[a-f0-9]{64}$'),
  processing_version text not null check (length(btrim(processing_version)) between 1 and 200),
  quality_gate jsonb not null,
  approved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_product_id uuid references public.product(product_id) deferrable initially deferred,
  consumed_product_version integer,
  consumed_image_revision integer,
  ip_address text,
  check ((product_id is null and expected_version = 0) or (product_id is not null and expected_version > 0))
);
create index product_image_approval_product_idx on public.product_image_approval(consumed_product_id, consumed_image_revision);
alter table public.product_image_approval enable row level security;
revoke all on public.product_image_approval from public, anon, authenticated;
grant select on public.product_image_approval to authenticated;
create policy image_approval_reviewer_read on public.product_image_approval for select to authenticated
  using (reviewer_id = public.velura_current_user_id());

-- Only the API service role can attest engine bytes/measurements. Its actor is revalidated against the database.
create function public.velura_stage_image_approval(
  p_approval_id uuid, p_actor_id uuid, p_product_id uuid, p_expected_version integer,
  p_job_id uuid, p_selection text, p_asset_url text, p_source_revision text, p_image_revision text,
  p_processing_version text, p_quality_gate jsonb, p_expires_at timestamptz, p_ip_address text
) returns uuid language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare
  v_actor public.users%rowtype;
  v_version integer;
begin
  select * into v_actor from public.users where user_id = p_actor_id;
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or v_actor.is_active is not true
    or v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if p_product_id is null then
    if p_expected_version is distinct from 0 then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  else
    select version into v_version from public.product where product_id = p_product_id for share;
    if v_version is null then raise sqlstate 'PT404' using message = 'PRODUCT_NOT_FOUND'; end if;
    if v_version is distinct from p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  end if;
  if p_quality_gate->'valid' is distinct from 'true'::jsonb
    or jsonb_typeof(p_quality_gate#>'{metrics,brightness}') is distinct from 'number'
    or jsonb_typeof(p_quality_gate#>'{metrics,sharpness}') is distinct from 'number'
    or jsonb_typeof(p_quality_gate#>'{metrics,background_score}') is distinct from 'number'
    or p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '24 hours 1 minute'
    or p_asset_url is null
    or p_asset_url !~ ('^https?://[^/]+/storage/v1/object/public/product-images/ai-reviewed/' || p_approval_id::text || '\.(png|jpg|webp)$') then
    raise sqlstate 'PT422' using message = 'INVALID_IMAGE_EVIDENCE';
  end if;
  insert into public.product_image_approval(
    approval_id, reviewer_id, product_id, expected_version, job_id, selection, asset_url,
    source_revision, image_revision, processing_version, quality_gate, expires_at, ip_address
  ) values (
    p_approval_id, p_actor_id, p_product_id, p_expected_version, p_job_id, p_selection, p_asset_url,
    lower(p_source_revision), lower(p_image_revision), p_processing_version, p_quality_gate, p_expires_at, p_ip_address
  );
  perform public.velura_append_module_audit('products', v_actor.user_id, v_actor.admin_role::text,
    'update', p_approval_id, null, jsonb_build_object('image_approval', 'staged', 'job_id', p_job_id,
      'product_id', p_product_id, 'expected_version', p_expected_version, 'selection', p_selection,
      'source_revision', p_source_revision, 'processing_version', p_processing_version), p_ip_address);
  return p_approval_id;
end;
$$;
revoke all on function public.velura_stage_image_approval(uuid,uuid,uuid,integer,uuid,text,text,text,text,text,jsonb,timestamptz,text) from public, anon, authenticated;
grant execute on function public.velura_stage_image_approval(uuid,uuid,uuid,integer,uuid,text,text,text,text,text,jsonb,timestamptz,text) to service_role;

-- Before images change, consume the review in the SAME transaction as the product save.
-- Any later constraint/RPC failure rolls consumption back together with product.images.
create function public.velura_consume_product_image_approvals() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare
  v_actor public.users%rowtype;
  v_approval public.product_image_approval%rowtype;
  v_url text;
  v_previous text[] := '{}';
  v_expected integer := 0;
  v_revision integer := 1;
begin
  if tg_op = 'UPDATE' then
    if new.images is not distinct from old.images then
      new.image_revision := old.image_revision;
      return new;
    end if;
    v_previous := coalesce(old.images, '{}');
    v_expected := old.version;
    v_revision := old.image_revision + 1;
  elsif coalesce(cardinality(new.images), 0) = 0 then
    new.image_revision := 0;
    return new;
  end if;
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or v_actor.is_active is not true
    or v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  new.image_revision := v_revision;
  for v_url in select distinct unnest(coalesce(new.images, '{}')) loop
    if v_url = any(v_previous) then continue; end if;
    select * into v_approval from public.product_image_approval where asset_url = v_url for update;
    if v_approval.approval_id is null or v_approval.reviewer_id <> v_actor.user_id
      or v_approval.consumed_at is not null or v_approval.expires_at <= now() then
      raise sqlstate 'PT422' using message = 'IMAGE_APPROVAL_REQUIRED';
    end if;
    if v_approval.expected_version <> v_expected
      or (tg_op = 'UPDATE' and v_approval.product_id is distinct from new.product_id)
      or (tg_op = 'INSERT' and v_approval.product_id is not null) then
      raise sqlstate 'PT409' using message = 'IMAGE_APPROVAL_VERSION_CONFLICT';
    end if;
    update public.product_image_approval set consumed_at = now(), consumed_product_id = new.product_id,
      consumed_product_version = new.version, consumed_image_revision = v_revision
      where approval_id = v_approval.approval_id;
    perform public.velura_append_module_audit('products', v_actor.user_id, v_actor.admin_role::text,
      'update', new.product_id, jsonb_build_object('images', v_previous, 'version', v_expected),
      jsonb_build_object('image_approval', v_approval.approval_id, 'selection', v_approval.selection,
        'source_revision', v_approval.source_revision, 'image_revision', v_approval.image_revision,
        'processing_version', v_approval.processing_version, 'reviewer_id', v_actor.user_id,
        'product_image_revision', v_revision, 'version', new.version), v_approval.ip_address);
  end loop;
  return new;
end;
$$;
revoke all on function public.velura_consume_product_image_approvals() from public, anon, authenticated;
create trigger product_image_review_before_save before insert or update of images, image_revision on public.product
  for each row execute function public.velura_consume_product_image_approvals();

-- Untrusted uploads may not write the immutable, server-attested namespace.
drop policy if exists "Allow public uploads to product-images" on storage.objects;
create policy "Allow public uploads to product-images" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'product-images' and name not like 'ai-reviewed/%');

commit;
