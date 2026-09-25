-- Migration: Action đơn hàng theo Order State Machine KAN-59/KAN-60
-- Target tables: public.orders, public.order_event, public.order_status_history,
--                public.payment, public.variant
--
-- Trước đây admin chỉ có một dropdown chọn trạng thái kế tiếp. KAN-60 thay bằng 11
-- action thủ công có tên, mỗi action có điều kiện và ghi vết riêng, cộng các action của
-- System (thanh toán, hết hạn, tự xác nhận COD, kết quả giao hàng). Tất cả đi qua một
-- hàm lõi `velura_order_apply_action`, để quy tắc chỉ nằm một chỗ trong cơ sở dữ liệu.
--
-- `velura_order_action_rules()` là bản JSON của `ORDER_ACTIONS` trong
-- apps/api/src/orders/order-state-machine.ts. tests/api/order-state-machine.test.ts đọc
-- tệp này và so khớp hai bản, nên sửa một bên mà quên bên kia thì CI đỏ.
--
-- Chạy sau 037, cùng lần phát hành.

-- ---------------------------------------------------------------------------
-- 1. Bảng quy tắc
-- ---------------------------------------------------------------------------
create or replace function public.velura_order_action_rules()
returns jsonb language sql immutable set search_path = pg_catalog, public
as $rules$
select '[
  {"code":"call_confirm","actor":"order_admin","from":["pending"],"to":null,"requiresNote":true},
  {"code":"confirm_cod","actor":"order_admin","from":["pending"],"to":"confirmed","requiresNote":true},
  {"code":"start_processing","actor":"order_admin","from":["confirmed"],"to":"processing","requiresNote":true},
  {"code":"record_shortage","actor":"order_admin","from":["processing"],"to":null,"requiresNote":true},
  {"code":"upsert_shipment","actor":"order_admin","from":["processing"],"to":null,"requiresNote":true},
  {"code":"confirm_handover","actor":"order_admin","from":["processing"],"to":"shipping","requiresNote":true},
  {"code":"carrier_note","actor":"order_admin","from":["shipping"],"to":null,"requiresNote":true},
  {"code":"update_tracking","actor":"order_admin","from":["shipping"],"to":null,"requiresNote":true},
  {"code":"record_failure_reason","actor":"order_admin","from":["delivery_failed"],"to":null,"requiresNote":true},
  {"code":"confirm_return_to_stock","actor":"order_admin","from":["delivery_failed"],"to":null,"requiresNote":true},
  {"code":"retry_refund","actor":"order_admin","from":["cancelled"],"to":null,"requiresNote":true},
  {"code":"cancel","actor":"order_admin","from":["pending","waiting_payment","confirmed","processing"],"to":"cancelled","requiresNote":true},
  {"code":"customer_cancel","actor":"customer","from":["pending","waiting_payment","confirmed"],"to":"cancelled","requiresNote":false},
  {"code":"to_waiting_payment","actor":"system","from":["pending"],"to":"waiting_payment","requiresNote":false},
  {"code":"payment_succeeded","actor":"system","from":["waiting_payment"],"to":"confirmed","requiresNote":false},
  {"code":"payment_expired","actor":"system","from":["waiting_payment"],"to":"cancelled","requiresNote":false},
  {"code":"auto_confirm_cod","actor":"system","from":["pending"],"to":"confirmed","requiresNote":false},
  {"code":"carrier_delivered","actor":"system","from":["shipping"],"to":"delivered","requiresNote":false},
  {"code":"carrier_failed_returned","actor":"system","from":["shipping"],"to":"delivery_failed","requiresNote":false},
  {"code":"carrier_failed_retrying","actor":"system","from":["shipping"],"to":null,"requiresNote":false}
]'::jsonb
$rules$;

