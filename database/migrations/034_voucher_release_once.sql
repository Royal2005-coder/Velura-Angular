-- Migration: Trả lượt mã và ngân sách chiến dịch đúng một lần cho mỗi đơn.
-- Target tables: public.orders, public.voucher, public.promotion
--
-- Bối cảnh: lượt dùng mã và phần ngân sách chiến dịch được ghi ngay lúc tạo đơn, trước khi
-- khách trả tiền. Có hai đường làm đơn kết thúc mà không thành: khách huỷ, và thanh toán
-- trực tuyến hết hạn hoặc bị huỷ. Trước migration này chỉ đường huỷ đơn trả lại lượt, và
-- `velura_release_voucher_redemption` nhận thẳng mã voucher cùng số tiền nên không biết
-- đơn nào đã được trả rồi. Một đơn vừa hết hạn thanh toán vừa bị admin huỷ sẽ được trả hai
-- lần, và bộ đếm của mã tụt xuống dưới số lượt thật.
--
-- Hàm mới làm việc theo đơn thay vì theo mã, và đóng dấu `voucher_released_at` trong cùng
-- giao dịch. Gọi lần thứ hai trên cùng đơn là no-op, bất kể từ đường nào.
--
-- Thứ tự triển khai: migration này an toàn để chạy TRƯỚC khi bản API mới được deploy.
-- Bản API cũ đang chạy vẫn gọi `velura_release_voucher_redemption` ngay trước khi đổi
-- trạng thái đơn sang cancelled. Nếu hàm đó còn trả lượt thật thì trong khoảng giữa lúc
-- chạy migration và lúc deploy, trigger bên dưới sẽ trả thêm một lần nữa — mã vượt lượt,
-- chiến dịch vượt ngân sách. Vì vậy phép trả thật được dời sang hàm nội bộ mới, còn hàm
-- cũ trở thành no-op giữ tương thích.

alter table public.orders
  add column if not exists voucher_released_at timestamptz;

comment on column public.orders.voucher_released_at is
  'Thời điểm lượt mã và ngân sách của đơn đã được trả lại. Khác null thì không trả lần nữa.';

