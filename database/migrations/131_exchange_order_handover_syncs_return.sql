-- KAN-114: an exchange order is shipped from the Orders module (print label, stick, scan, hand over).
-- Handing it over must advance the linked return part, otherwise the return stays EXCHANGE_PREPARING
-- and ERP asks for a second, manual tracking entry.
begin;

create or replace function public.velura_sync_exchange_handover()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_item public.return_item%rowtype;
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
          coalesce(new.carrier, ''), new.tracking_code, 'picked_up', now());

  insert into public.return_event(return_id, return_item_id, old_status, new_status, actor_type, event_type, payload, note)
  values (v_item.return_id, v_item.return_item_id, 'EXCHANGE_PREPARING', 'EXCHANGE_SHIPPING', 'admin', 'item_action',
          jsonb_build_object('action', 'ship_exchange', 'via', 'orders_module', 'trackingNumber', new.tracking_code),
          'Giao đơn đổi từ module Đơn hàng');
  return new;
end $$;

drop trigger if exists trg_exchange_handover_syncs_return on public.orders;
create trigger trg_exchange_handover_syncs_return
after update of handed_over_at on public.orders
for each row execute function public.velura_sync_exchange_handover();

notify pgrst, 'reload schema';
commit;
