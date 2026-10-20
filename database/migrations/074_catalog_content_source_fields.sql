-- Requires 055; retain its private source contract without changing live catalog content.
-- Qualify verified facts so PL/pgSQL cannot confuse the column with the local fields variable.
begin;

do $$
begin
 if to_regprocedure('public.catalog_content_source(uuid)') is null then
  raise exception '074 requires installed migration 055';
 end if;
end $$;

create or replace function public.catalog_content_source(p_product uuid) returns jsonb
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
 select facts.fields into v from public.catalog_verified_facts facts where facts.product_id=p_product;
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
revoke all on function public.catalog_content_source(uuid) from public,anon,authenticated,service_role;

commit;
