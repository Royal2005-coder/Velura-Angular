-- KAN-315: guest order OTP expires after one minute; verification remains atomically limited to five failures.
begin;

create or replace function public.velura_issue_guest_tracking_otp(
  p_phone text,
  p_ip text,
  p_nonce uuid,
  p_hash text,
  p_order uuid default null
)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('tracking-phone:'||p_phone,0));
  perform pg_advisory_xact_lock(hashtextextended('tracking-ip:'||p_ip,0));
  if p_order is not null and not exists(select 1 from public.orders where order_id=p_order and shipping_phone=p_phone) then raise sqlstate 'PT404' using message='ORDER_NOT_FOUND'; end if;
  if (select count(*) from public.guest_tracking_otp where phone=p_phone and created_at>now()-interval '15 minutes')>=3 then raise sqlstate 'PT429' using message='OTP_PHONE_RATE_LIMIT'; end if;
  if (select count(*) from public.guest_tracking_otp where ip_address=p_ip and created_at>now()-interval '1 hour')>=10 then raise sqlstate 'PT429' using message='OTP_IP_RATE_LIMIT'; end if;
  update public.guest_tracking_otp set consumed_at=now() where phone=p_phone and consumed_at is null;
  insert into public.guest_tracking_otp(phone,ip_address,nonce,code_hash,scoped_order_id,expires_at)
    values(p_phone,p_ip,p_nonce,p_hash,p_order,now()+interval '1 minute');
end; $$;

revoke all on function public.velura_issue_guest_tracking_otp(text,text,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.velura_issue_guest_tracking_otp(text,text,uuid,text,uuid) to service_role;
notify pgrst,'reload schema';
commit;
