-- KAN-116: collection cover mode, separate homepage runway model, explicit combo list.
begin;
alter table public.collections
  add column if not exists hero_mode        varchar(10) not null default 'models'
    check (hero_mode in ('models','cover')),
  add column if not exists home_model_url   text,
  add column if not exists show_on_home     boolean not null default false,
  add column if not exists home_sort_order  integer not null default 0,
  add column if not exists product_ids      uuid[] not null default '{}';

-- Backfill homepage runway from HERO_LOOKS (apps/user-ng/.../home.page.ts:31): distinct cutouts, centre = the-afterglow.
update public.collections set home_model_url='/assets/images/models/model_cutout_1.png', show_on_home=true, home_sort_order=0 where code='soft-ceremony'    and home_model_url is null;
update public.collections set home_model_url='/assets/images/models/model_cutout_2.png', show_on_home=true, home_sort_order=1 where code='weekend-escape'   and home_model_url is null;
update public.collections set home_model_url='/assets/images/models/model_cutout_3.png', show_on_home=true, home_sort_order=2 where code='the-afterglow'    and home_model_url is null;
update public.collections set home_model_url='/assets/images/models/model_cutout_4.png', show_on_home=true, home_sort_order=3 where code='the-urban-rhythm' and home_model_url is null;
update public.collections set home_model_url='/assets/images/models/model_cutout_5.png', show_on_home=true, home_sort_order=4 where code='midnight-mirage'  and home_model_url is null;

-- Backfill combo list from today's implicit match (collection name + is_combo + on_sale), max 10, stable order by sku.
update public.collections c
   set product_ids = coalesce((
         select array_agg(x.product_id order by x.sku)
           from (select p.product_id, p.sku
                   from public.product p
                  where p.collection = c.name and p.is_combo = true and p.status = 'on_sale'
                  order by p.sku limit 10) x), '{}')
 where c.product_ids = '{}';
commit;
