-- Migration 134: Unified Gemini Decision Engine Audit, Visual QA Taxonomy, Return Box Forensics & AI Blog Smart Scheduler
-- Preserves public.product column footprint so migration 052 visual_product_revision embeddings are never invalidated.
begin;

-- 1. Expand public.blog status check and add Smart Scheduler + Promotion Campaign fields
do $$
declare
  r record;
begin
  for r in (
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'blog'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%status%'
  ) loop
    execute format('alter table public.blog drop constraint if exists %I', r.conname);
  end loop;
end $$;

alter table public.blog
  add constraint blog_status_check
  check (status in ('draft', 'ai_reviewed', 'scheduled', 'published', 'failed_retry', 'archived'));

alter table public.blog
  add column if not exists scheduled_at timestamptz,
  add column if not exists promo_id uuid references public.promotion(promo_id) on delete set null,
  add column if not exists voucher_code text,
  add column if not exists social_captions jsonb not null default '{}'::jsonb,
  add column if not exists publish_attempts integer not null default 0,
  add column if not exists last_publish_error text,
  add column if not exists schedule_idempotency_key text,
  add column if not exists ai_workflow_metadata jsonb not null default '{}'::jsonb;

create index if not exists idx_blog_scheduled_due
  on public.blog (status, scheduled_at asc)
  where status in ('scheduled', 'failed_retry') and publish_attempts < 3;

-- 2. Update blog transition state machine function
create or replace function public.velura_blog_transition_allowed(p_from text, p_to text)
returns boolean
language sql
stable
as $$
  select case
    when p_from = p_to then true
    when p_from = 'draft' then p_to in ('ai_reviewed', 'scheduled', 'published', 'archived')
    when p_from = 'ai_reviewed' then p_to in ('draft', 'scheduled', 'published', 'archived')
    when p_from = 'scheduled' then p_to in ('draft', 'ai_reviewed', 'published', 'failed_retry', 'archived')
    when p_from = 'failed_retry' then p_to in ('draft', 'scheduled', 'published', 'archived')
    when p_from = 'published' then p_to in ('draft', 'archived')
    when p_from = 'archived' then p_to = 'draft'
    else false
  end;
$$;