-- ---------------------------------------------------------------------------
-- Phép trả thật: giữ nguyên cách tính của migration 025
-- ---------------------------------------------------------------------------
create or replace function public.velura_apply_voucher_release(
  p_voucher_id uuid,
  p_discount_amount numeric default 0
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_voucher public.voucher%rowtype;
  v_promotion public.promotion%rowtype;
begin
  select * into v_voucher from public.voucher where voucher_id = p_voucher_id for update;
  if v_voucher.voucher_id is null then
    raise sqlstate 'PT404' using message = 'VOUCHER_NOT_FOUND';
  end if;

  update public.voucher
     set used_count = greatest(coalesce(used_count, 0) - 1, 0),
         version = coalesce(version, 1) + 1,
         updated_at = now()
   where voucher_id = p_voucher_id
  returning * into v_voucher;

  if v_voucher.promo_id is not null then
    update public.promotion
       set total_discount_issued = greatest(coalesce(total_discount_issued, 0) - greatest(coalesce(p_discount_amount, 0), 0), 0),
           version = coalesce(version, 1) + 1,
           updated_at = now()
     where promo_id = v_voucher.promo_id
    returning * into v_promotion;
  end if;

  return jsonb_build_object(
    'voucher_id', v_voucher.voucher_id,
    'used_count', v_voucher.used_count,
    'total_discount_issued', coalesce(v_promotion.total_discount_issued, 0)
  );
end; $$;

revoke all on function public.velura_apply_voucher_release(uuid, numeric) from public, anon, authenticated;
grant execute on function public.velura_apply_voucher_release(uuid, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- Hàm cũ: no-op giữ tương thích cho bản API chưa deploy
-- ---------------------------------------------------------------------------
-- Giữ nguyên chữ ký để bản API cũ gọi không lỗi, nhưng không trả gì nữa. Trả lượt giờ chỉ
-- đi qua `velura_release_order_voucher`, được gọi từ trigger huỷ đơn và từ đường đóng
-- thanh toán. Có thể xoá hàm này khi chắc chắn không còn bản API cũ nào chạy.
create or replace function public.velura_release_voucher_redemption(
  p_voucher_id uuid,
  p_discount_amount numeric default 0
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
begin
  return jsonb_build_object(
    'voucher_id', p_voucher_id,
    'released', false,
    'reason', 'DEPRECATED_USE_ORDER_RELEASE'
  );
end; $$;

-- ---------------------------------------------------------------------------
-- Trả theo đơn, đúng một lần
-- ---------------------------------------------------------------------------
create or replace function public.velura_release_order_voucher(
  p_order_id uuid,
  p_reason text default 'order_cancelled'
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_order public.orders%rowtype;
  v_result jsonb;
begin
  -- Khoá dòng đơn: hai đường kết thúc đến cùng lúc thì một đường phải chờ đường kia đóng
  -- dấu xong, rồi thấy dấu đã có và dừng.
  select * into v_order from public.orders where order_id = p_order_id for update;
  if v_order.order_id is null then
    raise sqlstate 'PT404' using message = 'ORDER_NOT_FOUND';
  end if;

  if v_order.voucher_id is null then
    return jsonb_build_object('order_id', p_order_id, 'released', false, 'reason', 'NO_VOUCHER');
  end if;

  if v_order.voucher_released_at is not null then
    return jsonb_build_object(
      'order_id', p_order_id,
      'released', false,
      'reason', 'ALREADY_RELEASED',
      'released_at', v_order.voucher_released_at
    );
  end if;

  -- Cùng cách tính của migration 025, nay nằm ở hàm nội bộ.
  v_result := public.velura_apply_voucher_release(
    v_order.voucher_id,
    coalesce(v_order.discount_amount, 0)
  );

  update public.orders
     set voucher_released_at = now()
   where order_id = p_order_id;

  perform public.velura_append_module_audit(
    'promotions', null, 'system', 'update', v_order.voucher_id,
    jsonb_build_object('order_id', p_order_id, 'voucher_released_at', null),
    jsonb_build_object(
      'order_id', p_order_id,
      'reason', coalesce(p_reason, 'order_cancelled'),
      'discount_amount', coalesce(v_order.discount_amount, 0),
      'used_count', v_result -> 'used_count',
      'total_discount_issued', v_result -> 'total_discount_issued'
    ),
    null);

  return jsonb_build_object(
    'order_id', p_order_id,
    'released', true,
    'reason', coalesce(p_reason, 'order_cancelled'),
    'voucher_id', v_order.voucher_id,
    'used_count', v_result -> 'used_count',
    'total_discount_issued', v_result -> 'total_discount_issued'
  );
end; $$;

revoke all on function public.velura_release_order_voucher(uuid, text) from public, anon, authenticated;
grant execute on function public.velura_release_order_voucher(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Mọi đường huỷ đơn đều trả lượt, không chỉ đường của khách
-- ---------------------------------------------------------------------------
-- `admin_cancel_order` (migration 003) trả tồn kho nhưng không trả lượt mã lẫn ngân sách
-- chiến dịch, nên đơn do admin huỷ giữ lượt của mã vĩnh viễn. Gắn vào trạng thái của đơn
-- thay vì vào từng hàm huỷ: khách huỷ, admin huỷ, và mọi đường huỷ thêm về sau cùng đi qua
-- một chỗ, trong cùng giao dịch với lệnh đổi trạng thái.
--
-- Trigger chỉ bắt khi cột `status` nằm trong câu SET, nên lệnh đóng dấu
-- `voucher_released_at` bên trong không làm nó bắn lại.
create or replace function public.velura_orders_release_voucher_on_cancel()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
begin
  if new.status = 'cancelled'
     and old.status is distinct from 'cancelled'
     and new.voucher_id is not null
     and new.voucher_released_at is null then
    begin
      perform public.velura_release_order_voucher(new.order_id, 'order_cancelled');
    exception when others then
      -- Sổ sách khuyến mãi hỏng không được phép chặn việc huỷ đơn của khách. Ghi cảnh báo
      -- để đối soát, đơn vẫn huỷ, và dấu chưa đóng nên lần gọi tay sau vẫn trả được.
      raise warning 'velura_release_order_voucher failed for order %: %', new.order_id, sqlerrm;
    end;
  end if;
  return new;
end; $$;

drop trigger if exists trg_orders_release_voucher_on_cancel on public.orders;
create trigger trg_orders_release_voucher_on_cancel
  after update of status on public.orders
  for each row execute function public.velura_orders_release_voucher_on_cancel();

revoke all on function public.velura_orders_release_voucher_on_cancel() from public, anon, authenticated;
