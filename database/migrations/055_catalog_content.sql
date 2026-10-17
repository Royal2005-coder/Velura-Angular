-- Verified extractive catalog drafts: generation never writes live product data.
begin;

alter table public.product add column if not exists content_title text;
alter table public.product add column if not exists short_description text;
alter table public.product add column if not exists content_highlights jsonb not null default '[]';
alter table public.product add column if not exists content_styling jsonb not null default '[]';
alter table public.product add column if not exists content_care jsonb not null default '[]';
alter table public.product add column if not exists seo_keywords jsonb not null default '{}';
alter table public.product add column if not exists image_alt jsonb not null default '[]';

create table public.catalog_verified_facts (
 product_id uuid primary key references public.product(product_id) on delete cascade,
 fields jsonb not null default '{}', verified_by uuid not null references public.users(user_id),
 version integer not null default 1, verified_at timestamptz not null default now()
);
create table public.catalog_content_batch (
 id uuid primary key default gen_random_uuid(), actor_id uuid not null references public.users(user_id),
 idempotency_key text not null, request jsonb not null, created_at timestamptz not null default now(),
 unique(actor_id,idempotency_key)
);
create table public.catalog_content_draft (
 id uuid primary key default gen_random_uuid(), product_id uuid not null references public.product(product_id),
 actor_id uuid not null references public.users(user_id), source jsonb not null, generated jsonb not null,
 reviewed jsonb, metadata jsonb not null, status text not null default 'draft' check(status in ('draft','approved','rejected','published')),
 version integer not null default 1, created_at timestamptz not null default now(), reviewed_by uuid references public.users(user_id),
 reviewed_at timestamptz, published_at timestamptz
);
create index catalog_content_product_drafts on public.catalog_content_draft(product_id,created_at desc);
create table public.catalog_content_item (
 id uuid primary key default gen_random_uuid(), batch_id uuid not null references public.catalog_content_batch(id),
 product_id uuid not null, actor_id uuid not null references public.users(user_id), source jsonb,
 status text not null default 'queued' check(status in ('queued','running','success','failed')),
 draft_id uuid references public.catalog_content_draft(id), error text, lease uuid, lease_until timestamptz,
 created_at timestamptz not null default now(), deadline timestamptz not null default now()+interval '20 minutes',
 unique(batch_id,product_id)
);
create index catalog_content_work_queue on public.catalog_content_item(created_at) where status='queued';
alter table public.catalog_verified_facts enable row level security;
alter table public.catalog_content_batch enable row level security;
alter table public.catalog_content_item enable row level security;
alter table public.catalog_content_draft enable row level security;
revoke all on public.catalog_verified_facts,public.catalog_content_batch,public.catalog_content_item,public.catalog_content_draft from public,anon,authenticated,service_role;

create function public.catalog_content_immutable() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.id is distinct from old.id or new.product_id is distinct from old.product_id or new.actor_id is distinct from old.actor_id or new.source is distinct from old.source or new.generated is distinct from old.generated or new.metadata is distinct from old.metadata or new.created_at is distinct from old.created_at then
  raise sqlstate 'PT409' using message='DRAFT_PROVENANCE_IMMUTABLE';
 end if;
 if old.status='published' then raise sqlstate 'PT409' using message='PUBLISHED_DRAFT_IMMUTABLE'; end if;
 return new;
end $$;
create trigger catalog_draft_immutable before update on public.catalog_content_draft for each row execute function public.catalog_content_immutable();

