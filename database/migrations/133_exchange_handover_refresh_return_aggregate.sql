-- KAN-116: exchange order handover in Orders must also refresh `return_exchange` aggregate status
-- (`EXCHANGE_PREPARING` -> `EXCHANGE_SHIPPING` / `IN_PROGRESS`) and record the final outbound AWB
-- after `089` (`velura_ensure_outbound_tracking`) runs.
begin;

create or replace function public.velura_sync_exchange_handover()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_item public.return_item%rowtype;
  v_tracking text;
begin
  if coalesce(new.order_kind::text, 'sale') <> 'exchange'
     or new.handed_over_at is null or old.handed_over_at is not null
     or nullif(btrim(coalesce(new.tracking_code, '')), '') is null then
    return new;
  end if;

  select * into v_item from public.return_item
   where exchange_order_id = new.order_id and item_status::text = 'EXCHANGE_PREPARING'
   for update;
  if not found then return new; end if;

  update public.return_item
     set item_status = 'EXCHANGE_SHIPPING', version = version + 1, updated_at = now()
   where return_item_id = v_item.return_item_id;

  insert into public.return_shipment(return_id, return_item_id, direction, order_id, carrier, tracking_code, status, picked_up_at)
  values (v_item.return_id, v_item.return_item_id, 'outbound', new.order_id,
          coalesce(new.carrier, ''), new.tracking_code, 'picked_up', now())
  returning tracking_code into v_tracking;

  insert into public.return_event(return_id, return_item_id, old_status, new_status, actor_type, event_type, payload, note)
  values (v_item.return_id, v_item.return_item_id, 'EXCHANGE_PREPARING', 'EXCHANGE_SHIPPING', 'admin', 'item_action',
          jsonb_build_object('action', 'ship_exchange', 'via', 'orders_module', 'trackingNumber', coalesce(v_tracking, new.tracking_code)),
          'Giao đơn đổi từ module Đơn hàng');

  perform public.velura_refresh_return_aggregate(v_item.return_id);
  return new;
end $$;

do $$
declare
  rec record;
begin
  for rec in
    select distinct r.return_id
      from public.return_exchange r
      join public.return_item i on i.return_id = r.return_id
     where i.item_status = 'EXCHANGE_SHIPPING' and r.status::text = 'EXCHANGE_PREPARING'
  loop
    perform public.velura_refresh_return_aggregate(rec.return_id);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
