-- KAN-58: a refund belongs to one QA-approved return and consumes only captured net money.
create table if not exists public.payment_refund (
  refund_id uuid primary key default gen_random_uuid(),
  return_id uuid not null unique references public.return_exchange(return_id),
  payment_id uuid not null references public.payment(payment_id),
  amount numeric not null check (amount > 0),
  status text not null default 'requested' check(status in ('requested', 'pending', 'succeeded', 'failed')),
  provider_ref text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.payment_refund enable row level security;
revoke all on public.payment_refund from anon, authenticated;
grant select on public.payment_refund to authenticated;
grant all on public.payment_refund to service_role;
create policy payment_refund_admin_read on public.payment_refund for select to authenticated using (
  (select public.velura_has_admin_role(array['super_admin', 'admin_operator_donhang', 'admin_operator_cskh_dt']))
);

create or replace function public.velura_return_refundable_amount(p_return_id uuid)
returns numeric language sql stable security invoker set search_path = pg_catalog, public, auth as $$
  select coalesce((select amount from public.payment_refund where return_id = p_return_id),
    (select greatest(0, least(
      coalesce(sum(floor(oi.unit_price * ri.quantity * case when o.subtotal > 0 then
        greatest(0, o.subtotal - case when v.discount_type::text = 'free_shipping' then 0 else o.discount_amount end) / o.subtotal
        else 0 end)), 0),
      coalesce((select sum(greatest(0, p.amount - p.refunded_amount)) from public.payment p
        where p.order_id = o.order_id and p.payment_status::text in ('paid', 'refund_pending', 'refunded')), 0)
    ))
    from public.return_exchange r join public.orders o on o.order_id = r.order_id
      left join public.voucher v on v.voucher_id = o.voucher_id
      join public.return_item ri on ri.return_id = r.return_id
      join public.order_item oi on oi.item_id = ri.order_item_id
    where r.return_id = p_return_id group by o.order_id), 0);
$$;
revoke all on function public.velura_return_refundable_amount(uuid) from public, anon;
grant execute on function public.velura_return_refundable_amount(uuid) to authenticated, service_role;

create or replace function public.velura_prepare_return_refund(p_return_id uuid, p_order_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_ret public.return_exchange%rowtype; v_payment public.payment%rowtype;
  v_refund public.payment_refund%rowtype; v_amount numeric; v_reserved numeric;
begin
  perform 1 from public.orders where order_id = p_order_id for update;
  select * into v_ret from public.return_exchange where return_id = p_return_id and order_id = p_order_id for update;
  if not found then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  select * into v_refund from public.payment_refund where return_id = p_return_id;
  if found and v_refund.status = 'succeeded' then return to_jsonb(v_refund); end if;
  if p_expected_version is null or v_ret.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_ret.status::text <> 'received' or v_ret.condition_check_result <> 'qa_pass' or v_ret.return_type::text <> 'refund' then
    raise sqlstate 'PT422' using message = 'QA_REQUIRED';
  end if;
  if v_refund.refund_id is not null then return to_jsonb(v_refund); end if;
  select * into v_payment from public.payment where order_id = p_order_id and payment_provider = 'stripe'
    and payment_status::text in ('paid', 'refund_pending') order by created_at desc limit 1 for update;
  if not found then raise sqlstate 'PT422' using message = 'CAPTURED_PAYMENT_REQUIRED'; end if;
  v_amount := public.velura_return_refundable_amount(p_return_id);
  select coalesce(sum(amount), 0) into v_reserved from public.payment_refund
    where payment_id = v_payment.payment_id and status in ('requested', 'pending', 'failed');
  v_amount := least(v_amount, v_payment.amount - v_payment.refunded_amount - v_reserved);
  if v_amount <= 0 then raise sqlstate 'PT422' using message = 'REFUND_BALANCE_EXHAUSTED'; end if;
  insert into public.payment_refund(return_id, payment_id, amount) values(p_return_id, v_payment.payment_id, v_amount)
    returning * into v_refund;
  update public.payment set payment_status = 'refund_pending', refund_amount = v_amount,
    gateway_response_code = 'REFUND_REQUESTED', version = version + 1, updated_at = now()
    where payment_id = v_payment.payment_id;
  return to_jsonb(v_refund);
end; $$;
revoke all on function public.velura_prepare_return_refund(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.velura_prepare_return_refund(uuid, uuid, integer) to service_role;

create or replace function public.velura_complete_return_refund(p_return_id uuid, p_provider_ref text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_refund public.payment_refund%rowtype; v_order_id uuid; v_sum numeric; v_pending numeric;
begin
  select order_id into v_order_id from public.return_exchange where return_id = p_return_id;
  perform 1 from public.orders where order_id = v_order_id for update;
  select * into v_refund from public.payment_refund where return_id = p_return_id for update;
  if not found then raise sqlstate 'PT404' using message = 'REFUND_NOT_FOUND'; end if;
  if v_refund.status = 'succeeded' then return to_jsonb(v_refund); end if;
  update public.payment_refund set status = 'succeeded', provider_ref = p_provider_ref, updated_at = now()
    where refund_id = v_refund.refund_id returning * into v_refund;
  select coalesce(sum(amount) filter(where status = 'succeeded'), 0),
    coalesce(sum(amount) filter(where status in ('requested', 'pending', 'failed')), 0)
    into v_sum, v_pending from public.payment_refund where payment_id = v_refund.payment_id;
  update public.payment set refunded_amount = greatest(refunded_amount, v_sum),
    refund_amount = v_sum + v_pending, refund_at = now(),
    payment_status = (case when v_sum >= amount then 'refunded' when v_pending > 0 then 'refund_pending' else 'paid' end)::public.payment_status,
    gateway_response_code = 'REFUNDED', version = version + 1, updated_at = now() where payment_id = v_refund.payment_id;
  update public.return_exchange set status = 'completed', refund_amount = v_refund.amount, resolved_at = now(),
    version = version + 1, updated_at = now() where return_id = p_return_id and status::text = 'received';
  insert into public.order_event(order_id, action, actor_type, result, note, payload)
    values(v_order_id, 'stripe_refund_succeeded', 'system', 'success', 'Stripe confirmed returned item refund',
      jsonb_build_object('return_id', p_return_id, 'amount', v_refund.amount, 'provider_ref', p_provider_ref));
  return to_jsonb(v_refund);
end; $$;
revoke all on function public.velura_complete_return_refund(uuid, text) from public, anon, authenticated;
grant execute on function public.velura_complete_return_refund(uuid, text) to service_role;

create or replace function public.velura_guard_refunding_return()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.status::text = 'rejected' and exists(select 1 from public.payment_refund where return_id = new.return_id) then
    raise sqlstate 'PT409' using message = 'REFUND_ALREADY_REQUESTED';
  end if;
  return new;
end; $$;
create trigger return_refund_state_guard before update of status on public.return_exchange
  for each row execute function public.velura_guard_refunding_return();
