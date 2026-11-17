-- KAN-110 (R7 + R2): returns pickup slot and COD manual refund without a captured payment row.
--
-- R7  Approving a return part now stores the carrier pickup slot (next day 09:00, Asia/Ho_Chi_Minh)
--     on `return_item.pickup_scheduled_at`, so admin, member and the approval email show one real
--     value instead of a hard-coded "demo" sentence. The slot is written by the same BEFORE UPDATE
--     trigger that moves APPROVED -> WAITING_RETURN (090), so it is atomic with the approval.
-- R2  `velura_record_manual_return_refund` (the function the API actually calls; 107 defined a
--     differently-worded twin that nothing calls) raised PT422 COD_PAYMENT_REQUIRED for a COD order
--     with no payment row or a payment row whose provider is not stripe/vnpay/momo. A COD order is
--     paid in cash at delivery, so the missing ledger row is synthesised as `paid` instead.
--     `velura_prepare_return_refund` also accepts a COD payment that is still `pending`.
begin;

alter table public.return_item add column if not exists pickup_scheduled_at timestamptz;
comment on column public.return_item.pickup_scheduled_at is
  'Hẹn ĐVVC lấy hàng hoàn: 09:00 ngày kế tiếp (giờ Việt Nam) tính từ lúc duyệt phần hàng.';

