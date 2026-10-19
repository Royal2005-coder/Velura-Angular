-- KAN-105 3.1.12 (AD_REFUND_02/04/05, AD_CSKH_03): COD returns are refunded by a manual bank/wallet transfer.
-- The customer's receiving account is captured per return, CSKH can ask for a supplement without leaving the
-- refund stage, the refund cannot continue while the account is empty/invalid, and the transfer result
-- (reference, amount, time, proof, receiver snapshot) is stored as reconciliation data. Builds on 042/045/068.
begin;

create table if not exists public.return_refund_receiver (
  return_id uuid primary key references public.return_exchange(return_id) on delete cascade,
  bank_name text,
  account_number text,
  account_holder text,
  submitted_at timestamptz,
  supplement_request text,
  supplement_requested_at timestamptz,
  supplement_requested_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.return_refund_receiver enable row level security;
revoke all on public.return_refund_receiver from anon, authenticated;
grant all on public.return_refund_receiver to service_role;

create table if not exists public.return_manual_refund (
  return_id uuid primary key references public.return_exchange(return_id),
  refund_id uuid not null unique references public.payment_refund(refund_id),
  payment_kind text not null check (payment_kind in ('cod', 'other_online')),
  reference text not null check (length(btrim(reference)) >= 6),
  amount numeric not null check (amount > 0),
  transferred_at timestamptz not null,
  receiver_bank_name text,
  receiver_account_number text,
  receiver_account_holder text,
  proof text not null,
  note text,
  recorded_by uuid not null,
  recorded_at timestamptz not null default now()
);
create unique index if not exists return_manual_refund_reference_key on public.return_manual_refund (upper(btrim(reference)));
alter table public.return_manual_refund enable row level security;
revoke all on public.return_manual_refund from anon, authenticated;
grant select on public.return_manual_refund to authenticated;
grant all on public.return_manual_refund to service_role;
drop policy if exists return_manual_refund_admin_read on public.return_manual_refund;
create policy return_manual_refund_admin_read on public.return_manual_refund for select to authenticated using (
  (select public.velura_has_admin_role(array['super_admin', 'admin_operator_donhang', 'admin_operator_cskh_dt']))
);

-- Same rule as apps/api/src/returns/return-refund-receiver.ts: bank 2-80 chars, 6-20 digit account, holder 2-100 chars without digits.
create or replace function public.velura_refund_receiver_valid(p_bank text, p_account text, p_holder text)
returns boolean language sql immutable set search_path = pg_catalog, public as $$
  select coalesce(
    length(btrim(p_bank)) between 2 and 80
    and p_account ~ '^[0-9]{6,20}$'
    and length(btrim(p_holder)) between 2 and 100
    and btrim(p_holder) !~ '[0-9]', false);
$$;

create or replace function public.velura_return_requires_refund_receiver(p_return_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists(select 1 from public.return_exchange r join public.orders o on o.order_id = r.order_id
    where r.return_id = p_return_id and r.return_type::text = 'refund' and o.payment_method::text = 'COD');
$$;
revoke all on function public.velura_return_requires_refund_receiver(uuid) from public, anon, authenticated;
grant execute on function public.velura_return_requires_refund_receiver(uuid) to service_role;

-- Ready = complete, valid and no open CSKH supplement request. Anything else blocks the COD refund.
create or replace function public.velura_return_refund_receiver_ready(p_return_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce((select public.velura_refund_receiver_valid(bank_name, account_number, account_holder)
      and nullif(btrim(coalesce(supplement_request, '')), '') is null
    from public.return_refund_receiver where return_id = p_return_id), false);
$$;
revoke all on function public.velura_return_refund_receiver_ready(uuid) from public, anon, authenticated;
grant execute on function public.velura_return_refund_receiver_ready(uuid) to service_role;

-- DB guard: no code path (Stripe RPC, manual RPC, direct update) may enter REFUND_PROCESSING for a COD return
-- without usable receiving information.
create or replace function public.velura_return_refund_receiver_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.status::text = 'REFUND_PROCESSING' and old.status::text is distinct from 'REFUND_PROCESSING'
    and public.velura_return_requires_refund_receiver(new.return_id)
    and not public.velura_return_refund_receiver_ready(new.return_id) then
    raise sqlstate 'PT422' using message = 'REFUND_RECEIVER_REQUIRED';
  end if;
  return new;
end; $$;
drop trigger if exists return_refund_receiver_guard on public.return_exchange;
create trigger return_refund_receiver_guard before update of status on public.return_exchange
  for each row execute function public.velura_return_refund_receiver_guard();

-- Customer (member or already-verified guest) saves or replaces the receiving account.
create or replace function public.velura_set_return_refund_receiver(
  p_return_id uuid, p_owner_user_id uuid, p_bank_name text, p_account_number text, p_account_holder text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_return public.return_exchange%rowtype; v_bank text; v_account text; v_holder text; v_row public.return_refund_receiver%rowtype;
begin
  select * into v_return from public.return_exchange where return_id = p_return_id for update;
  if not found or (p_owner_user_id is not null and v_return.user_id is distinct from p_owner_user_id) then
    raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  if not public.velura_return_requires_refund_receiver(p_return_id) then
    raise sqlstate 'PT422' using message = 'REFUND_RECEIVER_NOT_APPLICABLE'; end if;
  if v_return.status::text in ('REFUNDED', 'COMPLETED', 'CANCELLED') then
    raise sqlstate 'PT422' using message = 'RETURN_CLOSED'; end if;
  v_bank := btrim(coalesce(p_bank_name, ''));
  v_account := regexp_replace(coalesce(p_account_number, ''), '[\s-]', '', 'g');
  v_holder := regexp_replace(btrim(coalesce(p_account_holder, '')), '\s+', ' ', 'g');
  if not public.velura_refund_receiver_valid(v_bank, v_account, v_holder) then
    raise sqlstate 'PT422' using message = 'REFUND_RECEIVER_INVALID'; end if;
  insert into public.return_refund_receiver(return_id, bank_name, account_number, account_holder, submitted_at, supplement_request, updated_at)
    values(p_return_id, v_bank, v_account, v_holder, now(), null, now())
    on conflict (return_id) do update set bank_name = excluded.bank_name, account_number = excluded.account_number,
      account_holder = excluded.account_holder, submitted_at = excluded.submitted_at, supplement_request = null, updated_at = now()
    returning * into v_row;
  insert into public.return_event(return_id, old_status, new_status, actor_id, actor_type, note)
    values(p_return_id, v_return.status::text, v_return.status::text, p_owner_user_id, 'customer',
      'Khách cập nhật thông tin nhận hoàn tiền: ' || v_bank || ' ••••' || right(v_account, 4));
  return jsonb_build_object('return_id', p_return_id, 'status', 'valid', 'bank_name', v_row.bank_name,
    'account_last4', right(v_row.account_number, 4), 'account_holder', v_row.account_holder, 'submitted_at', v_row.submitted_at,
    'supplement_request', null, 'supplement_requested_at', v_row.supplement_requested_at);
end; $$;
revoke all on function public.velura_set_return_refund_receiver(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.velura_set_return_refund_receiver(uuid, uuid, text, text, text) to service_role;

-- CSKH asks for a supplement. The return keeps its status and version; the refund stays blocked until the customer answers.
create or replace function public.velura_request_refund_receiver_supplement(
  p_return_id uuid, p_expected_version integer, p_message text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_return public.return_exchange%rowtype; v_message text := btrim(coalesce(p_message, '')); v_row public.return_refund_receiver%rowtype;
begin
  select * into v_return from public.return_exchange where return_id = p_return_id for update;
  if not found then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  if p_expected_version is null or v_return.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if not public.velura_return_requires_refund_receiver(p_return_id) then
    raise sqlstate 'PT422' using message = 'REFUND_RECEIVER_NOT_APPLICABLE'; end if;
  if v_return.status::text in ('REFUNDED', 'COMPLETED', 'CANCELLED') then
    raise sqlstate 'PT422' using message = 'RETURN_CLOSED'; end if;
  if length(v_message) < 10 then raise sqlstate 'PT422' using message = 'SUPPLEMENT_MESSAGE_REQUIRED'; end if;
  insert into public.return_refund_receiver(return_id, supplement_request, supplement_requested_at, supplement_requested_by, updated_at)
    values(p_return_id, v_message, now(), p_actor_id, now())
    on conflict (return_id) do update set supplement_request = excluded.supplement_request,
      supplement_requested_at = excluded.supplement_requested_at, supplement_requested_by = excluded.supplement_requested_by, updated_at = now()
    returning * into v_row;
  insert into public.return_event(return_id, old_status, new_status, actor_id, actor_type, note)
    values(p_return_id, v_return.status::text, v_return.status::text, p_actor_id, 'admin', 'CSKH yêu cầu bổ sung thông tin nhận hoàn tiền: ' || v_message);
  insert into public.audit_log(actor_id, actor_role, action, module, target_id, new_value, ip_address, timestamp)
    values(p_actor_id, 'admin_operator_cskh_dt', 'update', 'returns', p_return_id,
      jsonb_build_object('refund_receiver_supplement', v_message), '127.0.0.1', now());
  return jsonb_build_object('return_id', p_return_id, 'supplement_request', v_row.supplement_request,
    'supplement_requested_at', v_row.supplement_requested_at);
end; $$;
revoke all on function public.velura_request_refund_receiver_supplement(uuid, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.velura_request_refund_receiver_supplement(uuid, integer, text, uuid) to service_role;

-- Replaces the 045 five-argument function, which skipped the receiver check and stored no amount/time.
drop function if exists public.velura_record_manual_return_refund(uuid, integer, text, text, uuid);
create or replace function public.velura_record_manual_return_refund(
  p_return_id uuid, p_expected_version integer, p_reference text, p_amount numeric, p_transferred_at timestamptz,
  p_proof text, p_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_return public.return_exchange%rowtype; v_payment public.payment%rowtype; v_operation jsonb; v_refund public.payment_refund%rowtype;
  v_receiver public.return_refund_receiver%rowtype; v_requires boolean; v_reference text := btrim(coalesce(p_reference, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_final public.return_exchange%rowtype;
begin
  if length(v_reference) < 6 then raise sqlstate 'PT422' using message = 'TRANSFER_REFERENCE_REQUIRED'; end if;
  if p_proof is null or (p_proof not like 'https://%' and p_proof not like 'http://%' and p_proof not like 'data:image/%') then
    raise sqlstate 'PT422' using message = 'TRANSFER_PROOF_REQUIRED'; end if;
  select * into v_return from public.return_exchange where return_id = p_return_id for update;
  if not found then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  if p_transferred_at is null or p_transferred_at > now() + interval '5 minutes' or p_transferred_at < v_return.created_at then
    raise sqlstate 'PT422' using message = 'TRANSFER_TIME_INVALID'; end if;
  if v_return.return_type::text <> 'refund' or v_return.status::text not in ('RECEIVED', 'REFUND_PROCESSING')
    or v_return.condition_check_result::text <> 'qa_pass' then raise sqlstate 'PT422' using message = 'WAREHOUSE_QA_REQUIRED'; end if;
  select * into v_payment from public.payment where order_id = v_return.order_id
    and payment_status::text in ('paid', 'refund_pending') order by created_at desc limit 1;
  if not found or v_payment.payment_provider = 'stripe' then raise sqlstate 'PT422' using message = 'CAPTURED_NON_STRIPE_REQUIRED'; end if;
  v_requires := public.velura_return_requires_refund_receiver(p_return_id);
  if v_requires then
    if not public.velura_return_refund_receiver_ready(p_return_id) then raise sqlstate 'PT422' using message = 'REFUND_RECEIVER_REQUIRED'; end if;
    select * into v_receiver from public.return_refund_receiver where return_id = p_return_id;
  end if;
  if exists(select 1 from public.payment_refund where provider_ref = 'manual:' || v_reference and return_id <> p_return_id)
    or exists(select 1 from public.return_manual_refund where upper(btrim(reference)) = upper(v_reference) and return_id <> p_return_id) then
    raise sqlstate 'PT409' using message = 'DUPLICATE_TRANSFER_REFERENCE'; end if;
  perform set_config('app.return_actor_type', 'admin', true);
  v_operation := public.velura_prepare_return_refund(p_return_id, v_return.order_id, p_expected_version);
  if p_amount is null or p_amount <> (v_operation->>'amount')::numeric then raise sqlstate 'PT422' using message = 'REFUND_AMOUNT_MISMATCH'; end if;
  perform public.velura_complete_return_refund(p_return_id, 'manual:' || v_reference);
  select * into v_refund from public.payment_refund where return_id = p_return_id;
  insert into public.return_manual_refund(return_id, refund_id, payment_kind, reference, amount, transferred_at,
      receiver_bank_name, receiver_account_number, receiver_account_holder, proof, note, recorded_by)
    values(p_return_id, v_refund.refund_id, case when v_requires then 'cod' else 'other_online' end, v_reference, v_refund.amount,
      p_transferred_at, v_receiver.bank_name, v_receiver.account_number, v_receiver.account_holder, p_proof, v_note, p_actor_id);
  -- The manual transfer is the single confirmation: no second approval step, the request closes with the recorded result.
  update public.return_exchange set status = 'COMPLETED', version = version + 1, updated_at = now(),
    admin_note = case when v_note is null then admin_note else concat_ws(E'\n', nullif(admin_note, ''),
      '[Hoàn tiền thủ công ' || v_reference || '] ' || v_note) end
    where return_id = p_return_id and status::text = 'REFUNDED' returning * into v_final;
  insert into public.audit_log(actor_id, actor_role, action, module, target_id, new_value, ip_address, timestamp)
    values(p_actor_id, 'admin_operator_cskh_dt', 'update', 'returns', p_return_id,
      jsonb_build_object('transfer_reference', v_reference, 'amount', v_refund.amount, 'transferred_at', p_transferred_at,
        'transfer_proof', p_proof, 'refund', v_operation), '127.0.0.1', now());
  return to_jsonb(v_final);
end; $$;
revoke all on function public.velura_record_manual_return_refund(uuid, integer, text, numeric, timestamptz, text, text, uuid) from public, anon, authenticated;
grant execute on function public.velura_record_manual_return_refund(uuid, integer, text, numeric, timestamptz, text, text, uuid) to service_role;

commit;
