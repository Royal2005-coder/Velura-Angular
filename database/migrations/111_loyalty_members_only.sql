-- KAN-106: tích điểm khi mua hàng chỉ dành cho thành viên.
--
-- Đo production ngày 06/11: 236 đơn đã có bút toán 'earn' thì 14 đơn là khách vãng lai
-- (`orders.is_guest = true`), và 27 chủ ví đang có điểm thì 9 tài khoản role='admin', 4 tài khoản
-- role='member' chưa xác thực OTP. Khách vãng lai chưa phải thành viên (chưa tài khoản, chưa OTP),
-- nên không được phát sinh nợ điểm; admin không mua hàng.
--
-- 087 là định nghĩa đang chạy (ghi chú "Thưởng 5% khi đơn đã thanh toán và giao thành công", hạn
-- 6 tháng, có lot và bù nợ) — giữ nguyên toàn bộ, chỉ thêm đúng điều kiện tư cách thành viên.
-- Không xoá bút toán đã ghi: ledger là lịch sử tiền. Số điểm đã phát sinh cho khách vãng lai là
-- khoản phải xử lý bằng điều chỉnh có kiểm soát, không phải bằng migration xoá dữ liệu.
begin;

create or replace function public.velura_award_order_loyalty(p_order_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_order public.orders%rowtype; v_account public.loyalty_account%rowtype;
  v_earned bigint; v_debt_paid bigint; v_credit bigint; v_merchandise numeric; v_ledger uuid;
begin
  select * into v_order from public.orders where order_id=p_order_id for update;
  if not found or v_order.status::text <> 'delivered' or v_order.user_id is null
     or v_order.delivered_at is null or v_order.delivered_at > now()
     or coalesce(v_order.order_kind::text,'sale')='exchange'
     or exists(select 1 from public.loyalty_ledger where order_id=p_order_id and kind='earn')
     or not exists(select 1 from public.payment where order_id=p_order_id
       and payment_status::text in ('paid','refund_pending','refunded'))
     or v_order.is_guest is distinct from false
     or not exists(select 1 from public.users
       where user_id = v_order.user_id and role::text = 'member' and is_active) then return; end if;
  perform public.velura_ensure_loyalty_account(v_order.user_id);
  select * into v_account from public.loyalty_account where user_id=v_order.user_id for update;
  if v_account.accrual_locked and v_account.accrual_lock_source in ('manual','legacy_unknown') then return; end if;
  v_merchandise := greatest(0,coalesce(v_order.subtotal,0)
    - case when exists(select 1 from public.voucher where voucher_id=v_order.voucher_id
        and discount_type::text='free_shipping') then 0 else coalesce(v_order.discount_amount,0) end
    - coalesce(v_order.points_discount,0));
  v_earned := floor(v_merchandise*5/100);
  v_debt_paid := least(v_earned,greatest(0,v_account.debt_milli_points));
  v_credit := v_earned-v_debt_paid;
  update public.loyalty_account set balance_milli_points=balance_milli_points+v_credit,
    debt_milli_points=debt_milli_points-v_debt_paid,
    warning_flags=case when debt_milli_points-v_debt_paid=0 then 0 else warning_flags end,
    updated_at=now() where user_id=v_order.user_id returning * into v_account;
  update public.orders set points_earned_milli=v_earned where order_id=p_order_id;
  insert into public.loyalty_ledger(user_id,order_id,kind,amount_milli_points,balance_after_milli_points,expires_at,note)
  values(v_order.user_id,p_order_id,'earn',v_credit,v_account.balance_milli_points,
    v_order.delivered_at+interval '6 months','Thưởng 5% khi đơn đã thanh toán và giao thành công')
  returning ledger_id into v_ledger;
  if v_credit>0 then
    insert into public.loyalty_point_lot(user_id,order_id,ledger_id,earned_milli,remaining_milli,expires_at,source)
      values(v_order.user_id,p_order_id,v_ledger,v_credit,v_credit,v_order.delivered_at+interval '6 months','award');
  end if;
  if v_debt_paid>0 then
    insert into public.loyalty_ledger(user_id,order_id,kind,amount_milli_points,balance_after_milli_points,
      debt_delta_milli_points,note)
    values(v_order.user_id,p_order_id,'debt_repayment',v_debt_paid,v_account.balance_milli_points,
      -v_debt_paid,'Điểm tích luỹ bù nợ trước khi cộng số dư khả dụng');
  end if;
  perform public.velura_complete_referral(v_order.user_id,p_order_id);
end; $$;

notify pgrst, 'reload schema';
commit;
