begin;

create extension if not exists vector;

alter table public.product
  add column if not exists embedding vector(1536),
  add column if not exists embedding_updated_at timestamptz;

create index if not exists idx_product_embedding_cosine
on public.product
using ivfflat (embedding vector_cosine_ops)
with (lists = 100)
where embedding is not null;

create or replace function public.match_products(
  query_embedding vector(1536),
  match_threshold double precision default 0.45,
  match_count integer default 20,
  filter_size jsonb default '{}'::jsonb
)
returns table (
  product_id uuid,
  sku text,
  is_combo boolean,
  name text,
  slug text,
  description text,
  category_id uuid,
  category_name text,
  category_slug text,
  brand text,
  base_price numeric,
  sale_price numeric,
  images text[],
  style_tags text[],
  color_tone text,
  occasions text[],
  suitable_body_shapes text[],
  status text,
  is_featured boolean,
  collection text,
  variants jsonb,
  similarity double precision
)
language sql
stable
security definer
set search_path = public
as $$
  with requested as (
    select
      lower(nullif(filter_size->>'clothing_size', '')) as clothing_size,
      lower(nullif(filter_size->>'shoe_size', '')) as shoe_size
  ),
  ranked as (
    select
      p.product_id,
      p.sku,
      p.is_combo,
      p.name,
      p.slug,
      p.description,
      p.category_id,
      c.name as category_name,
      c.slug as category_slug,
      p.brand,
      p.base_price,
      p.sale_price,
      p.images,
      p.style_tags,
      p.color_tone,
      p.occasions,
      p.suitable_body_shapes,
      p.status::text as status,
      p.is_featured,
      p.collection,
      coalesce(
        jsonb_agg(
          distinct jsonb_build_object(
            'variant_id', v.variant_id,
            'color', v.color,
            'color_hex', v.color_hex,
            'size', v.size,
            'stock_quantity', v.stock_quantity,
            'reserved_quantity', v.reserved_quantity
          )
        ) filter (where v.variant_id is not null),
        '[]'::jsonb
      ) as variants,
      (1 - (p.embedding <=> query_embedding))::double precision as similarity
    from public.product p
    left join public.category c on c.category_id = p.category_id
    left join public.variant v on v.product_id = p.product_id
    cross join requested r
    where p.status::text = 'on_sale'
      and coalesce(p.is_combo, false) = false
      and p.embedding is not null
      and (1 - (p.embedding <=> query_embedding)) >= coalesce(match_threshold, 0.45)
      and (
        (r.clothing_size is null and r.shoe_size is null)
        or (
          (coalesce(c.slug, '') ~* '(giay|giày|shoe|dep|dép|sandal|boot)'
            and r.shoe_size is not null
            and exists (
              select 1
              from public.variant vx
              where vx.product_id = p.product_id
                and lower(vx.size::text) = r.shoe_size
                and coalesce(vx.stock_quantity, 0) > coalesce(vx.reserved_quantity, 0)
            )
          )
          or
          (coalesce(c.slug, '') !~* '(giay|giày|shoe|dep|dép|sandal|boot)'
            and r.clothing_size is not null
            and exists (
              select 1
              from public.variant vx
              where vx.product_id = p.product_id
                and lower(vx.size::text) = r.clothing_size
                and coalesce(vx.stock_quantity, 0) > coalesce(vx.reserved_quantity, 0)
            )
          )
        )
      )
    group by
      p.product_id, p.sku, p.is_combo, p.name, p.slug, p.description,
      p.category_id, c.name, c.slug, p.brand, p.base_price, p.sale_price,
      p.images, p.style_tags, p.color_tone, p.occasions,
      p.suitable_body_shapes, p.status, p.is_featured, p.collection,
      p.embedding
  )
  select *
  from ranked
  order by similarity desc, is_featured desc, name asc
  limit least(greatest(coalesce(match_count, 20), 1), 50);
$$;

revoke all on function public.match_products(vector, double precision, integer, jsonb)
from public, anon, authenticated;
grant execute on function public.match_products(vector, double precision, integer, jsonb)
to service_role;

commit;