-- 090 is the running version; the only addition is the pickup slot.
create or replace function public.velura_auto_wait_return()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if old.item_status='REQUESTED' and new.item_status='APPROVED' and new.decision_status='approved' then
    new.item_status:='WAITING_RETURN';
    new.pickup_scheduled_at:=(date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') + interval '1 day 9 hours')
      at time zone 'Asia/Ho_Chi_Minh';
  end if;
  return new;
end; $$;

-- 084 is the running version; the only addition is promoting a COD payment that is still pending
-- (cash is collected at delivery, so a returned COD part is by definition already captured).
create or replace function public.velura_prepare_return_refund(
 p_return_id uuid,p_order_id uuid,p_expected_version integer,p_return_item_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare i public.return_item%rowtype; p public.payment%rowtype; op public.payment_refund%rowtype;
 amount_due numeric; reserved numeric;
begin
 perform 1 from public.orders where order_id=p_order_id for update;
 perform 1 from public.return_exchange where return_id=p_return_id and order_id=p_order_id for update;
 if not found then raise sqlstate 'PT404' using message='RETURN_NOT_FOUND'; end if;
 select * into i from public.return_item where return_item_id=p_return_item_id and return_id=p_return_id for update;
 if not found then raise sqlstate 'PT404' using message='RETURN_ITEM_NOT_FOUND'; end if;
 select * into op from public.payment_refund where return_item_id=p_return_item_id for update;
 if found then return to_jsonb(op); end if;
 if i.version is distinct from p_expected_version then raise sqlstate 'PT409' using message='VERSION_CONFLICT'; end if;
 if i.item_status<>'RECEIVED' or i.decision_status<>'approved' or i.resolution_type<>'refund'
  or i.received_quantity<>i.quantity or i.matches_product is distinct from true or i.tags_intact is distinct from true
  or i.condition_acceptable is distinct from true or i.package_match is distinct from true then
  raise sqlstate 'PT422' using message='WAREHOUSE_QA_REQUIRED'; end if;
 select * into p from public.payment where order_id=p_order_id and payment_status::text in ('paid','refund_pending')
 order by created_at desc limit 1 for update;
 if not found then
  select * into p from public.payment where order_id=p_order_id and payment_status::text='pending'
   and payment_method::text='COD' order by created_at desc limit 1 for update;
  if not found then raise sqlstate 'PT422' using message='CAPTURED_PAYMENT_REQUIRED'; end if;
  update public.payment set payment_status='paid',paid_at=coalesce(paid_at,now()),version=version+1,updated_at=now()
   where payment_id=p.payment_id returning * into p;
 end if;
 if p.payment_method::text='COD' and not public.velura_return_refund_receiver_ready(p_return_id) then
  raise sqlstate 'PT422' using message='REFUND_RECEIVER_REQUIRED'; end if;
 amount_due:=public.velura_return_item_refundable_amount(p_return_item_id);
 select coalesce(sum(amount),0) into reserved from public.payment_refund
 where payment_id=p.payment_id and status in ('requested','pending','failed');
 if amount_due<=0 or amount_due>p.amount-coalesce(p.refunded_amount,0)-reserved then
  raise sqlstate 'PT422' using message='REFUND_BALANCE_EXHAUSTED'; end if;
 insert into public.payment_refund(return_id,return_item_id,payment_id,amount)
 values(p_return_id,p_return_item_id,p.payment_id,amount_due) returning * into op;
 update public.payment set payment_status='refund_pending',refund_amount=amount_due,
  gateway_response_code='REFUND_REQUESTED',version=version+1,updated_at=now() where payment_id=p.payment_id;
 update public.return_item set item_status='REFUND_PENDING',version=version+1,updated_at=now() where return_item_id=p_return_item_id;
 insert into public.return_event(return_id,return_item_id,old_status,new_status,actor_type,event_type,payload,note)
 values(p_return_id,p_return_item_id,'RECEIVED','REFUND_PENDING','system','refund',to_jsonb(op),'Reserved captured funds for returned part');
 perform public.velura_refresh_return_aggregate(p_return_id);
 return to_jsonb(op);
end; $$;
revoke all on function public.velura_prepare_return_refund(uuid,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.velura_prepare_return_refund(uuid,uuid,integer,uuid) to service_role;

-- 113 is the running version; COD is now decided by the order as well as by the payment row.
create or replace function public.velura_record_manual_return_refund(
 p_return_id uuid,p_expected_version integer,p_reference text,p_amount numeric,p_transferred_at timestamptz,
 p_proof text,p_note text,p_actor_id uuid,p_return_item_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare h public.return_exchange%rowtype; p public.payment%rowtype; receiver public.return_refund_receiver%rowtype;
 op jsonb; prior public.return_manual_refund%rowtype; reference_value text:=btrim(p_reference);
 kind text; gateway_refund_failed boolean; v_order_pm text; v_order_total numeric; has_payment boolean;
begin
 perform public.velura_require_return_actor(p_actor_id);
 select * into h from public.return_exchange where return_id=p_return_id for update;
 if not found then raise sqlstate 'PT404' using message='RETURN_NOT_FOUND'; end if;
 select * into prior from public.return_manual_refund where return_item_id=p_return_item_id;
 if found then
  if upper(prior.reference)=upper(reference_value) and prior.amount=p_amount then return to_jsonb(prior); end if;
  raise sqlstate 'PT409' using message='REFUND_ALREADY_REQUESTED';
 end if;
 select payment_method::text,coalesce(total_amount,p_amount) into v_order_pm,v_order_total
  from public.orders where order_id=h.order_id;
 select * into p from public.payment where order_id=h.order_id order by created_at desc limit 1 for update;
 has_payment:=found;
 if not has_payment then
   -- Đơn COD đời đầu chưa có dòng thanh toán: tiền mặt đã thu khi giao nên ghi nhận đã thu.
   if upper(coalesce(v_order_pm,''))<>'COD' then raise sqlstate 'PT422' using message='COD_PAYMENT_REQUIRED'; end if;
   insert into public.payment(order_id,payment_method,payment_provider,amount,payment_status,paid_at,
     gateway_response_code,created_at,updated_at)
   values(h.order_id,'COD'::public.payment_method,'cod',coalesce(v_order_total,p_amount),'paid'::public.payment_status,now(),
     'COD_MANUAL_REFUND_BACKFILL',now(),now())
   returning * into p;
   kind:='cod';
 elsif upper(coalesce(p.payment_method::text,''))='COD'
    or (upper(coalesce(v_order_pm,''))='COD' and coalesce(p.payment_provider::text,'') not in ('stripe','vnpay','momo')) then
   kind:='cod';
   if p.payment_status::text='pending' then
     update public.payment set payment_status='paid',paid_at=coalesce(paid_at,now()),version=version+1,updated_at=now()
      where payment_id=p.payment_id returning * into p;
   end if;
 elsif p.payment_provider::text in ('stripe','vnpay','momo') then
   -- COD thì tiền đi tay là đường chính. Đơn qua cổng chỉ được ghi tay SAU KHI cổng từ chối lệnh
   -- hoàn của chính phần hàng này; nếu không sẽ hoàn hai lần cho cùng một phần hàng.
   select exists(select 1 from public.payment_refund pf
     where pf.return_item_id=p_return_item_id and pf.status::text='failed') into gateway_refund_failed;
   if not gateway_refund_failed then raise sqlstate 'PT422' using message='GATEWAY_REFUND_REQUIRED'; end if;
   kind:='other_online';
 else
   raise sqlstate 'PT422' using message='COD_PAYMENT_REQUIRED';
 end if;
 if p.payment_status::text not in ('paid','refund_pending') then
   raise sqlstate 'PT422' using message='CAPTURED_PAYMENT_REQUIRED';
 end if;
 if not public.velura_return_refund_receiver_ready(p_return_id) then raise sqlstate 'PT422' using message='REFUND_RECEIVER_REQUIRED'; end if;
 if reference_value is null or length(reference_value)<6 then raise sqlstate 'PT422' using message='TRANSFER_REFERENCE_REQUIRED'; end if;
 if exists(select 1 from public.return_manual_refund where upper(btrim(reference))=upper(reference_value)) then
  raise sqlstate 'PT409' using message='DUPLICATE_TRANSFER_REFERENCE'; end if;
 if p_transferred_at is null or p_transferred_at>now()+interval '5 minutes' or p_transferred_at<h.created_at then
  raise sqlstate 'PT422' using message='TRANSFER_TIME_INVALID'; end if;
 if not public.velura_return_evidence_owned(p_return_id,p_proof,array['refund_proof'],p_actor_id) then
  raise sqlstate 'PT422' using message='TRANSFER_PROOF_REQUIRED'; end if;
 op:=public.velura_prepare_return_refund(p_return_id,h.order_id,p_expected_version,p_return_item_id);
 if p_amount is null or p_amount<>(op->>'amount')::numeric then raise sqlstate 'PT422' using message='REFUND_AMOUNT_MISMATCH'; end if;
 select * into receiver from public.return_refund_receiver where return_id=p_return_id;
 insert into public.return_manual_refund(return_id,return_item_id,refund_id,payment_kind,reference,amount,transferred_at,
 receiver_bank_name,receiver_account_number,receiver_account_holder,proof,note,recorded_by)
 values(p_return_id,p_return_item_id,(op->>'refund_id')::uuid,kind,reference_value,p_amount,p_transferred_at,
 receiver.bank_name,receiver.account_number,receiver.account_holder,p_proof,p_note,p_actor_id);
 op:=public.velura_complete_return_refund(p_return_id,'manual:'||upper(reference_value),p_return_item_id);
 perform public.velura_append_module_audit('returns',p_actor_id,(select admin_role::text from public.users where user_id=p_actor_id),
 'update',p_return_item_id,null,op||jsonb_build_object('reference',reference_value,'proof',p_proof,'transferred_at',p_transferred_at,'payment_kind',kind),coalesce(nullif(current_setting('request.headers',true)::jsonb->>'x-velura-client-ip',''),nullif(current_setting('x-velura-client-ip',true),''),'127.0.0.1'));
 return op;
end; $$;
revoke all on function public.velura_record_manual_return_refund(uuid,integer,text,numeric,timestamptz,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.velura_record_manual_return_refund(uuid,integer,text,numeric,timestamptz,text,text,uuid,uuid) to service_role;

comment on function public.velura_record_manual_return_refund(uuid,integer,text,numeric,timestamptz,text,text,uuid,uuid) is
 'Ghi chuyển khoản tay cho phần hoàn tiền: COD tự do (tự tạo dòng thanh toán đã thu nếu thiếu), đơn qua cổng chỉ sau khi cổng từ chối (payment_refund failed).';

-- 107 named this function with the words swapped; no caller exists, so remove the dead twin.
drop function if exists public.velura_record_return_manual_refund(uuid,integer,text,numeric,timestamptz,text,text,uuid,uuid);

notify pgrst,'reload schema';
commit;
