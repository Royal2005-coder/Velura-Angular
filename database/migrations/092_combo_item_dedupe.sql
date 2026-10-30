-- KAN-106: combo editors re-inserted the same component instead of updating it, producing
-- duplicate combo_item rows and wrong component/stock lists. Keep one row per identity.
begin;

update public.combo_item keep
set quantity = (select max(quantity) from public.combo_item x
  where x.combo_product_id=keep.combo_product_id
    and x.component_product_id=keep.component_product_id
    and coalesce(x.component_variant_id,'00000000-0000-0000-0000-000000000000'::uuid)
      = coalesce(keep.component_variant_id,'00000000-0000-0000-0000-000000000000'::uuid))
where keep.combo_item_id in (
  select min(combo_item_id) from public.combo_item
  group by combo_product_id,component_product_id,coalesce(component_variant_id,'00000000-0000-0000-0000-000000000000'::uuid)
);
delete from public.combo_item x
where x.combo_item_id not in (
  select min(combo_item_id) from public.combo_item
  group by combo_product_id,component_product_id,coalesce(component_variant_id,'00000000-0000-0000-0000-000000000000'::uuid)
);
create unique index if not exists combo_item_variant_key
  on public.combo_item(combo_product_id,component_product_id,component_variant_id)
  where component_variant_id is not null;
create unique index if not exists combo_item_null_variant_key
  on public.combo_item(combo_product_id,component_product_id)
  where component_variant_id is null;

notify pgrst,'reload schema';
commit;
