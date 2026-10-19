-- Disposable/local database only, after migrations 068 and 069. Every mutation rolls back.
-- KAN-105 3.1.12: quota release on cancel/reject, COD receiving-account block, manual refund reconciliation.
\set ON_ERROR_STOP on
begin;
-- Fixtures bypass FK/trigger checks so they can place a return in any state; the assertions run with triggers on.
set local session_replication_role = replica;

insert into public.orders(order_id,user_id,order_code,status,shipping_name,shipping_phone,shipping_address,subtotal,total_amount,payment_method,delivered_at) values
('91000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-0000000000a1','T-COD','delivered','Khach COD','0900000001','HN',600000,600000,'COD',now()-interval '1 day'),
('91000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-0000000000a1','T-STRIPE','delivered','Khach Stripe','0900000001','HN',300000,300000,'ONLINE_PAYMENT',now()-interval '1 day');
insert into public.order_item(item_id,order_id,variant_id,product_name,quantity,unit_price,subtotal_item) values
('91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-0000000000f1','Ao COD',3,200000,600000),
('91000000-0000-4000-8000-000000000012','91000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-0000000000f2','Ao Stripe',1,300000,300000);
insert into public.payment(payment_id,order_id,payment_method,payment_provider,amount,payment_status) values
('91000000-0000-4000-8000-000000000021','91000000-0000-4000-8000-000000000001','COD','cod',600000,'paid'),
('91000000-0000-4000-8000-000000000022','91000000-0000-4000-8000-000000000002','ONLINE_PAYMENT','stripe',300000,'paid');
-- r1: already succeeded (1 unit, COMPLETED). r2: stuck NEEDS_SUPPORT (1 unit). r3: COD refund RECEIVED + QA pass (1 unit) used for the receiver tests.
insert into public.return_exchange(return_id,order_id,user_id,return_type,status,condition_check_result,tracking_return_code,refund_amount,created_at,version) values
('91000000-0000-4000-8000-000000000101','91000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-0000000000a1','refund','COMPLETED','qa_pass','RET-DONE',200000,now()-interval '20 hours',5),
('91000000-0000-4000-8000-000000000102','91000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-0000000000a1','refund','NEEDS_SUPPORT','qa_fail','RET-STUCK',200000,now()-interval '10 hours',4),
('91000000-0000-4000-8000-000000000103','91000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-0000000000a1','refund','RECEIVED','qa_pass','RET-STRIPE',300000,now()-interval '10 hours',4);
insert into public.return_item(return_id,order_item_id,quantity) values
('91000000-0000-4000-8000-000000000101','91000000-0000-4000-8000-000000000011',1),
('91000000-0000-4000-8000-000000000102','91000000-0000-4000-8000-000000000011',1),
('91000000-0000-4000-8000-000000000103','91000000-0000-4000-8000-000000000012',1);
set local session_replication_role = origin;

do $$
declare
  v_item uuid := '91000000-0000-4000-8000-000000000011';
  v_stuck uuid := '91000000-0000-4000-8000-000000000102';
  v_holds record; v_row public.return_exchange%rowtype; v_message text;
