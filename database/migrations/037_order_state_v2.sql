-- Migration: Bộ 8 trạng thái đơn theo KAN-59 và dữ liệu nền cho State Machine A1
-- Target tables: public.orders, public.order_status_history, public.order_event (mới)
--
-- KAN-59 chốt 8 trạng thái: pending, waiting_payment, confirmed, processing, shipping,
-- delivered, delivery_failed, cancelled. Enum đang chạy trên production dùng tên khác
-- cho hai trạng thái và còn `completed`, không có trong bộ mới. Quyết định A1-D1 (KAN-59,
-- 25/09/2026): đổi thẳng trong cơ sở dữ liệu, một lần phát hành, không giữ hai bộ tên.
--
-- Đo trên production ngày 25/09/2026: 154 đơn; 23 `completed`, 3 `preparing`,
-- 1 `failed_delivery`; 130 đơn không có dòng lịch sử trạng thái nào.
--
-- THỨ TỰ TRIỂN KHAI: migration này đổi tên giá trị enum đang được mã nguồn cũ dùng. Chạy
-- ngay khi bản API và hai frontend mới lên production, không chạy trước.
--
-- `waiting_payment` được thêm ở đây nhưng chưa được dùng trong cùng giao dịch, vì Postgres
-- không cho dùng giá trị enum mới trước khi giao dịch thêm nó được chốt. Migration 038
-- là nơi đầu tiên dùng tới.

-- ---------------------------------------------------------------------------
-- 1. Đổi tên và thêm giá trị enum
-- ---------------------------------------------------------------------------
alter type public.order_status rename value 'preparing' to 'processing';
alter type public.order_status rename value 'failed_delivery' to 'delivery_failed';
alter type public.order_status add value if not exists 'waiting_payment' after 'pending';

-- Hành động của System (tự xác nhận, tự huỷ, kết quả giao hàng) không có người thực hiện.
-- KAN-59 yêu cầu ghi người thực hiện là System, nên hai cột này phải cho phép null.
alter table public.order_status_history alter column changed_by drop not null;
alter table public.order_status_history alter column old_status drop not null;

-- ---------------------------------------------------------------------------
-- 2. Đơn `completed` về `delivered`
-- ---------------------------------------------------------------------------
-- `completed` không có trong bộ mới: hậu mãi (đổi trả, đánh giá) chạy quy trình riêng và
-- không đổi Order State. Postgres không xoá được một giá trị enum đang tồn tại, nên giá
-- trị này ở lại trong kiểu nhưng bị ràng buộc CHECK chặn không cho ghi.
insert into public.order_status_history (
  history_id, order_id, old_status, new_status, trigger_type, changed_by, changed_at, note
)
select gen_random_uuid(), o.order_id, o.status, 'delivered', 'system', null, now(),
       'Gộp trạng thái Hoàn thành vào Giao thành công theo bộ trạng thái KAN-59'
from public.orders o
where o.status::text = 'completed';

update public.orders
set status = 'delivered',
    delivered_at = coalesce(delivered_at, updated_at, created_at)
where status::text = 'completed';

alter table public.orders
  drop constraint if exists orders_status_not_completed,
  add constraint orders_status_not_completed check (status::text <> 'completed');

-- ---------------------------------------------------------------------------
-- 3. Cột mới trên đơn
-- ---------------------------------------------------------------------------
-- Mốc kho quyết định việc trả kho có đúng không. Đơn COD trừ kho lúc tạo; đơn Stripe trừ
-- kho lúc tiền về. Trước đây `admin_cancel_order` luôn cộng lại kho, nên huỷ một đơn
-- Stripe chưa trả tiền là cộng khống.
alter table public.orders
  add column if not exists stock_committed_at timestamptz,
  add column if not exists stock_returned_at timestamptz,
  add column if not exists carrier varchar(80),
  add column if not exists tracking_url text,
  add column if not exists shipment_created_at timestamptz,
  add column if not exists shipment_voided_at timestamptz,
  add column if not exists handed_over_at timestamptz,
  add column if not exists returned_to_stock_at timestamptz;

-- Đơn COD đã trừ kho từ lúc tạo. Đơn online chỉ tính đã trừ khi có thanh toán thành công.
update public.orders o
set stock_committed_at = o.created_at
where o.stock_committed_at is null
  and o.payment_method::text = 'COD';

