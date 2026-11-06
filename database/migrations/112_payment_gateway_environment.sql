-- KAN-106: VNPay/MoMo chạy được thật mà vẫn an toàn tiền, nhờ phân biệt sandbox/production NGAY TRONG DỮ LIỆU.
--
-- Vì sao: cổng cũ (`localGatewayConfigured`) tắt hai nhà mạng này ở production với lý do đúng —
-- một callback sandbox có thể đánh dấu đơn thật đã thu tiền. Tắt thì không vận hành được, bật thì
-- không an toàn. Cách giải quyết là ghi môi trường của TỪNG phiên thanh toán và chỉ cho callback/verify/
-- refund khớp với môi trường của chính phiên đó; sandbox không còn cách nào để đụng đơn của production.
--
-- 048 là bản đang chạy; hai hàm được drop rồi tạo lại với tham số môi trường để PostgREST chỉ còn
-- một signature, không có đường gọi cũ bỏ trống environment.
begin;

alter table public.payment
  add column if not exists gateway_environment text not null default 'production'
  check (gateway_environment in ('sandbox', 'production'));

-- Phiên đang mở theo nhà mạng + môi trường, để đối soát không đọc lẫn giữa sandbox và production.
create index if not exists payment_gateway_attempt_lookup
  on public.payment (payment_provider, gateway_environment, gateway_session_id)
  where payment_provider in ('vnpay', 'momo') and gateway_session_id is not null;

drop function if exists public.velura_begin_gateway_attempt(uuid, text);
create or replace function public.velura_begin_gateway_attempt(
  p_order_id uuid,
  p_provider text,
  p_environment text default 'production'
)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare v_order public.orders%rowtype; v_payment public.payment%rowtype;
begin
  if p_provider not in ('vnpay','momo') then raise exception 'PAYMENT_PROVIDER_INVALID'; end if;
  if p_environment not in ('sandbox','production') then raise exception 'PAYMENT_ENVIRONMENT_INVALID'; end if;
  select * into v_order from public.orders where order_id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status::text<>'waiting_payment' or v_order.payment_method::text<>'ONLINE_PAYMENT'
     or v_order.created_at < now()-interval '24 hours' then raise exception 'PAY_AGAIN_NOT_ALLOWED'; end if;
  if exists(select 1 from public.payment where order_id=p_order_id and payment_status::text in ('paid','refund_pending','refunded')) then
    raise exception 'ORDER_ALREADY_CAPTURED';
  end if;
  select * into v_payment from public.payment where order_id=p_order_id and payment_status::text='pending'
    and coalesce(gateway_expires_at,created_at+interval '31 minutes')>now()
    and gateway_session_id is not null
    and (payment_provider='stripe' or payment_provider=p_provider)
    order by created_at desc limit 1;
  if found then
    if v_payment.payment_provider=p_provider then
      -- Đổi môi trường giữa chừng là đổi tiền: đơn đang có phiên sandbox thì production không được
      -- mở song song, và ngược lại. Khách muốn đổi kênh phải chờ phiên cũ hết hạn.
      if v_payment.payment_provider<>'stripe' and v_payment.gateway_environment<>p_environment then
        raise exception 'PAYMENT_SESSION_ENVIRONMENT_MISMATCH';
      end if;
      return to_jsonb(v_payment);
    end if;
    raise exception 'PAYMENT_SESSION_OPEN';
  end if;
  if v_order.total_amount<=0 or v_order.total_amount<>trunc(v_order.total_amount) then raise exception 'INVALID_PAYMENT_AMOUNT'; end if;
  insert into public.payment(order_id,amount,payment_method,payment_provider,payment_status,gateway_session_id,gateway_expires_at,gateway_environment)
    values(p_order_id,v_order.total_amount,'ONLINE_PAYMENT',p_provider,'pending',replace(gen_random_uuid()::text,'-',''),now()+interval '15 minutes',p_environment)
    returning * into v_payment;
  return to_jsonb(v_payment);
end; $$;

drop function if exists public.velura_reconcile_gateway_attempt(text, text, numeric, text, boolean, text);
create or replace function public.velura_reconcile_gateway_attempt(
  p_provider text,
  p_reference text,
  p_amount numeric,
  p_transaction text,
  p_success boolean,
  p_response_code text,
  p_environment text default 'production'
)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare v_payment public.payment%rowtype; v_order public.orders%rowtype; v_status text;
begin
  if p_provider not in ('vnpay','momo') then raise exception 'PAYMENT_PROVIDER_INVALID'; end if;
  if p_environment not in ('sandbox','production') then raise exception 'PAYMENT_ENVIRONMENT_INVALID'; end if;
  select * into v_payment from public.payment where payment_provider=p_provider and gateway_session_id=p_reference;
  if not found then return jsonb_build_object('code','01','message','Order not found'); end if;
  -- Chặn ở đây trước mọi cập nhật: callback sandbox chỉ được nói về phiên sandbox.
  if v_payment.gateway_environment<>p_environment then
    return jsonb_build_object('code','07','message','Environment mismatch');
  end if;
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
      p_provider||' '||p_environment||' verified capture',jsonb_build_object('payment_id',v_payment.payment_id,'provider',p_provider,'environment',p_environment,'transaction',p_transaction),null);
  end if;
  return jsonb_build_object('code','00','message','Capture recorded','payment_status',v_status);
end; $$;

revoke all on function public.velura_begin_gateway_attempt(uuid,text,text) from public,anon,authenticated;
revoke all on function public.velura_reconcile_gateway_attempt(text,text,numeric,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.velura_begin_gateway_attempt(uuid,text,text) to service_role;
grant execute on function public.velura_reconcile_gateway_attempt(text,text,numeric,text,boolean,text,text) to service_role;

notify pgrst, 'reload schema';
commit;
