-- KAN-106 (AUTH-08): OTP tra cứu đơn phải sống đúng 5 phút như hộp đếm 05:00 trên UI.
-- 060 rút hạn xuống 1 phút trong khi UI vẫn đếm 5 phút, nên khách nhập mã sau ~60 giây luôn nhận
-- EXPIRED_OTP và nghĩ là hệ thống lỗi. Cùng lúc, guard "đơn thuộc số điện thoại này" so sánh chuỗi
-- thô: đơn lưu 84xx/+84xx không bao giờ khớp, khiến tra cứu theo mã đơn chết ở ORDER_NOT_FOUND.
-- Số điện thoại bây giờ được chuẩn hoá về 0xxxxxxxxx bằng 9 chữ số cuối, giống hệt TS.
begin;

create or replace function public.velura_issue_guest_tracking_otp(
  p_phone text,
  p_ip text,
  p_nonce uuid,
  p_hash text,
  p_order uuid default null
)
returns void language plpgsql security definer set search_path = pg_catalog,public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('tracking-phone:'||p_phone,0));
  perform pg_advisory_xact_lock(hashtextextended('tracking-ip:'||p_ip,0));
  if p_order is not null and not exists(
    select 1 from public.orders
    where order_id = p_order
      and '0' || right(regexp_replace(coalesce(shipping_phone,''), '[^0-9]', '', 'g'), 9)
        = '0' || right(regexp_replace(coalesce(p_phone,''), '[^0-9]', '', 'g'), 9)
  ) then raise sqlstate 'PT404' using message='ORDER_NOT_FOUND'; end if;
  if (select count(*) from public.guest_tracking_otp where phone=p_phone and created_at>now()-interval '15 minutes')>=3 then raise sqlstate 'PT429' using message='OTP_PHONE_RATE_LIMIT'; end if;
  if (select count(*) from public.guest_tracking_otp where ip_address=p_ip and created_at>now()-interval '1 hour')>=10 then raise sqlstate 'PT429' using message='OTP_IP_RATE_LIMIT'; end if;
  update public.guest_tracking_otp set consumed_at=now() where phone=p_phone and consumed_at is null;
  insert into public.guest_tracking_otp(phone,ip_address,nonce,code_hash,scoped_order_id,expires_at)
    values(p_phone,p_ip,p_nonce,p_hash,p_order,now()+interval '5 minutes');
end; $$;

revoke all on function public.velura_issue_guest_tracking_otp(text,text,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.velura_issue_guest_tracking_otp(text,text,uuid,text,uuid) to service_role;

notify pgrst, 'reload schema';
commit;