create function public.catalog_content_source(p_product uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.product%rowtype; fields jsonb; v jsonb; f record; entry record; photos jsonb; result jsonb;
begin
 select * into p from public.product where product_id=p_product;
 if not found then raise sqlstate 'PT404' using message='PRODUCT_NOT_FOUND'; end if;
 fields:=jsonb_build_object('name',p.name);
 if p.brand is not null and btrim(p.brand)<>'' then fields:=fields||jsonb_build_object('brand',p.brand); end if;
 select name into f from public.category where category_id=p.category_id;
 if f.name is not null then fields:=fields||jsonb_build_object('category',f.name); end if;
 for f in select variant_id,color,size,version from public.variant where product_id=p_product order by variant_id loop
  fields:=fields||jsonb_build_object('variants.'||f.variant_id||'.color',f.color,'variants.'||f.variant_id||'.size',f.size);
 end loop;
 for entry in select value,ordinality from unnest(coalesce(p.style_tags,'{}'::text[])) with ordinality as t(value,ordinality) loop
  fields:=fields||jsonb_build_object('tags.catalog.'||entry.ordinality,entry.value);
 end loop;
 select fields into v from public.catalog_verified_facts where product_id=p_product;
 for f in select key,value from jsonb_each(coalesce(v,'{}')) loop
  for entry in select value,ordinality from jsonb_array_elements_text(f.value) with ordinality loop
   fields:=fields||jsonb_build_object(f.key||'.'||entry.ordinality,entry.value);
  end loop;
 end loop;
 select coalesce(jsonb_agg(distinct photo),'[]') into photos from unnest(coalesce(p.images,'{}'::text[])) photo
 where photo ~ '^https://[^/[:space:]]+/[^[:space:]]+' and (photo ~* '\.(png|jpe?g|webp|avif)(\?.*)?$' or photo like '%/storage/v1/object/public/product-images/%');
 select coalesce(jsonb_agg(jsonb_build_object('id',variant_id,'color',color,'size',size,'version',version) order by variant_id),'[]') into v from public.variant where product_id=p_product;
 result:=jsonb_build_object('productId',p.product_id,'version',p.version,'fields',fields,'photos',photos);
 return result||jsonb_build_object('revision',md5(result::text||v::text));
end $$;
revoke all on function public.catalog_content_source(uuid),public.catalog_content_immutable() from public,anon,authenticated,service_role;

create function public.catalog_content_operation(p_actor uuid,p_action text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare actor public.users%rowtype; b public.catalog_content_batch%rowtype; item public.catalog_content_item%rowtype;
 d public.catalog_content_draft%rowtype; p public.product%rowtype; src jsonb; request jsonb; e jsonb; c jsonb; bid uuid;
 rows jsonb; completed integer; total integer; did uuid; err text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise sqlstate 'PT403' using message='SERVICE_ROLE_REQUIRED'; end if;
 -- Queue expiry is durable, including recovery after an API process restart.
 update public.catalog_content_item set status='failed',error='GENERATION_DEADLINE',lease=null
 where (status='queued' and deadline<now()) or (status='running' and (lease_until<now() or deadline<now()));
 if p_action='claim' then
  select * into item from public.catalog_content_item where status='queued' order by created_at,id for update skip locked limit 1;
  if not found then return null; end if;
  select * into actor from public.users where user_id=item.actor_id;
  if not coalesce(actor.is_active,false) or actor.role::text<>'admin' or actor.admin_role::text not in ('super_admin','admin_operator_sanpham') then
   update public.catalog_content_item set status='failed',error='ACTOR_PERMISSION_REVOKED' where id=item.id; return null;
  end if;
  update public.catalog_content_item set status='running',lease=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=item.id returning * into item;
  return jsonb_build_object('id',item.id,'actor_id',item.actor_id,'lease',item.lease,'source',item.source);
 end if;
 select * into actor from public.users where user_id=p_actor;
 if actor.user_id is null or not coalesce(actor.is_active,false) or actor.role::text<>'admin' or actor.admin_role::text not in ('super_admin','admin_operator_sanpham') then raise sqlstate 'PT403' using message='RBAC_DENIED'; end if;
 if p_action='enqueue' then
  request:=p_payload->'products';
  if jsonb_typeof(request)<>'array' or jsonb_array_length(request) not between 1 and 50 or coalesce(p_payload->>'idempotencyKey','') !~ '^[a-zA-Z0-9_-]{8,100}$' then raise sqlstate 'PT422' using message='BATCH_INVALID'; end if;
  -- Serialize capacity/idempotency checks across API instances, not across inference.
  perform pg_advisory_xact_lock(550055);
  select * into b from public.catalog_content_batch where actor_id=p_actor and idempotency_key=p_payload->>'idempotencyKey';
  if found then
   if b.request<>request then raise sqlstate 'PT409' using message='IDEMPOTENCY_CONFLICT'; end if;
   bid:=b.id;
  else
   if (select count(*) from public.catalog_content_item where status in ('queued','running'))+jsonb_array_length(request)>500 then raise sqlstate 'PT429' using message='QUEUE_FULL'; end if;
   insert into public.catalog_content_batch(actor_id,idempotency_key,request) values(p_actor,p_payload->>'idempotencyKey',request) returning id into bid;
   for e in select value from jsonb_array_elements(request) loop
    src:=null; err:=null;
    begin
     src:=public.catalog_content_source((e->>'productId')::uuid);
     if (src->>'version')::integer<>(e->>'expectedVersion')::integer then err:='SOURCE_VERSION_STALE'; end if;
    exception when sqlstate 'PT404' then err:='PRODUCT_NOT_FOUND'; end;
    insert into public.catalog_content_item(batch_id,product_id,actor_id,source,status,error)
    values(bid,(e->>'productId')::uuid,p_actor,src,case when err is null then 'queued' else 'failed' end,err);
   end loop;
  end if;
 elsif p_action='batch' then
  bid:=(p_payload->>'id')::uuid;
  if not exists(select 1 from public.catalog_content_batch where id=bid and actor_id=p_actor) then raise sqlstate 'PT404' using message='BATCH_NOT_FOUND'; end if;
 elsif p_action='drafts' then
  src:=public.catalog_content_source((p_payload->>'productId')::uuid);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]') into rows from (select * from public.catalog_content_draft where product_id=(p_payload->>'productId')::uuid order by created_at desc limit 50) x;
  return jsonb_build_object('drafts',rows,'source',src);
 elsif p_action='facts' then
  select * into p from public.product where product_id=(p_payload->>'productId')::uuid for update;
  if not found then raise sqlstate 'PT404' using message='PRODUCT_NOT_FOUND'; end if;
  if p.version<>(p_payload->>'expectedVersion')::integer then raise sqlstate 'PT409' using message='SOURCE_VERSION_STALE'; end if;
  insert into public.catalog_verified_facts(product_id,fields,verified_by) values(p.product_id,p_payload->'fields',p_actor)
  on conflict(product_id) do update set fields=excluded.fields,verified_by=p_actor,version=catalog_verified_facts.version+1,verified_at=now();
  update public.product set version=version+1,updated_at=now() where product_id=p.product_id;
  perform public.velura_append_module_audit('products',p_actor,actor.admin_role::text,'update',p.product_id,null,jsonb_build_object('verified_facts',p_payload->'fields'),null);
  return public.catalog_content_source(p.product_id);
 elsif p_action in ('finish','fail') then
  select * into item from public.catalog_content_item where id=(p_payload->>'id')::uuid and actor_id=p_actor for update;
  if item.id is null or item.status<>'running' or item.lease::text<>p_payload->>'lease' then raise sqlstate 'PT409' using message='LEASE_STALE'; end if;
  if p_action='fail' then
   update public.catalog_content_item set status='failed',error=left(p_payload->>'error',80),lease=null where id=item.id; return '{}';
  end if;
  src:=public.catalog_content_source(item.product_id);
  if src->>'revision'<>item.source->>'revision' then
   update public.catalog_content_item set status='failed',error='SOURCE_REVISION_STALE',lease=null where id=item.id; return '{}';
  end if;
  insert into public.catalog_content_draft(product_id,actor_id,source,generated,metadata) values(item.product_id,p_actor,item.source,p_payload->'generated',p_payload->'metadata') returning id into did;
  update public.catalog_content_item set status='success',draft_id=did,lease=null where id=item.id;
  return jsonb_build_object('draftId',did);
 elsif p_action in ('draft','review','publish') then
  select * into d from public.catalog_content_draft where id=(p_payload->>'id')::uuid for update;
  if not found then raise sqlstate 'PT404' using message='DRAFT_NOT_FOUND'; end if;
  if p_action='draft' then return to_jsonb(d); end if;
  if d.status in ('published','rejected') then raise sqlstate 'PT409' using message='DRAFT_CLOSED'; end if;
  if p_action='review' then
   if d.version<>(p_payload->>'expectedVersion')::integer then raise sqlstate 'PT409' using message='DRAFT_VERSION_STALE'; end if;
   if p_payload->>'decision' not in ('save','approve','reject') then raise sqlstate 'PT422' using message='REVIEW_INVALID'; end if;
   c:=p_payload->'content';
   if p_payload->>'decision'<>'reject' then
    src:=public.catalog_content_source(d.product_id);
    if src->>'revision'<>d.source->>'revision' then raise sqlstate 'PT409' using message='SOURCE_REVISION_STALE'; end if;
    if exists(select 1 from public.product where product_id<>d.product_id and (slug=c->>'proposedSlug' or lower(seo_title)=lower(c->'seoTitle'->>'text'))) then raise sqlstate 'PT409' using message='SEO_DUPLICATE'; end if;
   end if;
   update public.catalog_content_draft set reviewed=case when p_payload->>'decision'='reject' then reviewed else c end,
    status=case p_payload->>'decision' when 'approve' then 'approved' when 'reject' then 'rejected' else 'draft' end,
    reviewed_by=p_actor,reviewed_at=now(),version=version+1 where id=d.id returning * into d;
  else
   if d.status<>'approved' or d.reviewed is null then raise sqlstate 'PT409' using message='APPROVAL_REQUIRED'; end if;
   if d.version<>(p_payload->>'expectedDraftVersion')::integer then raise sqlstate 'PT409' using message='DRAFT_VERSION_STALE'; end if;
   select * into p from public.product where product_id=d.product_id for update;
   if p.version<>(p_payload->>'expectedVersion')::integer or p.version<>(d.source->>'version')::integer then raise sqlstate 'PT409' using message='SOURCE_VERSION_STALE'; end if;
   -- Variant/fact/category changes are detected even if their existing writer did not bump product.version.
   perform 1 from public.variant where product_id=d.product_id order by variant_id for share;
   perform 1 from public.category where category_id=p.category_id for share;
   src:=public.catalog_content_source(d.product_id);
   if src->>'revision'<>d.source->>'revision' then raise sqlstate 'PT409' using message='SOURCE_REVISION_STALE'; end if;
   c:=d.reviewed;
   perform pg_advisory_xact_lock(550056);
   if exists(select 1 from public.product where product_id<>d.product_id and (slug=c->>'proposedSlug' or lower(seo_title)=lower(c->'seoTitle'->>'text'))) then raise sqlstate 'PT409' using message='SEO_DUPLICATE'; end if;
   update public.product set content_title=c->'title'->>'text',short_description=c->'short'->>'text',description=c->'long'->>'text',
    content_highlights=c->'highlights',content_styling=c->'styling',content_care=c->'care',seo_title=c->'seoTitle'->>'text',seo_description=c->'metaDescription'->>'text',
    slug=c->>'proposedSlug',seo_keywords=jsonb_build_object('primary',c->'primaryKeywords','secondary',c->'secondaryKeywords'),image_alt=c->'alt',
    style_tags=array(select x->>'text' from jsonb_array_elements(c->'tags') x),version=version+1,updated_at=now() where product_id=d.product_id;
   update public.catalog_content_draft set status='published',published_at=now(),version=version+1 where id=d.id returning * into d;
  end if;
  perform public.velura_append_module_audit('products',p_actor,actor.admin_role::text,'update',d.product_id,null,jsonb_build_object('catalog_draft',d.id,'status',d.status),null);
  return to_jsonb(d);
 else raise sqlstate 'PT422' using message='OPERATION_INVALID';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'product_id',product_id,'status',status,'draft_id',draft_id,'error',error) order by created_at,id),'[]'),count(*) filter(where status in ('success','failed')),count(*) into rows,completed,total from public.catalog_content_item where batch_id=bid;
 return jsonb_build_object('id',bid,'items',rows,'completed',completed,'total',total,'status',case when completed=total then 'complete' when exists(select 1 from public.catalog_content_item where batch_id=bid and status='running') then 'running' else 'queued' end);
end $$;
revoke all on function public.catalog_content_operation(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.catalog_content_operation(uuid,text,jsonb) to service_role;

commit;
