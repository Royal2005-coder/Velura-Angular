-- KAN-109: phiên VNPay/MoMo đang mở cũng phải chặn "đổi sang COD", giống Stripe.
--
-- Vì sao: 041 chặn chuyển COD khi còn phiên Stripe pending (<31 phút) để tránh một đơn vừa thu COD
-- vừa bị cổng capture. Màn QR mới của storefront đặt đúng nút "Đổi sang COD" cạnh mã VNPay/MoMo, mà
-- hai nhà mạng này không nằm trong guard đó → khách đổi COD lúc QR còn hiệu lực tạo lại đúng tình
-- huống guard sinh ra để chặn. reconcile sẽ bắt được muộn (late success -> refund_pending), nhưng
-- chặn trước mới là thiết kế, vì guard preventive đã tồn tại.
--
-- Phiên local có hạn tường minh (gateway_expires_at, 048/112) nên dùng cột đó — chính xác hơn
-- heuristic 31 phút mà Stripe buộc phải dùng.
begin;

create or replace function public.velura_switch_order_to_cod(p_order_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_order public.orders%rowtype; v_item record;
begin
  select * into v_order from public.orders where order_id = p_order_id for update;
  if not found then raise sqlstate 'PT404' using message = 'ORDER_NOT_FOUND'; end if;
  if v_order.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_order.status::text <> 'waiting_payment' or v_order.payment_method::text <> 'ONLINE_PAYMENT' then
    raise sqlstate 'PT422' using message = 'INVALID_ORDER_ACTION';
  end if;
  if exists(select 1 from public.payment where order_id = p_order_id and payment_status::text in ('paid', 'refund_pending', 'refunded')) then
    raise sqlstate 'PT422' using message = 'PAYMENT_ALREADY_PAID';
  end if;
  if exists(select 1 from public.payment where order_id = p_order_id and payment_status::text = 'pending'
    and ((payment_provider = 'stripe' and created_at > now() - interval '31 minutes')
      or (payment_provider in ('vnpay', 'momo')
          and coalesce(gateway_expires_at, created_at + interval '31 minutes') > now()))) then
    raise sqlstate 'PT409' using message = 'PAYMENT_SESSION_OPEN';
  end if;
  for v_item in select oi.variant_id, sum(oi.quantity)::integer as quantity from public.order_item oi
    where oi.order_id = p_order_id group by oi.variant_id order by oi.variant_id loop
    perform 1 from public.variant where variant_id = v_item.variant_id for update;
    if exists(select 1 from public.variant where variant_id = v_item.variant_id and stock_quantity < v_item.quantity) then
      raise sqlstate 'PT409' using message = 'INSUFFICIENT_STOCK';
    end if;
    update public.variant set stock_quantity = stock_quantity - v_item.quantity,
      reserved_quantity = greatest(0, reserved_quantity - case when v_order.stock_reserved_at is not null then v_item.quantity else 0 end),
      version = version + 1, updated_at = now() where variant_id = v_item.variant_id;
  end loop;
  update public.orders set status = 'pending', payment_method = 'COD', stock_committed_at = now(),
    stock_reservation_released_at = now(), version = version + 1, updated_at = now()
    where order_id = p_order_id returning * into v_order;
  update public.payment set payment_status = 'failed', gateway_response_code = 'SWITCHED_TO_COD',
    version = version + 1, updated_at = now() where order_id = p_order_id and payment_status::text = 'pending';
  insert into public.order_status_history(order_id, old_status, new_status, trigger_type, changed_by, changed_at, note)
    values(p_order_id, 'waiting_payment', 'pending', 'system', v_order.user_id, now(), 'Customer switched unpaid order to COD');
  return to_jsonb(v_order);
end; $$;

revoke all on function public.velura_switch_order_to_cod(uuid, integer) from anon, authenticated;
grant execute on function public.velura_switch_order_to_cod(uuid, integer) to service_role;

comment on function public.velura_switch_order_to_cod(uuid, integer) is
 'Đổi đơn online chưa thu tiền sang COD; mọi phiên cổng đang mở (stripe, vnpay, momo) đều phải kết thúc trước.';

notify pgrst, 'reload schema';
commit;