revoke all on function public.velura_order_action_rules() from public, anon;
grant execute on function public.velura_order_action_rules() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Tag cần chú ý
-- ---------------------------------------------------------------------------
-- Tính tại chỗ, không lưu, để không có cột nào có thể lệch với dữ liệu gốc. Đặt trong
-- view chứ không trong API vì bộ lọc "Cần xử lý" và số đếm phải chạy ở phía cơ sở dữ
-- liệu mới phân trang đúng. `security_invoker` để RLS của `orders` vẫn có hiệu lực.
create or replace view public.admin_order_tags
with (security_invoker = true) as
select
  o.order_id,
  array_remove(array[
    case when o.status::text = 'pending' and o.payment_method::text = 'COD' and o.total_amount >= 1000000
              and o.created_at > (now() at time zone 'utc') - interval '24 hours' then 'PRIORITY_REVIEW' end,
    case when o.status::text = 'pending' and o.payment_method::text = 'COD' and o.total_amount >= 1000000
              and o.created_at <= (now() at time zone 'utc') - interval '24 hours' then 'REVIEW_OVERDUE' end,
    case when o.status::text = 'waiting_payment'
              and o.created_at <= (now() at time zone 'utc') - interval '24 hours' then 'PAYMENT_OVERDUE' end,
    case when p.payment_status::text in ('failed', 'discrepancy') and o.status::text not in ('waiting_payment', 'cancelled')
              or coalesce(p.has_discrepancy, false)
              -- Phiên Stripe sống 31 phút; còn `pending` quá 1 giờ là cổng không gọi lại được.
              or (p.payment_status::text = 'pending' and p.payment_provider::text = 'stripe'
                  and p.created_at <= (now() at time zone 'utc') - interval '1 hour') then 'PAYMENT_ATTENTION' end,
    case when p.payment_status::text = 'refund_pending' and coalesce(p.gateway_response_code, '') <> 'REFUND_FAILED' then 'REFUND_PENDING' end,
    case when p.payment_status::text = 'refund_pending' and p.gateway_response_code = 'REFUND_FAILED' then 'REFUND_FAILED' end,
    case when o.status::text = 'delivery_failed' and o.returned_to_stock_at is null then 'RETURN_TO_STOCK_PENDING' end
  ], null) as tags
from public.orders o
left join lateral (
  select pp.payment_status, pp.gateway_response_code, pp.has_discrepancy, pp.payment_provider, pp.created_at
  from public.payment pp where pp.order_id = o.order_id
  order by pp.created_at desc limit 1
) p on true;

