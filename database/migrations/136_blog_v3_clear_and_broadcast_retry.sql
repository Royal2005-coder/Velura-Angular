-- KAN-121: Allow clearing scheduled_at / promo_id / voucher_code in admin_upsert_blog_v3
-- and decouple scheduled blog publication from transient newsletter broadcast retries
-- so live published articles are never unpublished (404) on transient email outbox errors.
begin;

-- 1. Authoritative v3 field updates (clearing promo_id, voucher_code, and scheduled_at when unscheduling)
create or replace function public.admin_upsert_blog_v3(
  p_blog_id uuid,
  p_category_slug text,
  p_slug text,
  p_title text,
  p_excerpt text,
  p_content text,
  p_content_html text,
  p_image_url text,
  p_author text,
  p_read_minutes integer,
  p_is_featured boolean,
  p_status text,
  p_meta_title text,
  p_meta_description text,
  p_canonical_url text,
  p_og_image_url text,
  p_tags text[],
  p_product_ids uuid[],
  p_expected_version integer,
  p_ip_address text default null,
  p_scheduled_at timestamptz default null,
  p_promo_id uuid default null,
  p_voucher_code text default null,
  p_social_captions jsonb default null,
  p_schedule_idempotency_key text default null,
  p_ai_workflow_metadata jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_row jsonb;
  v_id uuid;
begin
  if coalesce(nullif(btrim(coalesce(p_status, '')), ''), 'draft') = 'scheduled' and p_scheduled_at is null then
    raise sqlstate 'PT422' using message = 'BLOG_SCHEDULE_REQUIRED';
  end if;

  v_row := public.admin_upsert_blog_v2(
    p_blog_id, p_category_slug, p_slug, p_title, p_excerpt, p_content, p_content_html,
    p_image_url, p_author, p_read_minutes, p_is_featured, p_status,
    p_meta_title, p_meta_description, p_canonical_url, p_og_image_url, p_tags,
    p_product_ids, p_expected_version, p_ip_address
  );
  v_id := (v_row->>'blog_id')::uuid;

  update public.blog
  set scheduled_at = case
        when status = 'scheduled' then p_scheduled_at
        when status in ('draft', 'ai_reviewed', 'archived') then p_scheduled_at
        when p_scheduled_at is not null then p_scheduled_at
        else scheduled_at
      end,
      promo_id = p_promo_id,
      voucher_code = nullif(btrim(coalesce(p_voucher_code, '')), ''),
      social_captions = coalesce(p_social_captions, social_captions),
      schedule_idempotency_key = coalesce(nullif(btrim(coalesce(p_schedule_idempotency_key, '')), ''), schedule_idempotency_key),
      ai_workflow_metadata = coalesce(p_ai_workflow_metadata, ai_workflow_metadata),
      publish_attempts = case when status in ('scheduled', 'draft', 'ai_reviewed') then 0 else publish_attempts end,
      last_publish_error = case when status in ('scheduled', 'published', 'draft', 'ai_reviewed') then null else last_publish_error end
  where blog_id = v_id;

  return (select to_jsonb(b) from public.blog b where b.blog_id = v_id) || jsonb_build_object(
    'products',
    (select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', p.product_id, 'name', p.name, 'slug', p.slug,
      'images', p.images, 'base_price', p.base_price, 'sale_price', p.sale_price
    ) order by bp.position), '[]'::jsonb)
     from public.blog_product bp join public.product p using(product_id) where bp.blog_id = v_id)
  );
end;
$$;

revoke all on function public.admin_upsert_blog_v3(
  uuid,text,text,text,text,text,text,text,text,integer,boolean,text,text,text,text,text,text[],uuid[],integer,text,timestamptz,uuid,text,jsonb,text,jsonb
) from public, anon, authenticated;
grant execute on function public.admin_upsert_blog_v3(
  uuid,text,text,text,text,text,text,text,text,integer,boolean,text,text,text,text,text,text[],uuid[],integer,text,timestamptz,uuid,text,jsonb,text,jsonb
) to authenticated, service_role;

-- 2. Upgrade velura_publish_scheduled_blogs with optional manual force-retry flag
drop function if exists public.velura_publish_scheduled_blogs(integer);

create or replace function public.velura_publish_scheduled_blogs(
  p_limit integer default 10,
  p_force_retry boolean default false
)
returns setof public.blog
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (select 1 from pg_proc where proname = 'velura_sync_promotion_schedule') then
    perform public.velura_sync_promotion_schedule();
  end if;

  return query
  with due as (
    select b.blog_id
    from public.blog b
    where b.status in ('scheduled', 'failed_retry')
      and (p_force_retry or b.publish_attempts < 3)
      and coalesce(b.scheduled_at, now()) <= now()
    order by b.scheduled_at asc nulls first, b.updated_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update public.blog target
  set status = 'published',
      published_at = now(),
      publish_attempts = target.publish_attempts + 1,
      last_publish_error = null,
      version = target.version + 1,
      updated_at = now()
  from due
  where target.blog_id = due.blog_id
  returning target.*;
end;
$$;

revoke all on function public.velura_publish_scheduled_blogs(integer, boolean) from public, anon, authenticated;
grant execute on function public.velura_publish_scheduled_blogs(integer, boolean) to service_role;

-- 3. Dedicated retry claimer for already-published articles whose newsletter broadcast encountered a transient error
create or replace function public.velura_claim_pending_blog_broadcasts(
  p_limit integer default 10,
  p_force_retry boolean default false
)
returns setof public.blog
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  with pending as (
    select b.blog_id
    from public.blog b
    where b.status = 'published'
      and b.newsletter_broadcast_at is null
      and b.last_publish_error is not null
      and (p_force_retry or b.publish_attempts < 3)
    order by b.published_at asc, b.updated_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update public.blog target
  set publish_attempts = target.publish_attempts + 1,
      updated_at = now()
  from pending
  where target.blog_id = pending.blog_id
  returning target.*;
end;
$$;

revoke all on function public.velura_claim_pending_blog_broadcasts(integer, boolean) from public, anon, authenticated;
grant execute on function public.velura_claim_pending_blog_broadcasts(integer, boolean) to service_role;

notify pgrst, 'reload schema';
commit;
