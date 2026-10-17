begin;
alter table public.product add column if not exists embedding_model text,
  add column if not exists embedding_source_revision text;

-- Source revisions describe all embedding inputs; old vectors remain until an atomic replacement.
create or replace function public.visual_product_revision(p jsonb) returns text
language sql immutable set search_path=public as $$
 select md5((p - 'embedding' - 'embedding_model' - 'embedding_source_revision' - 'embedding_updated_at' - 'updated_at' - 'version')::text);
$$;
create table if not exists public.visual_catalog_state (
 id boolean primary key default true check(id), version bigint not null default 1
);
insert into public.visual_catalog_state(id) values(true) on conflict do nothing;
create table if not exists public.visual_catalog_refresh (
 product_id uuid primary key references public.product(product_id) on delete cascade,
 requested_at timestamptz not null default now(), attempts integer not null default 0,
 retry_at timestamptz not null default now(), error_code text
);
alter table public.visual_catalog_state enable row level security;
alter table public.visual_catalog_refresh enable row level security;
revoke all on public.visual_catalog_state, public.visual_catalog_refresh from public, anon, authenticated;
grant all on public.visual_catalog_state, public.visual_catalog_refresh to service_role;

create or replace function public.visual_catalog_changed() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if TG_OP='DELETE' then
  update visual_catalog_state set version=version+1 where id;
  return old;
 end if;
 if TG_OP='INSERT' or public.visual_product_revision(to_jsonb(new)) is distinct from public.visual_product_revision(to_jsonb(old)) then
  update visual_catalog_state set version=version+1 where id;
  insert into visual_catalog_refresh(product_id) values(new.product_id)
   on conflict(product_id) do update set requested_at=now(), retry_at=now(), attempts=0, error_code=null;
 elsif new.embedding_source_revision is distinct from old.embedding_source_revision or new.embedding_model is distinct from old.embedding_model then
  update visual_catalog_state set version=version+1 where id;
 end if;
 return new;
end; $$;
drop trigger if exists visual_catalog_product_changed on public.product;
create trigger visual_catalog_product_changed after insert or update or delete on public.product
for each row execute function public.visual_catalog_changed();
-- A variant edit can change colors, size, or price availability; re-embed its parent atomically.
create or replace function public.visual_variant_changed() returns trigger
language plpgsql security definer set search_path=public as $$
declare pid uuid;
begin
 pid:=case when TG_OP='DELETE' then old.product_id else new.product_id end;
 update visual_catalog_state set version=version+1 where id;
 insert into visual_catalog_refresh(product_id) select product_id from product where product_id=pid
 on conflict(product_id) do update set requested_at=now(),retry_at=now(),attempts=0,error_code=null;
 return case when TG_OP='DELETE' then old else new end;
end; $$;
drop trigger if exists visual_catalog_variant_changed on public.variant;
create trigger visual_catalog_variant_changed after insert or update or delete on public.variant
for each row execute function public.visual_variant_changed();
insert into public.visual_catalog_refresh(product_id) select product_id from public.product on conflict do nothing;

create or replace function public.visual_category_changed() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 update visual_catalog_state set version=version+1 where id;
 insert into visual_catalog_refresh(product_id)
 select product_id from product where category_id=new.category_id
 on conflict(product_id) do update set requested_at=now(),retry_at=now(),attempts=0,error_code=null;
 return new;
end; $$;
drop trigger if exists visual_catalog_category_changed on public.category;
create trigger visual_catalog_category_changed after update on public.category
for each row execute function public.visual_category_changed();

create or replace function public.visual_catalog_enqueue_model(p_model text) returns void
language sql security definer set search_path=public as $$
 insert into visual_catalog_refresh(product_id)
 select product_id from product where status::text='on_sale' and
 (embedding is null or embedding_model is distinct from p_model or embedding_source_revision is distinct from public.visual_product_revision(to_jsonb(product)))
 on conflict do nothing;
$$;
revoke all on function public.visual_category_changed(),public.visual_catalog_enqueue_model(text) from public,anon,authenticated;
grant execute on function public.visual_catalog_enqueue_model(text) to service_role;

create or replace function public.visual_search_catalog(query_embedding vector(1536), query_model text,
 match_threshold double precision default 0.45, filters jsonb default '{}') returns jsonb
