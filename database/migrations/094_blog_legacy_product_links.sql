-- KAN-106: legacy editorial JSON already names the shop SKUs used by each section.
-- Backfill blog_product for published posts that have no attachment yet, so the storefront
-- article shows the same product cards the original editorial design specified.
begin;

create or replace function public.velura_blog_legacy_skus(p_content text)
returns text[] language plpgsql immutable set search_path=pg_catalog as $$
declare v jsonb; v_sections jsonb; v_skus text[]:='{}';
begin
  if left(btrim(coalesce(p_content,'')),1)<>'{' then return v_skus; end if;
  begin v:=p_content::jsonb; exception when others then return v_skus; end;
  v_sections:=case when jsonb_typeof(v->'sections')='array' then v->'sections' else '[]'::jsonb end;
  select coalesce(array_agg(distinct btrim(sku) order by btrim(sku)),'{}'::text[]) into v_skus
  from jsonb_array_elements(v_sections) s
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(s->'productSkus')='array' then s->'productSkus' else '[]'::jsonb end) sku
  where btrim(sku)<>'';
  return v_skus;
end; $$;
revoke all on function public.velura_blog_legacy_skus(text) from public,anon,authenticated;

with legacy as (
  select b.blog_id,u.sku,u.ord
  from public.blog b
  cross join lateral unnest(public.velura_blog_legacy_skus(b.content)) with ordinality u(sku,ord)
  where b.status='published'
    and not exists(select 1 from public.blog_product bp where bp.blog_id=b.blog_id)
), matched as (
  select l.blog_id,p.product_id,min(l.ord) as ord
  from legacy l
  join public.product p on upper(p.sku)=upper(l.sku) and p.status in ('on_sale','out_of_stock')
  group by l.blog_id,p.product_id
)
insert into public.blog_product(blog_id,product_id,position)
select blog_id,product_id,(row_number() over(partition by blog_id order by ord,product_id)-1)::integer
from matched
on conflict (blog_id,product_id) do nothing;

notify pgrst,'reload schema';
commit;
