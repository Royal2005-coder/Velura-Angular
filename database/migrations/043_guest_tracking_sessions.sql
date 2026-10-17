-- KAN-58: durable, rate-limited phone verification grants a session instead of OTP per action.
create table if not exists public.guest_tracking_otp (
  challenge_id uuid primary key default gen_random_uuid(), phone text not null,
  ip_address text not null, nonce uuid not null, code_hash text not null,
  attempts integer not null default 0, expires_at timestamptz not null default now() + interval '60 seconds',
  consumed_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists guest_tracking_phone_created on public.guest_tracking_otp(phone, created_at desc);
create index if not exists guest_tracking_ip_created on public.guest_tracking_otp(ip_address, created_at desc);
alter table public.guest_tracking_otp enable row level security;
revoke all on public.guest_tracking_otp from anon, authenticated;
grant all on public.guest_tracking_otp to service_role;

create or replace function public.velura_issue_guest_tracking_otp(p_phone text, p_ip text, p_nonce uuid, p_hash text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('tracking-phone:' || p_phone, 0));
  perform pg_advisory_xact_lock(hashtextextended('tracking-ip:' || p_ip, 0));
  if (select count(*) from public.guest_tracking_otp where phone = p_phone and created_at > now() - interval '15 minutes') >= 3 then
    raise sqlstate 'PT429' using message = 'OTP_PHONE_RATE_LIMIT';
  end if;
  if (select count(*) from public.guest_tracking_otp where ip_address = p_ip and created_at > now() - interval '1 hour') >= 10 then
    raise sqlstate 'PT429' using message = 'OTP_IP_RATE_LIMIT';
  end if;
  update public.guest_tracking_otp set consumed_at = now() where phone = p_phone and consumed_at is null;
  insert into public.guest_tracking_otp(phone, ip_address, nonce, code_hash) values(p_phone, p_ip, p_nonce, p_hash);
end; $$;
revoke all on function public.velura_issue_guest_tracking_otp(text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.velura_issue_guest_tracking_otp(text, text, uuid, text) to service_role;

create or replace function public.velura_verify_guest_tracking_otp(p_id uuid, p_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_row public.guest_tracking_otp%rowtype;
begin
  select * into v_row from public.guest_tracking_otp where challenge_id = p_id for update;
  if not found or v_row.consumed_at is not null then return jsonb_build_object('verified', false, 'code', 'INVALID_OTP'); end if;
  if v_row.attempts >= 5 then return jsonb_build_object('verified', false, 'code', 'SESSION_LOCKED'); end if;
  if v_row.expires_at <= now() then return jsonb_build_object('verified', false, 'code', 'EXPIRED_OTP'); end if;
  if v_row.code_hash <> p_hash then
    update public.guest_tracking_otp set attempts = attempts + 1 where challenge_id = p_id;
    return jsonb_build_object('verified', false, 'code', case when v_row.attempts >= 4 then 'SESSION_LOCKED' else 'INVALID_OTP' end);
  end if;
  update public.guest_tracking_otp set consumed_at = now() where challenge_id = p_id;
  return jsonb_build_object('verified', true);
end; $$;
revoke all on function public.velura_verify_guest_tracking_otp(uuid, text) from public, anon, authenticated;
grant execute on function public.velura_verify_guest_tracking_otp(uuid, text) to service_role;
