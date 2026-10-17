-- KAN-58: real VNPay/MoMo attempts use the existing payment/order/stock state machine.
alter table public.payment add column if not exists gateway_checkout_url text;
alter table public.payment add column if not exists gateway_expires_at timestamptz;
create unique index if not exists payment_local_merchant_reference_unique on public.payment(payment_provider,gateway_session_id)
  where payment_provider in ('vnpay','momo') and gateway_session_id is not null;

create or replace function public.velura_begin_gateway_attempt(p_order_id uuid,p_provider text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_order public.orders%rowtype; v_payment public.payment%rowtype;
begin
  if p_provider not in ('vnpay','momo') then raise exception 'PAYMENT_PROVIDER_INVALID'; end if;
  select * into v_order from public.orders where order_id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status::text<>'waiting_payment' or v_order.payment_method::text<>'ONLINE_PAYMENT'
    or v_order.created_at < now()-interval '24 hours' then raise exception 'PAY_AGAIN_NOT_ALLOWED'; end if;
  if exists(select 1 from public.payment where order_id=p_order_id and payment_status::text in ('paid','refund_pending','refunded')) then
    raise exception 'ORDER_ALREADY_CAPTURED';
  end if;
  select * into v_payment from public.payment where order_id=p_order_id and payment_status::text='pending'
    and coalesce(gateway_expires_at,created_at+interval '31 minutes')>now()
    and (gateway_session_id is not null or payment_provider='stripe') order by created_at desc limit 1;
  if found then
    if v_payment.payment_provider=p_provider then return to_jsonb(v_payment); end if;
    raise exception 'PAYMENT_SESSION_OPEN';
  end if;
  if v_order.total_amount<=0 or v_order.total_amount<>trunc(v_order.total_amount) then raise exception 'INVALID_PAYMENT_AMOUNT'; end if;
  insert into public.payment(order_id,amount,payment_method,payment_provider,payment_status,gateway_session_id,gateway_expires_at)
    values(p_order_id,v_order.total_amount,'ONLINE_PAYMENT',p_provider,'pending',replace(gen_random_uuid()::text,'-',''),now()+interval '15 minutes')
    returning * into v_payment;
  return to_jsonb(v_payment);
end; $$;

create or replace function public.velura_reconcile_gateway_attempt(
  p_provider text,p_reference text,p_amount numeric,p_transaction text,p_success boolean,p_response_code text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_payment public.payment%rowtype; v_order public.orders%rowtype; v_status text;
begin
  if p_provider not in ('vnpay','momo') then raise exception 'PAYMENT_PROVIDER_INVALID'; end if;
  select * into v_payment from public.payment where payment_provider=p_provider and gateway_session_id=p_reference;
  if not found then return jsonb_build_object('code','01','message','Order not found'); end if;
  select * into v_order from public.orders where order_id=v_payment.order_id for update;
  select * into v_payment from public.payment where payment_id=v_payment.payment_id for update;
  if p_amount<=0 or p_amount<>trunc(p_amount) or p_amount<>v_payment.amount or p_amount<>v_order.total_amount then
    return jsonb_build_object('code','04','message','Invalid amount');
  end if;
  if v_payment.payment_status::text in ('paid','refund_pending','refunded') then
    if p_success and v_payment.gateway_transaction_ref is distinct from p_transaction then
      return jsonb_build_object('code','04','message','Transaction mismatch');
    end if;
    return jsonb_build_object('code','02','message','Already confirmed');
  end if;
  if not p_success then
    update public.payment set payment_status='failed',gateway_response_code=p_response_code where payment_id=v_payment.payment_id;
    return jsonb_build_object('code','00','message','Failure recorded');
  end if;
  if coalesce(p_transaction,'') in ('','0') then return jsonb_build_object('code','04','message','Invalid transaction'); end if;
  -- Late success is still real money. Do not resurrect a cancelled order or deduct stock twice.
  v_status := case when v_order.status::text<>'waiting_payment'
      or exists(select 1 from public.payment where order_id=v_order.order_id and payment_id<>v_payment.payment_id
        and payment_status::text in ('paid','refund_pending','refunded')) then 'refund_pending' else 'paid' end;
  update public.payment set payment_status=v_status::public.payment_status,paid_at=now(),gateway_transaction_ref=p_transaction,
    gateway_response_code=p_response_code,refund_amount=case when v_status='refund_pending' then amount else refund_amount end,
    refund_reason=case when v_status='refund_pending' then 'Late or duplicate gateway capture requires reconciliation' else refund_reason end
    where payment_id=v_payment.payment_id;
  if v_status='paid' then
    perform public.velura_order_service_action(v_order.order_id,'payment_succeeded',null,
      p_provider||' verified capture',jsonb_build_object('payment_id',v_payment.payment_id,'provider',p_provider,'transaction',p_transaction),null);
  end if;
  return jsonb_build_object('code','00','message','Capture recorded','payment_status',v_status);
end; $$;

revoke all on function public.velura_begin_gateway_attempt(uuid,text) from public,anon,authenticated;
revoke all on function public.velura_reconcile_gateway_attempt(text,text,numeric,text,boolean,text) from public,anon,authenticated;
grant execute on function public.velura_begin_gateway_attempt(uuid,text) to service_role;
grant execute on function public.velura_reconcile_gateway_attempt(text,text,numeric,text,boolean,text) to service_role;
-- Trigger-only security definers are not public RPC entry points.
revoke all on function public.velura_return_workflow_guard() from public,anon,authenticated;
revoke all on function public.velura_log_return_transition() from public,anon,authenticated;
grant execute on function public.velura_return_workflow_guard() to service_role;
grant execute on function public.velura_log_return_transition() to service_role;
