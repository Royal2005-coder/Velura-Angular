-- KAN-106: CMS rich HTML, SEO metadata and shop-product attachments for editorial posts.
begin;

alter table public.blog
  add column if not exists content_html text not null default '',
  add column if not exists meta_title text,
  add column if not exists meta_description text,
  add column if not exists canonical_url text,
  add column if not exists og_image_url text,
  add column if not exists tags text[] not null default '{}'::text[];

create table if not exists public.blog_product (
  blog_id uuid not null references public.blog(blog_id) on delete cascade,
  product_id uuid not null references public.product(product_id) on delete cascade,
  position integer not null default 0,
  primary key(blog_id, product_id)
);
create index if not exists blog_product_position_idx on public.blog_product(blog_id, position);
alter table public.blog_product enable row level security;
revoke all on public.blog_product from public,anon,authenticated;
grant all on public.blog_product to service_role;

-- The editor needs the attached products in the list payload; the public site reads them separately.
create or replace function public.admin_list_blogs(
  p_status text default null,
  p_q text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,auth as $$
declare v_rows jsonb; v_count bigint;
begin
  if not public.velura_is_active_admin() then
    raise sqlstate 'PT403' using message='RBAC_DENIED';
  end if;
  select count(*) into v_count
  from public.blog b
  where (p_status is null or p_status='' or b.status=p_status)
    and (p_q is null or p_q='' or b.title ilike '%'||p_q||'%' or b.slug ilike '%'||p_q||'%' or b.excerpt ilike '%'||p_q||'%');
  select coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object(
      'product_ids',coalesce((select jsonb_agg(bp.product_id order by bp.position) from public.blog_product bp where bp.blog_id=b.blog_id),'[]'::jsonb),
      'products',coalesce((select jsonb_agg(jsonb_build_object('product_id',p.product_id,'name',p.name,'slug',p.slug,
        'images',p.images,'base_price',p.base_price,'sale_price',p.sale_price,'status',p.status) order by bp.position)
        from public.blog_product bp join public.product p using(product_id) where bp.blog_id=b.blog_id),'[]'::jsonb))
      order by b.updated_at desc),'[]'::jsonb) into v_rows
  from (
    select * from public.blog
    where (p_status is null or p_status='' or status=p_status)
      and (p_q is null or p_q='' or title ilike '%'||p_q||'%' or slug ilike '%'||p_q||'%' or excerpt ilike '%'||p_q||'%')
    order by updated_at desc
    limit least(greatest(coalesce(p_limit,50),1),200)
    offset greatest(coalesce(p_offset,0),0)
  ) b;
  return jsonb_build_object('rows',v_rows,'count',v_count);
end; $$;

create or replace function public.admin_upsert_blog_v2(
  p_blog_id uuid,p_category_slug text,p_slug text,p_title text,p_excerpt text,p_content text,p_content_html text,
  p_image_url text,p_author text,p_read_minutes integer,p_is_featured boolean,p_status text,
  p_meta_title text,p_meta_description text,p_canonical_url text,p_og_image_url text,p_tags text[],
  p_product_ids uuid[],p_expected_version integer,p_ip_address text default null
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_row jsonb; v_id uuid; v_tag text; v_product uuid; i integer;
begin
  if p_meta_title is not null and length(btrim(p_meta_title))>70 then raise sqlstate 'PT422' using message='BLOG_META_TITLE_TOO_LONG'; end if;
  if p_meta_description is not null and length(btrim(p_meta_description))>320 then raise sqlstate 'PT422' using message='BLOG_META_DESCRIPTION_TOO_LONG'; end if;
  if length(coalesce(p_content_html,''))>1000000 then raise sqlstate 'PT422' using message='BLOG_CONTENT_TOO_LONG'; end if;
  if p_canonical_url is not null and btrim(p_canonical_url)<>'' and p_canonical_url !~ '^https://' then
    raise sqlstate 'PT422' using message='BLOG_CANONICAL_INVALID'; end if;
  if p_og_image_url is not null and btrim(p_og_image_url)<>'' and p_og_image_url !~ '^https://' and p_og_image_url !~ '^/assets/' then
    raise sqlstate 'PT422' using message='BLOG_IMAGE_URL_INVALID'; end if;
  if coalesce(array_length(p_tags,1),0)>20 then raise sqlstate 'PT422' using message='BLOG_TAGS_TOO_MANY'; end if;
  if coalesce(array_length(p_product_ids,1),0)>30 then raise sqlstate 'PT422' using message='BLOG_PRODUCTS_TOO_MANY'; end if;
  if p_product_ids is not null and exists(
    select 1 from unnest(p_product_ids) pid where not exists(
      select 1 from public.product p where p.product_id=pid and p.status in ('on_sale','out_of_stock'))) then
    raise sqlstate 'PT422' using message='BLOG_PRODUCT_UNAVAILABLE';
  end if;

  v_row := public.admin_upsert_blog(p_blog_id,p_category_slug,p_slug,p_title,p_excerpt,p_content,p_image_url,p_author,
    p_read_minutes,p_is_featured,p_status,p_expected_version,p_ip_address);
  v_id := (v_row->>'blog_id')::uuid;

  -- A legacy caller sends p_content_html = null and must not wipe SEO/product attachments
  -- that only the rich editor manages. An empty string is a deliberate clear from the editor.
  if p_content_html is not null then
    update public.blog set content_html=coalesce(p_content_html,''),meta_title=nullif(btrim(coalesce(p_meta_title,'')),''),
      meta_description=nullif(btrim(coalesce(p_meta_description,'')),''),
      canonical_url=nullif(btrim(coalesce(p_canonical_url,'')),''),og_image_url=nullif(btrim(coalesce(p_og_image_url,'')),''),
      tags=coalesce(p_tags,'{}'::text[]) where blog_id=v_id;
    delete from public.blog_product where blog_id=v_id;
    if p_product_ids is not null then
      for i in 1..array_length(p_product_ids,1) loop
        v_product:=p_product_ids[i];
        if exists(select 1 from public.product p where p.product_id=v_product)
           and not exists(select 1 from public.blog_product bp where bp.blog_id=v_id and bp.product_id=v_product) then
          insert into public.blog_product(blog_id,product_id,position) values(v_id,v_product,i-1);
        end if;
      end loop;
    end if;
  end if;
  return (select to_jsonb(b) from public.blog b where b.blog_id=v_id)||jsonb_build_object('products',
    (select coalesce(jsonb_agg(jsonb_build_object('product_id',p.product_id,'name',p.name,'slug',p.slug,
      'images',p.images,'base_price',p.base_price,'sale_price',p.sale_price) order by bp.position),'[]'::jsonb)
     from public.blog_product bp join public.product p using(product_id) where bp.blog_id=v_id));
end; $$;
revoke all on function public.admin_upsert_blog_v2(uuid,text,text,text,text,text,text,text,text,integer,boolean,text,text,text,text,text,text[],uuid[],integer,text) from public,anon,authenticated;
grant execute on function public.admin_upsert_blog_v2(uuid,text,text,text,text,text,text,text,text,integer,boolean,text,text,text,text,text,text[],uuid[],integer,text) to authenticated,service_role;

notify pgrst,'reload schema';
commit;