update public.orders o
set stock_committed_at = coalesce(p.paid_at, o.created_at)
from public.payment p
where o.stock_committed_at is null
  and p.order_id = o.order_id
  and p.payment_status::text in ('paid', 'refund_pending', 'refunded');

-- Đơn đã huỷ trước ngày này đã được trả kho bởi đường huỷ cũ. Đánh dấu để không trả lần hai.
update public.orders
set stock_returned_at = coalesce(updated_at, created_at)
where status::text = 'cancelled'
  and stock_committed_at is not null
  and stock_returned_at is null;

-- ---------------------------------------------------------------------------
-- 3a. Mã phản hồi cổng thanh toán
-- ---------------------------------------------------------------------------
-- Cột chỉ dài 10 ký tự, trong khi các mã đang ghi dài hơn (`checkout.session.expired`,
-- `REFUND_REQUESTED`, `REFUND_FAILED`). Mọi lần ghi như vậy đều lỗi và bị bỏ qua, nên
-- webhook hết hạn phiên Stripe chưa từng đóng được payment nào.
alter table public.payment alter column gateway_response_code type varchar(50);

-- ---------------------------------------------------------------------------
-- 3b. Mã đơn tách khỏi mã vận đơn (FR-09 của KAN-40: order_code khác tracking_code)
-- ---------------------------------------------------------------------------
-- Storefront đang sinh `tracking_code = 'VLR' + 8 chữ số cuối của mốc mili giây` lúc tạo
-- đơn và dùng nó làm mã đơn cho khách, trong khi luồng admin cũ lại ghi mã vận đơn của
-- ĐVVC vào cùng cột đó. Hệ quả: không phân biệt được đơn đã có vận đơn hay chưa, và mã
-- đơn đoán được (KAN-40). Đo ngày 25/09: 99 đơn có tracking_code, phần lớn dạng VLR…,
-- vài đơn mang mã vận đơn thật (TRK-…), vài đơn mang chính order_id.
alter table public.orders add column if not exists order_code varchar(20);

-- Mã đơn cũ dạng VLR/EXC giữ nguyên để khách tra cứu bằng mã đã nhận trong email.
update public.orders
set order_code = upper(ltrim(tracking_code, '#'))
where order_code is null
  and tracking_code ~* '^#?(VLR|EXC)[0-9A-Z]{6,12}$';

-- Đơn không có mã hợp lệ: sinh mã ngẫu nhiên, không suy ra được từ thời điểm tạo.
update public.orders
set order_code = 'VLR' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 9))
where order_code is null;

create unique index if not exists orders_order_code_key on public.orders (order_code);
alter table public.orders alter column order_code set not null;
-- Mặc định ở cơ sở dữ liệu: bản API cũ chưa gửi order_code vẫn tạo được đơn trong
-- khoảng giữa lúc áp migration và lúc bản mới lên. API mới tự sinh mã.
alter table public.orders
  alter column order_code set default ('VLR' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 9)));

-- tracking_code từ nay chỉ là mã vận đơn. Giá trị đang là mã đơn hoặc order_id thì xoá.
update public.orders
set tracking_code = null
where tracking_code is not null
  and (upper(ltrim(tracking_code, '#')) = order_code or tracking_code = order_id::text);

-- Đơn đã rời kho trước ngày này: coi như đã bàn giao tại lần cập nhật cuối. Chỉ đơn còn
-- mã vận đơn thật mới có mốc tạo vận đơn.
update public.orders
set handed_over_at = coalesce(handed_over_at, updated_at),
    shipment_created_at = case when tracking_code is not null then coalesce(shipment_created_at, updated_at) else shipment_created_at end
where status::text in ('shipping', 'delivered', 'delivery_failed');