revoke all on public.admin_order_tags from anon;
grant select on public.admin_order_tags to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Hàm lõi
-- ---------------------------------------------------------------------------
-- Không cấp cho ai: chỉ gọi qua `admin_order_action` (kiểm vai trò) và
-- `velura_order_service_action` (service_role, cho System và khách).
create or replace function public.velura_order_apply_action(
  p_order_id uuid,
  p_action text,
  p_actor_type text,
  p_actor_id uuid,
  p_actor_role text,
  p_note text,
  p_payload jsonb,
  p_expected_version integer,
  p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_rule jsonb;
  v_before public.orders%rowtype;
  v_after public.orders%rowtype;
  v_payment public.payment%rowtype;
  v_to text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_item record;
  v_refund_required boolean := false;
  v_restock boolean := false;
  v_event_id uuid;
begin
  select r into v_rule from jsonb_array_elements(public.velura_order_action_rules()) r
  where r->>'code' = p_action;
  if v_rule is null then raise sqlstate 'PT422' using message = 'UNKNOWN_ORDER_ACTION'; end if;
  if (v_rule->>'actor' = 'order_admin' and p_actor_type <> 'manual')
     or (v_rule->>'actor' <> 'order_admin' and p_actor_type = 'manual') then
    raise sqlstate 'PT403' using message = 'ACTION_NOT_ALLOWED_FOR_ACTOR';
  end if;
  if (v_rule->>'requiresNote')::boolean and (v_note is null or length(v_note) < 5) then
    raise sqlstate 'PT422' using message = 'NOTE_REQUIRED';
  end if;

  -- AC-19: kiểm theo trạng thái mới nhất trong cơ sở dữ liệu, không theo màn hình.
  select * into v_before from public.orders where order_id = p_order_id for update;
  if v_before.order_id is null then raise sqlstate 'PT404' using message = 'ORDER_NOT_FOUND'; end if;
  if p_expected_version is not null and v_before.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;
  if not (v_rule->'from') ? v_before.status::text then
    raise sqlstate 'PT422' using message = 'INVALID_ORDER_ACTION';
  end if;

  select * into v_payment from public.payment
  where order_id = p_order_id order by created_at desc limit 1 for update;

  -- Guard, cùng mã lỗi với `actionGuard` phía API.
  if p_action in ('confirm_cod', 'auto_confirm_cod') and v_before.payment_method::text <> 'COD' then
    raise sqlstate 'PT422' using message = 'COD_ONLY';
  end if;
  if p_action = 'auto_confirm_cod' and (
       v_before.total_amount >= 1000000
       or v_before.created_at > (now() at time zone 'utc') - interval '24 hours') then
    raise sqlstate 'PT422' using message = 'AUTO_CONFIRM_NOT_DUE';
  end if;
  if p_action in ('to_waiting_payment', 'payment_succeeded', 'payment_expired')
     and v_before.payment_method::text <> 'ONLINE_PAYMENT' then
    raise sqlstate 'PT422' using message = 'ONLINE_ONLY';
  end if;
  if p_action = 'payment_expired' and v_before.created_at > (now() at time zone 'utc') - interval '24 hours' then
    raise sqlstate 'PT422' using message = 'PAYMENT_NOT_EXPIRED';
  end if;
  if p_action = 'payment_expired' and exists (
    select 1 from public.payment p where p.order_id = p_order_id and p.payment_status::text = 'paid'
  ) then
    raise sqlstate 'PT422' using message = 'PAYMENT_ALREADY_PAID';
  end if;
  if p_action = 'confirm_handover' then
    if nullif(btrim(coalesce(v_before.tracking_code, '')), '') is null then
      raise sqlstate 'PT422' using message = 'TRACKING_CODE_REQUIRED';
    end if;
    if v_before.shipment_voided_at is not null then raise sqlstate 'PT422' using message = 'SHIPMENT_VOIDED'; end if;
  end if;
  if p_action in ('cancel', 'customer_cancel') and v_before.handed_over_at is not null then
    raise sqlstate 'PT422' using message = 'ORDER_ALREADY_HANDED_OVER';
  end if;
  if p_action = 'confirm_return_to_stock' and v_before.returned_to_stock_at is not null then
    raise sqlstate 'PT422' using message = 'ALREADY_RETURNED_TO_STOCK';
  end if;
  if p_action = 'retry_refund' and not (
       v_payment.payment_status::text = 'refund_pending' and v_payment.gateway_response_code = 'REFUND_FAILED') then
    raise sqlstate 'PT422' using message = 'REFUND_NOT_RETRYABLE';
  end if;
  if p_action = 'call_confirm'
     and coalesce(v_payload->>'call_result', '') not in ('reached', 'no_answer', 'customer_requests_cancel') then
    raise sqlstate 'PT422' using message = 'CALL_RESULT_REQUIRED';
  end if;
  if p_action = 'record_shortage' and nullif(btrim(coalesce(v_payload->>'shortage', '')), '') is null then
    raise sqlstate 'PT422' using message = 'SHORTAGE_REQUIRED';
  end if;
  if p_action in ('upsert_shipment', 'update_tracking')
     and nullif(btrim(coalesce(v_payload->>'tracking_code', '')), '') is null then
    raise sqlstate 'PT422' using message = 'TRACKING_CODE_REQUIRED';
  end if;
  if p_action = 'cancel' and nullif(btrim(coalesce(v_payload->>'cancel_reason', '')), '') is null then
    raise sqlstate 'PT422' using message = 'CANCEL_REASON_REQUIRED';
  end if;

  v_to := coalesce(v_rule->>'to', v_before.status::text);

  -- Trả kho: huỷ đơn và xác nhận hoàn kho. Chỉ khi kho đã trừ và chưa trả.
  v_restock := p_action in ('cancel', 'customer_cancel', 'payment_expired', 'confirm_return_to_stock')
               and v_before.stock_committed_at is not null and v_before.stock_returned_at is null;
  if v_restock then
    perform 1 from public.variant v
    where v.variant_id in (select oi.variant_id from public.order_item oi where oi.order_id = p_order_id)
    order by v.variant_id for update;
    for v_item in
      select oi.variant_id, sum(oi.quantity)::integer as quantity
      from public.order_item oi where oi.order_id = p_order_id group by oi.variant_id
    loop
      update public.variant
      set stock_quantity = stock_quantity + v_item.quantity,
          reserved_quantity = greatest(reserved_quantity - v_item.quantity, 0),
          version = version + 1, updated_at = now()
      where variant_id = v_item.variant_id;
    end loop;
  end if;

  -- Trừ kho khi tiền về, trong cùng giao dịch. Trước đây API trừ từng dòng một sau khi
  -- đổi payment, không khoá dòng biến thể.
  if p_action = 'payment_succeeded' and v_before.stock_committed_at is null then
    perform 1 from public.variant v
    where v.variant_id in (select oi.variant_id from public.order_item oi where oi.order_id = p_order_id)
    order by v.variant_id for update;
    for v_item in
      select oi.variant_id, sum(oi.quantity)::integer as quantity
      from public.order_item oi where oi.order_id = p_order_id group by oi.variant_id
    loop
      update public.variant
      set stock_quantity = greatest(stock_quantity - v_item.quantity, 0),
          version = version + 1, updated_at = now()
      where variant_id = v_item.variant_id;
    end loop;
  end if;

  update public.orders set
    status = v_to::public.order_status,
    cancelled_reason = case when v_to = 'cancelled'
      then coalesce(nullif(btrim(coalesce(v_payload->>'cancel_reason', '')), ''), v_note,
                    case when p_action = 'payment_expired' then 'Hết hạn thanh toán sau 24 giờ' end,
                    cancelled_reason)
      else cancelled_reason end,
    stock_committed_at = case when p_action = 'payment_succeeded' then coalesce(stock_committed_at, now()) else stock_committed_at end,
    stock_returned_at = case when v_restock then now() else stock_returned_at end,
    returned_to_stock_at = case when p_action = 'confirm_return_to_stock' then now() else returned_to_stock_at end,
    tracking_code = case when p_action in ('upsert_shipment', 'update_tracking') then btrim(v_payload->>'tracking_code') else tracking_code end,
    carrier = case when p_action in ('upsert_shipment', 'update_tracking') and nullif(btrim(coalesce(v_payload->>'carrier', '')), '') is not null
                   then btrim(v_payload->>'carrier') else carrier end,
    tracking_url = case when p_action in ('upsert_shipment', 'update_tracking')
                        then nullif(btrim(coalesce(v_payload->>'tracking_url', '')), '') else tracking_url end,
    shipment_created_at = case when p_action = 'upsert_shipment' then coalesce(shipment_created_at, now()) else shipment_created_at end,
    shipment_voided_at = case
      when p_action = 'upsert_shipment' then null
      when v_to = 'cancelled' and shipment_created_at is not null and handed_over_at is null then now()
      else shipment_voided_at end,
    handed_over_at = case when p_action = 'confirm_handover' then now() else handed_over_at end,
    delivered_at = case when p_action = 'carrier_delivered' then now() else delivered_at end,
    version = version + 1,
    updated_at = now()
  where order_id = p_order_id
  returning * into v_after;

  -- Huỷ đơn đã trả tiền: payment chờ hoàn, API gọi Stripe sau khi giao dịch chốt.
  if v_to = 'cancelled' and v_payment.payment_status::text = 'paid' then
    update public.payment
    set payment_status = 'refund_pending', refund_amount = amount,
        refund_reason = coalesce(v_after.cancelled_reason, v_note),
        gateway_response_code = 'REFUND_REQUESTED',
        version = version + 1, updated_at = now()
    where payment_id = v_payment.payment_id;
    v_refund_required := v_payment.payment_provider = 'stripe';
  end if;
  if p_action = 'retry_refund' then
    update public.payment
    set gateway_response_code = 'REFUND_REQUESTED', version = version + 1, updated_at = now()
    where payment_id = v_payment.payment_id;
    v_refund_required := true;
  end if;

  insert into public.order_event (
    order_id, action, actor_type, actor_id, actor_role, from_status, to_status, result, note, payload
  ) values (
    p_order_id, p_action,
    case when p_actor_type = 'manual' then 'manual'::public.trigger_type else 'system'::public.trigger_type end,
    p_actor_id, p_actor_role, v_before.status, v_after.status, 'success', v_note,
    v_payload || jsonb_build_object('actor', p_actor_type)
  ) returning event_id into v_event_id;
  update public.order_event set created_at = clock_timestamp() where event_id = v_event_id;

  if v_after.status <> v_before.status then
    insert into public.order_status_history (
      history_id, order_id, old_status, new_status, trigger_type, changed_by, changed_at, note
    ) values (
      gen_random_uuid(), p_order_id, v_before.status, v_after.status,
      case when p_actor_type = 'manual' then 'manual'::public.trigger_type else 'system'::public.trigger_type end,
      -- clock_timestamp: nhiều action trong cùng một giao dịch vẫn giữ đúng thứ tự.
      p_actor_id, clock_timestamp() at time zone 'utc',
      coalesce(v_note, v_rule->>'code')
    );
  end if;

  if p_actor_type = 'manual' then
    perform public.velura_append_module_audit(
      'orders', p_actor_id, p_actor_role, 'update', p_order_id,
      jsonb_build_object('action', p_action, 'status', v_before.status, 'version', v_before.version),
      jsonb_build_object('action', p_action, 'status', v_after.status, 'version', v_after.version, 'note', v_note),
      p_ip_address
    );
  end if;

  if v_after.status <> v_before.status then
    perform public.velura_enqueue_order_email(
      (select email from public.users where user_id = v_after.user_id),
      case when v_after.status::text = 'cancelled' then 'order_cancelled' else 'order_status_changed' end,
      'Cap nhat don hang',
      format('Don hang %s da chuyen sang trang thai %s.', p_order_id, v_after.status::text),
      v_after.user_id,
      jsonb_build_object('order_id', p_order_id, 'status', v_after.status::text)
    );
  end if;

  return jsonb_build_object(
    'order', to_jsonb(v_after),
    'event_id', v_event_id,
    'refund_required', v_refund_required,
    'payment_id', v_payment.payment_id
  );
end; $$;

revoke all on function public.velura_order_apply_action(uuid, text, text, uuid, text, text, jsonb, integer, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Cửa cho admin
-- ---------------------------------------------------------------------------
create or replace function public.admin_order_action(
  p_order_id uuid,
  p_action text,
  p_note text,
  p_payload jsonb,
  p_expected_version integer,
  p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  -- CSKH đọc được đơn nhưng không thực hiện action xử lý (KAN-60 mục 1).
  if not public.velura_is_order_operator() then raise sqlstate 'PT403' using message = 'RBAC_DENIED'; end if;
  if p_expected_version is null then raise sqlstate 'PT422' using message = 'EXPECTED_VERSION_REQUIRED'; end if;
  return public.velura_order_apply_action(
    p_order_id, p_action, 'manual', v_actor.user_id, v_actor.admin_role::text,
    p_note, p_payload, p_expected_version, p_ip_address
  );
end; $$;

revoke all on function public.admin_order_action(uuid, text, text, jsonb, integer, text) from public, anon;
grant execute on function public.admin_order_action(uuid, text, text, jsonb, integer, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Cửa cho System và khách (chỉ service_role)
-- ---------------------------------------------------------------------------
-- API đã kiểm khách là chủ đơn trước khi gọi `customer_cancel`. `p_actor_id` là người
-- dùng đó, để nhật ký ghi đúng ai huỷ.
create or replace function public.velura_order_service_action(
  p_order_id uuid,
  p_action text,
  p_actor_id uuid,
  p_note text,
  p_payload jsonb,
  p_expected_version integer default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
begin
  if p_action = 'customer_cancel' then
    if p_actor_id is null or not exists (
      select 1 from public.orders where order_id = p_order_id and user_id = p_actor_id) then
      raise sqlstate 'PT403' using message = 'NOT_ORDER_OWNER';
    end if;
    return public.velura_order_apply_action(p_order_id, p_action, 'customer', p_actor_id, null,
      p_note, p_payload, p_expected_version, null);
  end if;
  return public.velura_order_apply_action(p_order_id, p_action, 'system', null, null,
    p_note, p_payload, p_expected_version, null);
end; $$;

revoke all on function public.velura_order_service_action(uuid, text, uuid, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.velura_order_service_action(uuid, text, uuid, text, jsonb, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Tác vụ 24 giờ
-- ---------------------------------------------------------------------------
-- Gọi định kỳ từ worker của API. `p_dry_run` chỉ đếm, không đổi gì: dùng để báo số đơn
-- sẽ bị tác động trước khi bật worker trên production. Mỗi đơn chạy trong khối
-- exception riêng để một đơn lỗi không chặn cả lô; hàm lõi tự kiểm lại điều kiện nên chạy
-- lặp lại không đổi kết quả.
create or replace function public.velura_run_order_automation(p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_order record;
  v_confirmed integer := 0;
  v_expired integer := 0;
  v_failed integer := 0;
  v_confirm_due integer;
  v_expire_due integer;
begin
  select count(*) into v_confirm_due from public.orders
  where status::text = 'pending' and payment_method::text = 'COD' and total_amount < 1000000
    and created_at <= (now() at time zone 'utc') - interval '24 hours';
  select count(*) into v_expire_due from public.orders o
  where o.status::text = 'waiting_payment'
    and o.created_at <= (now() at time zone 'utc') - interval '24 hours'
    and not exists (select 1 from public.payment p where p.order_id = o.order_id and p.payment_status::text = 'paid');
  if p_dry_run then
    return jsonb_build_object('dry_run', true, 'auto_confirm_due', v_confirm_due, 'payment_expired_due', v_expire_due);
  end if;

  for v_order in
    select order_id from public.orders
    where status::text = 'pending' and payment_method::text = 'COD' and total_amount < 1000000
      and created_at <= (now() at time zone 'utc') - interval '24 hours'
    order by created_at limit 200
  loop
    begin
      perform public.velura_order_apply_action(v_order.order_id, 'auto_confirm_cod', 'system', null, null,
        'Tự xác nhận COD dưới 1.000.000đ sau 24 giờ', '{}'::jsonb, null, null);
      v_confirmed := v_confirmed + 1;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  -- Đơn đã có tiền (đối soát tay hoặc webhook chuyển trạng thái bị lỗi) thì đi tiếp, không
  -- huỷ: huỷ lúc này là hoàn lại số tiền khách đã trả.
  for v_order in
    select o.order_id from public.orders o
    where o.status::text = 'waiting_payment'
      and exists (select 1 from public.payment p where p.order_id = o.order_id and p.payment_status::text = 'paid')
    order by o.created_at limit 200
  loop
    begin
      perform public.velura_order_apply_action(v_order.order_id, 'payment_succeeded', 'system', null, null,
        'Đơn đã có thanh toán thành công', '{}'::jsonb, null, null);
      v_confirmed := v_confirmed + 1;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  for v_order in
    select o.order_id from public.orders o
    where o.status::text = 'waiting_payment'
      and o.created_at <= (now() at time zone 'utc') - interval '24 hours'
      and not exists (select 1 from public.payment p where p.order_id = o.order_id and p.payment_status::text = 'paid')
    order by o.created_at limit 200
  loop
    begin
      perform public.velura_order_apply_action(v_order.order_id, 'payment_expired', 'system', null, null,
        'Hết 24 giờ chưa thanh toán thành công', '{}'::jsonb, null, null);
      v_expired := v_expired + 1;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object('dry_run', false, 'auto_confirmed', v_confirmed, 'payment_expired', v_expired, 'failed', v_failed);
end; $$;

revoke all on function public.velura_run_order_automation(boolean) from public, anon, authenticated;
grant execute on function public.velura_run_order_automation(boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Đơn online đang `pending` theo luồng cũ
-- ---------------------------------------------------------------------------
-- OPEN-05: đơn online vào Chờ thanh toán ngay khi tạo. Đơn tạo trước khi có quy tắc này
-- được chuyển theo, và đơn đã có tiền thì đi tiếp sang Đã xác nhận.
do $$
declare
  v_order record;
begin
  for v_order in
    select o.order_id,
           exists (select 1 from public.payment p where p.order_id = o.order_id
                   and p.payment_status::text = 'paid') as is_paid
    from public.orders o
    where o.status::text = 'pending' and o.payment_method::text = 'ONLINE_PAYMENT'
  loop
    perform public.velura_order_apply_action(v_order.order_id, 'to_waiting_payment', 'system', null, null,
      'Chuyển theo quy tắc OPEN-05', '{}'::jsonb, null, null);
    if v_order.is_paid then
      perform public.velura_order_apply_action(v_order.order_id, 'payment_succeeded', 'system', null, null,
        'Đơn đã thanh toán trước khi có trạng thái Chờ thanh toán', '{}'::jsonb, null, null);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 7b. Mỗi đơn chỉ một phiên Stripe đang mở
-- ---------------------------------------------------------------------------
-- Hai yêu cầu "Thanh toán lại" gần như cùng lúc đều qua được bước kiểm ở API. Khoá ở cơ
-- sở dữ liệu để lần thứ hai không tạo được payment `pending` thứ hai; khách không thể trả
-- tiền hai lần cho một đơn. Payment `pending` cũ trùng trên dữ liệu hiện có được đóng
-- trước, giữ lại phiên mới nhất.
update public.payment p
set payment_status = 'failed', gateway_response_code = 'superseded_session', updated_at = now()
where p.payment_provider::text = 'stripe' and p.payment_status::text = 'pending'
  and exists (
    select 1 from public.payment q
    where q.order_id = p.order_id and q.payment_provider::text = 'stripe' and q.payment_status::text = 'pending'
      and (q.created_at, q.payment_id) > (p.created_at, p.payment_id)
  );

create unique index if not exists payment_one_open_stripe_session
  on public.payment (order_id)
  where payment_provider = 'stripe' and payment_status = 'pending';

-- ---------------------------------------------------------------------------
-- 8. Đường cũ
-- ---------------------------------------------------------------------------
-- Dropdown chuyển trạng thái và nút huỷ riêng đã thay bằng `admin_order_action`. Bỏ hẳn
-- để không còn cửa nào cho admin chuyển `shipping → delivered` bằng tay.
drop function if exists public.admin_change_order_status(uuid, text, text, text, integer, text);
drop function if exists public.admin_cancel_order(uuid, text, integer, text);

notify pgrst, 'reload schema';