-- Update base admin_upsert_blog to recognize ai_reviewed, scheduled, failed_retry
create or replace function public.admin_upsert_blog(
  p_blog_id uuid,
  p_category_slug text,
  p_slug text,
  p_title text,
  p_excerpt text,
  p_content text,
  p_image_url text,
  p_author text,
  p_read_minutes integer,
  p_is_featured boolean,
  p_status text,
  p_expected_version integer,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor_role text;
  v_before public.blog%rowtype;
  v_after public.blog%rowtype;
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_status text := coalesce(nullif(btrim(coalesce(p_status, '')), ''), 'draft');
begin
  select u.admin_role::text into v_actor_role
  from public.users u
  where u.user_id = public.velura_current_user_id()
    and u.role::text = 'admin'
    and u.is_active;

  if v_actor_role is null or v_actor_role <> 'super_admin' then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,119}$' then
    raise sqlstate 'PT422' using message = 'BLOG_SLUG_INVALID';
  end if;
  if length(btrim(coalesce(p_title, ''))) < 4 or length(btrim(coalesce(p_title, ''))) > 180 then
    raise sqlstate 'PT422' using message = 'BLOG_TITLE_INVALID';
  end if;
  if length(btrim(coalesce(p_category_slug, ''))) = 0 then
    raise sqlstate 'PT422' using message = 'BLOG_CATEGORY_REQUIRED';
  end if;
  if not exists (select 1 from public.content_category c where c.content_type = 'blog' and c.slug = btrim(p_category_slug)) then
    raise sqlstate 'PT422' using message = 'BLOG_CATEGORY_NOT_FOUND';
  end if;
  if length(coalesce(p_excerpt, '')) > 500 then
    raise sqlstate 'PT422' using message = 'BLOG_EXCERPT_TOO_LONG';
  end if;
  if length(btrim(coalesce(p_content, ''))) < 40 then
    raise sqlstate 'PT422' using message = 'BLOG_CONTENT_TOO_SHORT';
  end if;
  if p_image_url is not null and btrim(p_image_url) <> ''
     and p_image_url !~ '^https://' and p_image_url !~ '^/assets/' then
    raise sqlstate 'PT422' using message = 'BLOG_IMAGE_URL_INVALID';
  end if;
  if coalesce(p_read_minutes, 5) not between 1 and 60 then
    raise sqlstate 'PT422' using message = 'BLOG_READ_MINUTES_INVALID';
  end if;
  if v_status not in ('draft', 'ai_reviewed', 'scheduled', 'published', 'failed_retry', 'archived') then
    raise sqlstate 'PT422' using message = 'BLOG_STATUS_INVALID';
  end if;

  if p_blog_id is null then
    if exists (select 1 from public.blog b where b.slug = v_slug) then
      raise sqlstate 'PT409' using message = 'BLOG_SLUG_TAKEN';
    end if;
    if v_status in ('archived', 'failed_retry') then
      raise sqlstate 'PT422' using message = 'BLOG_CREATE_STATUS_INVALID';
    end if;

    insert into public.blog (
      category_slug, slug, title, excerpt, content, image_url, author, read_minutes,
      is_featured, status, published_at, version, updated_by
    ) values (
      btrim(p_category_slug), v_slug, btrim(p_title), coalesce(p_excerpt, ''), p_content,
      nullif(btrim(coalesce(p_image_url, '')), ''), coalesce(nullif(btrim(coalesce(p_author, '')), ''), 'Velura Editorial'),
      coalesce(p_read_minutes, 5), coalesce(p_is_featured, false), v_status, now(), 1, public.velura_current_user_id()
    ) returning * into v_after;

    perform public.velura_append_module_audit(
      'content', public.velura_current_user_id(), v_actor_role, 'create', v_after.blog_id,
      '{}'::jsonb,
      jsonb_build_object('slug', v_after.slug, 'status', v_after.status, 'version', v_after.version),
      p_ip_address
    );
    return to_jsonb(v_after);
  end if;

  select * into v_before from public.blog where blog_id = p_blog_id for update;
  if v_before.blog_id is null then
    raise sqlstate 'PT404' using message = 'BLOG_NOT_FOUND';
  end if;
  if v_before.version <> coalesce(p_expected_version, -1) then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;
  if v_slug <> v_before.slug and exists (select 1 from public.blog b where b.slug = v_slug) then
    raise sqlstate 'PT409' using message = 'BLOG_SLUG_TAKEN';
  end if;
  if not public.velura_blog_transition_allowed(v_before.status, v_status) then
    raise sqlstate 'PT422' using message = 'BLOG_TRANSITION_DENIED';
  end if;

  update public.blog
  set category_slug = btrim(p_category_slug),
      slug = v_slug,
      title = btrim(p_title),
      excerpt = coalesce(p_excerpt, ''),
      content = p_content,
      image_url = nullif(btrim(coalesce(p_image_url, '')), ''),
      author = coalesce(nullif(btrim(coalesce(p_author, '')), ''), 'Velura Editorial'),
      read_minutes = coalesce(p_read_minutes, 5),
      is_featured = coalesce(p_is_featured, false),
      status = v_status,
      published_at = case
        when v_before.status <> 'published' and v_status = 'published' then now()
        else v_before.published_at
      end,
      version = v_before.version + 1,
      updated_by = public.velura_current_user_id(),
      updated_at = now()
  where blog_id = p_blog_id
  returning * into v_after;

  perform public.velura_append_module_audit(
    'content', public.velura_current_user_id(), v_actor_role, 'update', v_after.blog_id,
    jsonb_build_object('status', v_before.status, 'slug', v_before.slug, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'slug', v_after.slug, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- 3. Create admin_upsert_blog_v3 supporting scheduler, promo linkage, and social captions
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
        when p_scheduled_at is not null then p_scheduled_at
        else scheduled_at
      end,
      promo_id = coalesce(p_promo_id, promo_id),
      voucher_code = coalesce(nullif(btrim(coalesce(p_voucher_code, '')), ''), voucher_code),
      social_captions = coalesce(p_social_captions, social_captions),
      schedule_idempotency_key = coalesce(nullif(btrim(coalesce(p_schedule_idempotency_key, '')), ''), schedule_idempotency_key),
      ai_workflow_metadata = coalesce(p_ai_workflow_metadata, ai_workflow_metadata),
      publish_attempts = case when status = 'scheduled' then 0 else publish_attempts end,
      last_publish_error = case when status in ('scheduled', 'published', 'draft') then null else last_publish_error end
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

-- 4. Atomic Idempotent Scheduled Blog Publisher RPC (FOR UPDATE SKIP LOCKED + max 3 retries)
create or replace function public.velura_publish_scheduled_blogs(p_limit integer default 10)
returns setof public.blog
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- First synchronize promotion active window if RPC exists
  if exists (select 1 from pg_proc where proname = 'velura_sync_promotion_schedule') then
    perform public.velura_sync_promotion_schedule();
  end if;

  return query
  with due as (
    select b.blog_id
    from public.blog b
    where b.status in ('scheduled', 'failed_retry')
      and b.publish_attempts < 3
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

revoke all on function public.velura_publish_scheduled_blogs(integer) from public, anon, authenticated;
grant execute on function public.velura_publish_scheduled_blogs(integer) to service_role;

-- 5. Dedicated Product Visual QA & Auto-Blog Curation Ledger (zero mutation on public.product)
create table if not exists public.product_ai_qa (
  product_id uuid primary key references public.product(product_id) on delete cascade,
  image_url text not null default '',
  image_sha256 text not null default '',
  verdict text not null check (verdict in ('APPROVED_HERO', 'APPROVED_STANDARD', 'NEEDS_EDIT', 'REJECTED')),
  overall_score numeric(5,2) not null default 0,
  sharpness_focus numeric(4,2) not null default 0,
  lighting_exposure numeric(4,2) not null default 0,
  composition_framing numeric(4,2) not null default 0,
  background_cleanliness numeric(4,2) not null default 0,
  defect_tags text[] not null default '{}'::text[],
  actionable_fix text[] not null default '{}'::text[],
  blog_auto_eligible boolean not null default false,
  publish_mode text not null default 'SEMI_AUTO_REVIEW' check (publish_mode in ('AUTO_BLOG_PUBLISH', 'SEMI_AUTO_REVIEW', 'EXCLUDE')),
  campaign_fit text not null default 'HERO_PRODUCT' check (campaign_fit in ('HERO_PRODUCT', 'BUNDLE_ADDON', 'CLEARANCE')),
  decision_confidence numeric(5,4) not null default 0,
  requires_human_review boolean not null default false,
  evaluated_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_product_ai_qa_blog_eligible
  on public.product_ai_qa (blog_auto_eligible, publish_mode, overall_score desc);

alter table public.product_ai_qa enable row level security;
revoke all on public.product_ai_qa from public, anon, authenticated;
grant all on public.product_ai_qa to service_role;

-- 6. Return Box Visual Forensics & Carrier Dispute Verification Table
create table if not exists public.return_box_forensics (
  forensics_id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.return_exchange(return_id) on delete cascade,
  return_item_id uuid references public.return_item(return_item_id) on delete set null,
  pickup_evidence_ref text,
  warehouse_evidence_ref text,
  box_condition text not null check (box_condition in ('INTACT', 'MINOR_DENT', 'SEVERE_CRUSH', 'TORN_WET')),
  carrier_claim_recommended boolean not null default false,
  match_verdict text not null check (match_verdict in ('MATCHED', 'SUSPICIOUS_DIFF', 'MISMATCHED')),
  tampering_risk_score numeric(5,2) not null default 0 check (tampering_risk_score between 0 and 100),
  confidence_score numeric(5,4) not null default 0,
  requires_human_review boolean not null default false,
  freeze_auto_refund boolean not null default false,
  diff_factors text[] not null default '{}'::text[],
  factor_probabilities jsonb not null default '{}'::jsonb,
  carrier_claim_report jsonb,
  reviewed_by uuid references public.users(user_id) on delete set null,
  human_override_verdict text,
  created_at timestamptz not null default now()
);

create index if not exists idx_return_box_forensics_return
  on public.return_box_forensics (return_id, created_at desc);

alter table public.return_box_forensics enable row level security;
revoke all on public.return_box_forensics from public, anon, authenticated;
grant all on public.return_box_forensics to service_role;

-- 7. Unified Gemini Decision Engine Telemetry & Shadow/Canary Audit Log
create table if not exists public.ai_decision_log (
  decision_id uuid primary key default gen_random_uuid(),
  use_case text not null check (use_case in (
    'personal_color',
    'cskh_sentiment',
    'product_image_qa',
    'return_box_qa',
    'blog_product_curation',
    'blog_editorial_gate'
  )),
  entity_type text,
  entity_id text,
  rollout_mode text not null default 'active' check (rollout_mode in ('shadow', 'canary', 'active')),
  model_used text not null,
  transport text not null check (transport in ('decisions_api', 'fallback_decisions_api', 'structured_json_fallback', 'deterministic_fallback')),
  used_fallback_key boolean not null default false,
  latency_ms integer not null default 0,
  input_tokens integer not null default 0,
  confidence_score numeric(5,4) not null default 0,
  requires_human_review boolean not null default false,
  verdict_code text not null,
  raw_answers jsonb not null default '{}'::jsonb,
  downstream_action text,
  human_override jsonb,
  actor_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_decision_log_use_case_created
  on public.ai_decision_log (use_case, created_at desc);

alter table public.ai_decision_log enable row level security;
revoke all on public.ai_decision_log from public, anon, authenticated;
grant all on public.ai_decision_log to service_role;

notify pgrst, 'reload schema';
commit;