-- ---------------------------------------------------------------------------
-- 4. Nhật ký xử lý đơn (OPEN-04)
-- ---------------------------------------------------------------------------
-- Mọi action, kể cả action không đổi trạng thái. `order_status_history` giữ riêng các lần
-- chuyển trạng thái và là nguồn cho timeline phía khách.
create table if not exists public.order_event (
  event_id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(order_id) on delete cascade,
  action varchar(40) not null,
  actor_type public.trigger_type not null,
  actor_id uuid references public.users(user_id),
  actor_role varchar(40),
  from_status public.order_status,
  to_status public.order_status,
  result varchar(40) not null default 'success',
  note text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_order_event_order_created
  on public.order_event (order_id, created_at desc);

alter table public.order_event enable row level security;

drop policy if exists velura_order_event_select on public.order_event;
create policy velura_order_event_select on public.order_event
  for select to authenticated
  using (public.velura_is_order_reader());

revoke all on public.order_event from anon;
revoke insert, update, delete on public.order_event from authenticated;
grant select on public.order_event to authenticated;
grant all on public.order_event to service_role;

-- ---------------------------------------------------------------------------
-- 5. Timeline cho đơn chưa có lịch sử
-- ---------------------------------------------------------------------------
-- Dòng khởi tạo tại thời điểm tạo đơn, và nếu đơn đã đi tiếp thì một dòng trạng thái hiện
-- tại tại lần cập nhật cuối. Mốc giữa hai dòng này không còn dữ liệu để dựng lại.
insert into public.order_status_history (
  history_id, order_id, old_status, new_status, trigger_type, changed_by, changed_at, note
)
select gen_random_uuid(), o.order_id, null, 'pending', 'system', null, o.created_at,
       'Đơn được tạo'
from public.orders o
where not exists (select 1 from public.order_status_history h where h.order_id = o.order_id);

insert into public.order_status_history (
  history_id, order_id, old_status, new_status, trigger_type, changed_by, changed_at, note
)
select gen_random_uuid(), o.order_id, 'pending', o.status, 'system', null,
       coalesce(o.updated_at, o.created_at),
       'Đơn tạo trước ngày 25/09/2026, không có mốc cho từng bước trung gian'
from public.orders o
where o.status::text <> 'pending'
  and (select count(*) from public.order_status_history h where h.order_id = o.order_id) = 1
  and exists (
    select 1 from public.order_status_history h
    where h.order_id = o.order_id and h.old_status is null and h.note = 'Đơn được tạo'
  );

-- ---------------------------------------------------------------------------
-- 6. Ba hàm còn viết cứng mã cũ
-- ---------------------------------------------------------------------------
-- So sánh bằng `status::text` với tên cũ sẽ lặng lẽ không bao giờ khớp sau khi đổi tên,
-- nên phải dựng lại cùng lúc. Migration 038 thay hai hàm đầu bằng lớp mỏng gọi RPC action.
create or replace function public.admin_change_order_status(
  p_order_id uuid, p_new_status text, p_reason text, p_tracking_code text,
  p_expected_version integer, p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.orders%rowtype;
  v_after public.orders%rowtype;
  v_status public.orders.status%type;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if not public.velura_is_order_operator() then raise sqlstate 'PT403' using message = 'RBAC_DENIED'; end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'ORDER_REASON_REQUIRED';
  end if;

  select * into v_before from public.orders where order_id = p_order_id for update;
  if v_before.order_id is null then raise sqlstate 'PT404' using message = 'ORDER_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text in ('delivered', 'delivery_failed', 'cancelled') then
    raise sqlstate 'PT422' using message = 'ORDER_TERMINAL';
  end if;
  if p_new_status = 'cancelled' then raise sqlstate 'PT422' using message = 'USE_CANCEL_ACTION'; end if;
  if not (
    (v_before.status::text = 'pending' and p_new_status = 'confirmed' and v_before.payment_method::text = 'COD')
    or (v_before.status::text = 'confirmed' and p_new_status = 'processing')
    or (v_before.status::text = 'processing' and p_new_status = 'shipping')
  ) then
    raise sqlstate 'PT422' using message = 'INVALID_ORDER_TRANSITION';
  end if;
  if p_new_status = 'shipping' and nullif(btrim(coalesce(p_tracking_code, v_before.tracking_code)), '') is null then
    raise sqlstate 'PT422' using message = 'TRACKING_CODE_REQUIRED';
  end if;

  select x.status into v_status
  from jsonb_populate_record(null::public.orders, jsonb_build_object('status', p_new_status)) x;

  update public.orders
  set status = v_status,
      tracking_code = case when p_new_status = 'shipping'
                           then coalesce(nullif(btrim(p_tracking_code), ''), tracking_code)
                           else tracking_code end,
      handed_over_at = case when p_new_status = 'shipping' then now() else handed_over_at end,
      version = version + 1,
      updated_at = now()
  where order_id = p_order_id and version = p_expected_version
  returning * into v_after;
  if v_after.order_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  insert into public.order_status_history (
    history_id, order_id, old_status, new_status, trigger_type, changed_by, changed_at, note
  ) values (
    gen_random_uuid(), p_order_id, v_before.status, v_after.status, 'manual', v_actor.user_id, now(), btrim(p_reason)
  );
  perform public.velura_append_module_audit(
    'orders', v_actor.user_id, v_actor.admin_role::text, 'update', p_order_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version, 'tracking_code', v_after.tracking_code),
    p_ip_address
  );
  perform public.velura_enqueue_order_email(
    (select email from public.users where user_id = v_after.user_id),
    'order_status_changed', 'Cap nhat trang thai don hang',
    format('Don hang %s da chuyen sang trang thai %s.', p_order_id, p_new_status),
    v_after.user_id, jsonb_build_object('order_id', p_order_id, 'status', p_new_status)
  );
  return to_jsonb(v_after);
end; $$;

create or replace function public.admin_cancel_order(
  p_order_id uuid, p_reason text, p_expected_version integer, p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.orders%rowtype;
  v_after public.orders%rowtype;
  v_payment public.payment%rowtype;
  v_item record;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if not public.velura_is_order_operator() then raise sqlstate 'PT403' using message = 'RBAC_DENIED'; end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'ORDER_REASON_REQUIRED';
  end if;

  select * into v_before from public.orders where order_id = p_order_id for update;
  if v_before.order_id is null then raise sqlstate 'PT404' using message = 'ORDER_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text not in ('pending', 'waiting_payment', 'confirmed', 'processing') then
    raise sqlstate 'PT422' using message = 'ORDER_CANNOT_CANCEL';
  end if;

  -- Chỉ trả kho khi kho đã thực sự bị trừ, và chỉ một lần.
  if v_before.stock_committed_at is not null and v_before.stock_returned_at is null then
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
          version = version + 1,
          updated_at = now()
      where variant_id = v_item.variant_id;
      if not found then raise sqlstate 'PT409' using message = 'ORDER_VARIANT_NOT_FOUND'; end if;
    end loop;
  end if;

  update public.orders
  set status = 'cancelled',
      cancelled_reason = btrim(p_reason),
      stock_returned_at = case when stock_committed_at is not null then coalesce(stock_returned_at, now()) else stock_returned_at end,
      shipment_voided_at = case when shipment_created_at is not null and handed_over_at is null then now() else shipment_voided_at end,
      version = version + 1,
      updated_at = now()
  where order_id = p_order_id and version = p_expected_version
  returning * into v_after;
  if v_after.order_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  select * into v_payment from public.payment
  where order_id = p_order_id and payment_status::text = 'paid'
  order by created_at desc limit 1 for update;
  if v_payment.payment_id is not null then
    update public.payment
    set payment_status = 'refund_pending', refund_amount = amount, refund_reason = btrim(p_reason),
        version = version + 1, updated_at = now()
    where payment_id = v_payment.payment_id;
  end if;

  insert into public.order_status_history (
    history_id, order_id, old_status, new_status, trigger_type, changed_by, changed_at, note
  ) values (
    gen_random_uuid(), p_order_id, v_before.status, v_after.status, 'manual', v_actor.user_id, now(), btrim(p_reason)
  );
  perform public.velura_append_module_audit(
    'orders', v_actor.user_id, v_actor.admin_role::text, 'update', p_order_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version,
      'refund_status', case when v_payment.payment_id is null then 'no_refund' else 'refund_pending' end),
    p_ip_address
  );
  perform public.velura_enqueue_order_email(
    (select email from public.users where user_id = v_after.user_id),
    'order_cancelled', 'Thong bao huy don hang',
    format('Don hang %s da bi huy. Ly do: %s', p_order_id, btrim(p_reason)),
    v_after.user_id, jsonb_build_object('order_id', p_order_id, 'refund_pending', v_payment.payment_id is not null)
  );
  return jsonb_build_object('order', to_jsonb(v_after), 'refund_pending', v_payment.payment_id is not null);
end; $$;

create or replace function public.admin_resolve_payment(
  p_order_id uuid, p_payment_id uuid, p_decision text, p_reason text,
  p_expected_order_version integer, p_expected_payment_version integer, p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_order public.orders%rowtype;
  v_before public.payment%rowtype;
  v_after public.payment%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if not public.velura_is_order_operator() then raise sqlstate 'PT403' using message = 'RBAC_DENIED'; end if;
  if p_decision not in ('mark_paid', 'mark_failed') then
    raise sqlstate 'PT422' using message = 'INVALID_PAYMENT_DECISION';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'PAYMENT_REASON_REQUIRED';
  end if;

  select * into v_order from public.orders where order_id = p_order_id for update;
  if v_order.order_id is null then raise sqlstate 'PT404' using message = 'ORDER_NOT_FOUND'; end if;
  if v_order.version <> p_expected_order_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_order.status::text = 'cancelled' then raise sqlstate 'PT422' using message = 'ORDER_TERMINAL'; end if;

  select * into v_before from public.payment
  where payment_id = p_payment_id and order_id = p_order_id for update;
  if v_before.payment_id is null then raise sqlstate 'PT404' using message = 'PAYMENT_NOT_FOUND'; end if;
  if v_before.version <> p_expected_payment_version then
    raise sqlstate 'PT409' using message = 'PAYMENT_VERSION_CONFLICT';
  end if;
  -- Mở thêm cho payment kẹt ở `pending` (KAN-44 mục 7): tình huống cổng thanh toán không
  -- gọi lại được, trước đây không có công cụ nào xử lý.
  if v_before.payment_status::text not in ('failed', 'discrepancy', 'pending') and not v_before.has_discrepancy then
    raise sqlstate 'PT422' using message = 'PAYMENT_NOT_RESOLVABLE';
  end if;

  update public.payment
  set payment_status = case when p_decision = 'mark_paid' then 'paid'::public.payment_status else 'failed'::public.payment_status end,
      has_discrepancy = false,
      paid_at = case when p_decision = 'mark_paid' then coalesce(paid_at, now()) else paid_at end,
      gateway_response_code = case when p_decision = 'mark_paid' then 'ADMIN_OK' else gateway_response_code end,
      version = version + 1,
      updated_at = now()
  where payment_id = p_payment_id and version = p_expected_payment_version
  returning * into v_after;
  if v_after.payment_id is null then raise sqlstate 'PT409' using message = 'PAYMENT_VERSION_CONFLICT'; end if;

  update public.orders set version = version + 1, updated_at = now()
  where order_id = p_order_id and version = p_expected_order_version;
  if not found then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  -- Đơn online còn Chờ thanh toán mà admin xác nhận đã nhận tiền: đi tiếp sang Đã xác
  -- nhận ngay trong giao dịch này (trừ kho, ghi lịch sử). Không làm vậy thì đơn kẹt ở
  -- Chờ thanh toán, 24 giờ sau bị tự huỷ và hoàn lại số tiền vừa được xác nhận.
  if p_decision = 'mark_paid' and v_order.status::text = 'waiting_payment'
     and v_order.payment_method::text = 'ONLINE_PAYMENT' then
    perform public.velura_order_apply_action(
      p_order_id, 'payment_succeeded', 'system', v_actor.user_id, v_actor.admin_role::text,
      'Đối soát thủ công: ' || btrim(p_reason), jsonb_build_object('payment_id', p_payment_id), null, p_ip_address
    );
  end if;

  perform public.velura_append_module_audit(
    'orders', v_actor.user_id, v_actor.admin_role::text, 'update', p_order_id,
    jsonb_build_object('payment_id', p_payment_id, 'payment_status', v_before.payment_status, 'version', v_before.version),
    jsonb_build_object('payment_id', p_payment_id, 'payment_status', v_after.payment_status, 'version', v_after.version),
    p_ip_address
  );
  return to_jsonb(v_after);
end; $$;

notify pgrst, 'reload schema';