begin
  -- 1. A request stuck in NEEDS_SUPPORT holds its unit and blocks a new request on the same line.
  select * into v_holds from public.velura_return_item_holds(v_item);
  if v_holds.attempts <> 2 or v_holds.held_quantity <> 2 or v_holds.succeeded_quantity <> 1 or v_holds.open_requests <> 1 then
    raise exception 'Open + succeeded holds must both count, got %', to_jsonb(v_holds); end if;
  begin
    perform public.velura_create_return_request(jsonb_build_object('order_id','91000000-0000-4000-8000-000000000001','user_id','91000000-0000-4000-8000-0000000000a1','return_type','refund'),
      jsonb_build_array(jsonb_build_object('order_item_id',v_item,'quantity',1)));
    raise exception 'A line with an open request accepted another request';
  exception when sqlstate 'PT422' then
    get stacked diagnostics v_message = message_text;
    if v_message <> 'ITEM_RETURN_IN_PROGRESS' then raise exception 'Expected ITEM_RETURN_IN_PROGRESS, got %', v_message; end if;
  end;

  -- 2. Closing needs a reason (the customer is told why).
  begin
    update public.return_exchange set status = 'CANCELLED', version = version + 1 where return_id = v_stuck;
    raise exception 'A cancellation without a reason was accepted';
  exception when sqlstate 'PT422' then
    get stacked diagnostics v_message = message_text;
    if v_message <> 'CANCEL_REASON_REQUIRED' then raise exception 'Expected CANCEL_REASON_REQUIRED, got %', v_message; end if;
  end;

  -- 3. CSKH stops forwarding the stuck request: NEEDS_SUPPORT -> CANCELLED is a legal transition, owned by admin, no leftover refund amount.
  update public.return_exchange set status = 'CANCELLED', rejection_reason = 'Hang khong dat QA, CSKH tu choi yeu cau', cancelled_by = 'admin', version = version + 1
    where return_id = v_stuck returning * into v_row;
  if v_row.cancelled_by <> 'admin' or v_row.refund_amount is not null or v_row.resolved_at is null then
    raise exception 'Cancellation must record owner, clear the approved amount and stamp resolution: %', to_jsonb(v_row); end if;

  -- 4. The hold is released, the succeeded part is untouched, and the released unit can be requested again.
  select * into v_holds from public.velura_return_item_holds(v_item);
  if v_holds.attempts <> 1 or v_holds.held_quantity <> 1 or v_holds.succeeded_quantity <> 1 or v_holds.open_requests <> 0 then
    raise exception 'Cancelled request must release its hold and leave the succeeded one: %', to_jsonb(v_holds); end if;
  perform public.velura_create_return_request(jsonb_build_object('order_id','91000000-0000-4000-8000-000000000001','user_id','91000000-0000-4000-8000-0000000000a1','return_type','refund'),
    jsonb_build_array(jsonb_build_object('order_item_id',v_item,'quantity',2)));
  if (select status from public.return_exchange where return_id = '91000000-0000-4000-8000-000000000101')::text <> 'COMPLETED' then
    raise exception 'The already-succeeded request was modified'; end if;
  -- ... but a request beyond the remaining quantity is still refused.
  select * into v_holds from public.velura_return_item_holds(v_item);
  if v_holds.held_quantity <> 3 then raise exception 'Re-request must hold 1 succeeded + 2 open units, got %', v_holds.held_quantity; end if;

  -- 5. A customer cancel is distinguishable from an admin rejection.
  perform set_config('app.return_actor_type','customer',true);
  update public.return_exchange set status = 'CANCELLED', rejection_reason = 'Da huy boi khach hang', version = version + 1
    where return_id = (select return_id from public.return_exchange where order_id = '91000000-0000-4000-8000-000000000001' and status::text = 'REQUESTED') returning * into v_row;
  if v_row.cancelled_by <> 'customer' then raise exception 'Customer cancellation lost its owner: %', v_row.cancelled_by; end if;
  perform set_config('app.return_actor_type','',true);
end $$;

-- COD receiver tests. r4 is a fresh COD refund in RECEIVED + qa_pass with one unit.
set local session_replication_role = replica;
insert into public.return_exchange(return_id,order_id,user_id,return_type,status,condition_check_result,tracking_return_code,created_at,version) values
('91000000-0000-4000-8000-000000000104','91000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-0000000000a1','refund','RECEIVED','qa_pass','RET-COD',now()-interval '5 hours',7);
insert into public.return_item(return_id,order_item_id,quantity) values ('91000000-0000-4000-8000-000000000104','91000000-0000-4000-8000-000000000011',1);
set local session_replication_role = origin;

do $$
declare
  v_cod uuid := '91000000-0000-4000-8000-000000000104';
  v_stripe uuid := '91000000-0000-4000-8000-000000000103';
  v_user uuid := '91000000-0000-4000-8000-0000000000a1';
  v_actor uuid := '91000000-0000-4000-8000-0000000000b1';
  v_version integer; v_message text; v_result jsonb; v_manual public.return_manual_refund%rowtype;