language sql stable security definer set search_path=public as $$
 with eligible as (
  select p.* from product p
  where p.status::text='on_sale' and coalesce(p.is_combo,false)=false
   and (not filters ? 'product_ids' or p.product_id::text in (select jsonb_array_elements_text(filters->'product_ids')))
   and (nullif(filters->>'category_id','') is null or p.category_id::text=filters->>'category_id')
   and (not filters ? 'min_price' or coalesce(p.sale_price,p.base_price,0)>=(filters->>'min_price')::numeric)
   and (not filters ? 'max_price' or coalesce(p.sale_price,p.base_price,0)<=(filters->>'max_price')::numeric)
   and (nullif(filters->>'body_shape','') is null or exists(select 1 from unnest(p.suitable_body_shapes) s where lower(replace(s,'_',' '))=lower(replace(filters->>'body_shape','_',' '))))
   and (nullif(filters->>'color','') is null or lower(p.color_tone)=lower(filters->>'color') or exists(select 1 from variant v where v.product_id=p.product_id and lower(v.color)=lower(filters->>'color')))
   and (nullif(filters->>'size','') is null or exists(select 1 from variant v where v.product_id=p.product_id and lower(v.size::text)=lower(filters->>'size') and coalesce(v.stock_quantity,0)>coalesce(v.reserved_quantity,0)))
 ), ranked as (
  select e.*, (1-(embedding <=> query_embedding))::double precision similarity from eligible e
  where embedding is not null and embedding_model=query_model
   and embedding_source_revision=public.visual_product_revision(to_jsonb(e))
   and not exists(select 1 from visual_catalog_refresh r where r.product_id=e.product_id)
   and 1-(embedding <=> query_embedding)>=greatest(-1,least(1,match_threshold))
  order by embedding <=> query_embedding,product_id limit 200
 ), featured as (select * from eligible where is_featured order by updated_at desc,product_id limit 8)
 select jsonb_build_object('catalog_version',(select version::text from visual_catalog_state where id),
 'matches',coalesce((select jsonb_agg((to_jsonb(r)-'embedding'-'embedding_model'-'embedding_source_revision'-'embedding_updated_at')) from ranked r),'[]'::jsonb),
 'featured',coalesce((select jsonb_agg((to_jsonb(f)-'embedding'-'embedding_model'-'embedding_source_revision'-'embedding_updated_at')) from featured f),'[]'::jsonb));
$$;

create or replace function public.visual_catalog_entry(p_product_id uuid) returns jsonb
language sql stable security definer set search_path=public as $$
 select jsonb_build_object('revision',public.visual_product_revision(to_jsonb(p)),
 'product',(to_jsonb(p)-'embedding') || jsonb_build_object(
 'category',(select to_jsonb(c) from category c where c.category_id=p.category_id),
 'variants',coalesce((select jsonb_agg(to_jsonb(v)) from variant v where v.product_id=p.product_id),'[]'::jsonb)))
 from product p where p.product_id=p_product_id;
$$;
revoke all on function public.visual_catalog_entry(uuid) from public,anon,authenticated;
grant execute on function public.visual_catalog_entry(uuid) to service_role;

-- Compare-and-swap guards concurrent product/variant edits and overlapping scheduler processes.
create or replace function public.visual_catalog_commit(p_product_id uuid,p_requested_at timestamptz,
 p_revision text,p_model text,p_embedding vector(1536)) returns boolean
language plpgsql security definer set search_path=public as $$
declare changed integer;
begin
 perform 1 from product where product_id=p_product_id for update;
 perform 1 from visual_catalog_refresh where product_id=p_product_id and requested_at=p_requested_at for update;
 if not found then return false; end if;
 update product set embedding=p_embedding,embedding_model=p_model,embedding_source_revision=p_revision,embedding_updated_at=now()
 where product_id=p_product_id and public.visual_product_revision(to_jsonb(product))=p_revision;
 get diagnostics changed=row_count;
 if changed=1 then delete from visual_catalog_refresh where product_id=p_product_id and requested_at=p_requested_at; end if;
 return changed=1;
end; $$;
revoke all on function public.visual_product_revision(jsonb), public.visual_catalog_changed(), public.visual_variant_changed(),
 public.visual_search_catalog(vector,text,double precision,jsonb),public.visual_catalog_commit(uuid,timestamptz,text,text,vector) from public,anon,authenticated;
grant execute on function public.visual_product_revision(jsonb),public.visual_search_catalog(vector,text,double precision,jsonb),
 public.visual_catalog_commit(uuid,timestamptz,text,text,vector) to service_role;
commit;