begin
  select version into v_version from public.return_exchange where return_id = v_cod;

  -- 1. No receiving account at all: the manual refund and the direct stage change are both refused (server-side, not UI).
  begin
    perform public.velura_record_manual_return_refund(v_cod, v_version, 'VCB-0001', 200000, now(), 'https://proof.example/1.png', null, v_actor);
    raise exception 'COD refund continued without a receiving account';
  exception when sqlstate 'PT422' then
    get stacked diagnostics v_message = message_text;
    if v_message <> 'REFUND_RECEIVER_REQUIRED' then raise exception 'Expected REFUND_RECEIVER_REQUIRED, got %', v_message; end if;
  end;
  begin
    perform public.velura_prepare_return_refund(v_cod, '91000000-0000-4000-8000-000000000001', v_version);
    raise exception 'The refund stage was entered for a COD return without a receiving account';
  exception when sqlstate 'PT422' then
    get stacked diagnostics v_message = message_text;
    if v_message <> 'REFUND_RECEIVER_REQUIRED' then raise exception 'Expected REFUND_RECEIVER_REQUIRED from the stage guard, got %', v_message; end if;
  end;
  if (select status::text from public.return_exchange where return_id = v_cod) <> 'RECEIVED'
    or exists(select 1 from public.payment_refund where return_id = v_cod) then
    raise exception 'A blocked refund left partial writes'; end if;

  -- 2. Invalid account data is rejected by the customer RPC and stores nothing.
  begin
    perform public.velura_set_return_refund_receiver(v_cod, v_user, 'Vietcombank', '12ab', 'Nguyen Van A');
    raise exception 'Invalid account number accepted';
  exception when sqlstate 'PT422' then
    get stacked diagnostics v_message = message_text;
    if v_message <> 'REFUND_RECEIVER_INVALID' then raise exception 'Expected REFUND_RECEIVER_INVALID, got %', v_message; end if;
  end;
  begin
    perform public.velura_set_return_refund_receiver(v_cod, v_user, 'Vietcombank', '0123456789', 'Nguyen Van 9');
    raise exception 'Holder name with digits accepted';
  exception when sqlstate 'PT422' then null; end;
  begin
    perform public.velura_set_return_refund_receiver(v_cod, '91000000-0000-4000-8000-0000000000a2', 'Vietcombank', '0123456789', 'Nguyen Van A');
    raise exception 'Another customer saved an account on this return';
  exception when sqlstate 'PT404' then null; end;
  if exists(select 1 from public.return_refund_receiver where return_id = v_cod and account_number is not null) then
    raise exception 'Rejected input was stored'; end if;

  -- 3. CSKH asks for a supplement: the stage and version do not move, the message is stored and the refund stays blocked.
  v_result := public.velura_request_refund_receiver_supplement(v_cod, v_version, 'Vui long gui so tai khoan nhan hoan tien', v_actor);
  if (select status::text from public.return_exchange where return_id = v_cod) <> 'RECEIVED'
    or (select version from public.return_exchange where return_id = v_cod) <> v_version then
    raise exception 'The supplement request moved the refund stage or the version'; end if;
  if (select supplement_request from public.return_refund_receiver where return_id = v_cod) <> 'Vui long gui so tai khoan nhan hoan tien' then
    raise exception 'The CSKH supplement message was not stored'; end if;
  begin
    perform public.velura_request_refund_receiver_supplement(v_cod, v_version, 'ngan', v_actor);
    raise exception 'A too-short supplement message was accepted';
  exception when sqlstate 'PT422' then null; end;

  -- 4. The customer answers; a valid account clears the request and unblocks the refund.
  v_result := public.velura_set_return_refund_receiver(v_cod, v_user, ' Vietcombank ', '0123 456-789', 'Nguyen   Van A');
  if v_result->>'account_last4' <> '6789' or v_result ? 'account_number' then raise exception 'Customer view must expose only the last four digits: %', v_result; end if;
  if (select supplement_request from public.return_refund_receiver where return_id = v_cod) is not null
    or not public.velura_return_refund_receiver_ready(v_cod) then raise exception 'A valid answer must clear the supplement request'; end if;

  -- 5. Reconciliation data is checked: wrong amount, future time, duplicate reference.
  begin
    perform public.velura_record_manual_return_refund(v_cod, v_version, 'VCB-0001', 199999, now(), 'https://proof.example/1.png', null, v_actor);
    raise exception 'Amount different from the refundable value was accepted';
  exception when sqlstate 'PT422' then
    get stacked diagnostics v_message = message_text;
    if v_message <> 'REFUND_AMOUNT_MISMATCH' then raise exception 'Expected REFUND_AMOUNT_MISMATCH, got %', v_message; end if;
  end;
  begin
    perform public.velura_record_manual_return_refund(v_cod, v_version, 'VCB-0001', 200000, now() + interval '1 day', 'https://proof.example/1.png', null, v_actor);
    raise exception 'A future transfer time was accepted';
  exception when sqlstate 'PT422' then
    get stacked diagnostics v_message = message_text;
    if v_message <> 'TRANSFER_TIME_INVALID' then raise exception 'Expected TRANSFER_TIME_INVALID, got %', v_message; end if;
  end;

  -- 6. A successful result completes the return in one step (no second approval) and stores the reconciliation record.
  v_result := public.velura_record_manual_return_refund(v_cod, v_version, 'VCB-0001', 200000, now() - interval '1 minute', 'https://proof.example/1.png', 'Chuyen khoan VCB', v_actor);
  if v_result->>'status' <> 'COMPLETED' then raise exception 'Manual refund must close the return, got %', v_result->>'status'; end if;
  select * into v_manual from public.return_manual_refund where return_id = v_cod;
  if v_manual.reference <> 'VCB-0001' or v_manual.amount <> 200000 or v_manual.payment_kind <> 'cod'
    or v_manual.receiver_account_number <> '0123456789' or v_manual.receiver_bank_name <> 'Vietcombank'
    or v_manual.receiver_account_holder <> 'Nguyen Van A' or v_manual.proof is null or v_manual.recorded_by <> v_actor then
    raise exception 'Reconciliation record is incomplete: %', to_jsonb(v_manual); end if;
  if (select status from public.payment_refund where return_id = v_cod)::text <> 'succeeded' then raise exception 'The refund ledger did not record success'; end if;

  -- 7. Stripe returns are untouched by the receiver rule (they never require an account).
  if public.velura_return_requires_refund_receiver(v_stripe) then raise exception 'Stripe return must not require a receiving account'; end if;
  begin
    perform public.velura_record_manual_return_refund(v_stripe, 4, 'MANUAL-0002', 300000, now(), 'https://proof.example/2.png', null, v_actor);
    raise exception 'A Stripe-paid order used the manual transfer path';
  exception when sqlstate 'PT422' then
    get stacked diagnostics v_message = message_text;
    if v_message <> 'CAPTURED_NON_STRIPE_REQUIRED' then raise exception 'Expected CAPTURED_NON_STRIPE_REQUIRED, got %', v_message; end if;
  end;
end $$;
rollback;
