-- KAN-108 BA 3.1.12 alignment: warehouse receive confirms only item + quantity (partial receipt allowed),
-- CSKH may stop a part already in transit, and refunds carry a 5-working-day SLA (refund_due_at).
-- The return window stays 7 days (085); only stale published policy copy is corrected here.
begin;

alter table public.return_item add column if not exists refund_due_at timestamptz;
alter table public.return_exchange add column if not exists refund_due_at timestamptz;
create index if not exists return_item_refund_due_idx on public.return_item(refund_due_at) where refund_due_at is not null;
create index if not exists return_exchange_refund_due_idx on public.return_exchange(refund_due_at) where refund_due_at is not null;
create index if not exists return_exchange_contact_due_idx on public.return_exchange(contact_due_at) where contact_due_at is not null;

-- Monday-Friday arithmetic in Vietnam time; mirrors apps/api/src/returns/return-sla.ts (no holiday calendar).
create or replace function public.velura_add_working_days(p_from timestamptz,p_days integer)
returns timestamptz language plpgsql stable set search_path=pg_catalog,public as $$
declare t timestamp:=p_from at time zone 'Asia/Ho_Chi_Minh'; n integer:=0;
begin
 if p_days is null or p_days<0 then raise sqlstate 'PT422' using message='INVALID_WORKING_DAYS'; end if;
 while n<p_days loop
  t:=t+interval '1 day';
  if extract(isodow from t)<6 then n:=n+1; end if;
 end loop;
 return t at time zone 'Asia/Ho_Chi_Minh';
end; $$;
revoke all on function public.velura_add_working_days(timestamptz,integer) from public,anon,authenticated;
grant execute on function public.velura_add_working_days(timestamptz,integer) to service_role;

create or replace function public.velura_refresh_return_aggregate(p_return_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare s text; d text; n integer; a integer; r integer; c integer; terminal integer; active_stages integer;
begin
 select count(*),count(*) filter(where decision_status='approved'),count(*) filter(where decision_status='rejected'),
 count(*) filter(where item_status='COMPLETED'),count(*) filter(where item_status in ('COMPLETED','REJECTED','CANCELLED')),
 count(distinct item_status) filter(where item_status not in ('COMPLETED','REJECTED','CANCELLED')),
 min(item_status) filter(where item_status not in ('COMPLETED','REJECTED','CANCELLED'))
 into n,a,r,c,terminal,active_stages,s from public.return_item where return_id=p_return_id;
 if n=0 then return; end if;
 d:=case when r=n then 'REJECTED' when r>0 and a>0 then 'PARTIALLY_APPROVED' when a=n then 'APPROVED' else 'PENDING' end;
 if r=n then s:='REJECTED'; elsif terminal=n then s:=case when c>0 then 'COMPLETED' else 'CANCELLED' end;
 elsif active_stages>1 or terminal>0 then s:='IN_PROGRESS'; end if;
 s:=case s when 'RETURN_SHIPPING' then 'RETURN_IN_TRANSIT' when 'REFUND_PENDING' then 'REFUND_PROCESSING' else s end;
 perform set_config('app.return_projection','on',true);
 update public.return_exchange set status=s::public.return_status,decision_status=d,
 refund_amount=(select coalesce(sum(refund_amount),0) from public.return_item where return_id=p_return_id),
 resolved_at=case when terminal=n then coalesce(resolved_at,now()) else null end,
 refund_due_at=(select min(refund_due_at) from public.return_item where return_id=p_return_id
   and resolution_type='refund' and item_status in ('RECEIVED','REFUND_PENDING')),
 version=version+1,updated_at=now() where return_id=p_return_id;
 perform set_config('app.return_projection','off',true);
end; $$;

create or replace function public.velura_return_item_action(
 p_return_id uuid,p_return_item_id uuid,p_action text,p_payload jsonb,p_expected_version integer,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare i public.return_item%rowtype; before_item public.return_item%rowtype; rem public.return_item%rowtype;
 h public.return_exchange%rowtype; oi public.order_item%rowtype; original public.orders%rowtype;
 replacement public.orders%rowtype; v public.variant%rowtype; qty integer; target uuid; note text; stage text;
 before_stock integer; proof text; units integer; movement uuid; received integer; missing_qty integer:=0; due_days integer:=5;
begin
 perform public.velura_require_return_actor(p_actor_id,p_action in ('approve','reject'));
 select * into h from public.return_exchange where return_id=p_return_id for update;
 select * into i from public.return_item where return_item_id=p_return_item_id and return_id=p_return_id for update;
 if not found then raise sqlstate 'PT404' using message='RETURN_ITEM_NOT_FOUND'; end if;
 if p_expected_version is null or i.version<>p_expected_version then raise sqlstate 'PT409' using message='VERSION_CONFLICT'; end if;
 if i.item_status in ('COMPLETED','REJECTED','CANCELLED') then raise sqlstate 'PT422' using message='RETURN_ITEM_CLOSED'; end if;
 if p_action not in ('approve','reject','wait_return','pickup','receive','needs_support','resolve','stop','convert_refund','change_variant','prepare_exchange','ship_exchange','complete_exchange') then
  raise sqlstate 'PT422' using message='INVALID_RETURN_ACTION'; end if;
 before_item:=i;
 note:=nullif(btrim(coalesce(p_payload->>'reason',p_payload->>'note','')),'');
 if p_action in ('approve','reject','needs_support','resolve','stop','convert_refund','change_variant') and note is null then
  raise sqlstate 'PT422' using message='RETURN_REASON_REQUIRED'; end if;
 if p_payload ? 'quantity' and ((p_payload->>'quantity')::numeric<>trunc((p_payload->>'quantity')::numeric)) then
  raise sqlstate 'PT422' using message='INVALID_RETURN_QUANTITY'; end if;
 qty:=coalesce((p_payload->>'quantity')::integer,i.quantity);
 if qty is null or qty<=0 or qty>i.quantity then raise sqlstate 'PT422' using message='INVALID_RETURN_QUANTITY'; end if;
 if qty<i.quantity then
  if i.received_quantity>0 or i.exchange_order_id is not null or exists(select 1 from public.payment_refund where return_item_id=i.return_item_id) then
   raise sqlstate 'PT422' using message='RETURN_PART_ALREADY_COMMITTED'; end if;
  insert into public.return_item(return_id,order_item_id,quantity,replacement_variant_id,item_status,decision_status,resolution_type,
    reason,attention_status,support_previous_status,split_from_id)
   values(i.return_id,i.order_item_id,i.quantity-qty,i.replacement_variant_id,i.item_status,i.decision_status,i.resolution_type,
    i.reason,i.attention_status,i.support_previous_status,i.return_item_id) returning * into rem;
  with moved as (select order_item_id,unit_number from public.return_item_unit where return_item_id=i.return_item_id order by unit_number desc limit rem.quantity)
  update public.return_item_unit m set return_item_id=rem.return_item_id from moved x
   where m.return_item_id=i.return_item_id and m.order_item_id=x.order_item_id and m.unit_number=x.unit_number;
  update public.return_unit u set active_return_item_id=rem.return_item_id where exists
   (select 1 from public.return_item_unit m where m.return_item_id=rem.return_item_id and m.order_item_id=u.order_item_id and m.unit_number=u.unit_number);
  insert into public.return_item_shipment(return_item_id,shipment_id)
   select rem.return_item_id,shipment_id from public.return_item_shipment where return_item_id=i.return_item_id;
  i.quantity:=qty;
 end if;
 stage:=i.item_status;
 case p_action
 when 'approve' then
  if i.decision_status<>'pending' then raise sqlstate 'PT422' using message='RETURN_DECISION_FINAL'; end if;
  i.decision_status:='approved'; i.decision_at:=now(); i.item_status:='APPROVED';
 when 'reject' then
  if i.decision_status<>'pending' then raise sqlstate 'PT422' using message='RETURN_DECISION_FINAL'; end if;
  i.decision_status:='rejected'; i.decision_at:=now(); i.item_status:='REJECTED';
 when 'wait_return' then
  if i.decision_status<>'approved' or stage<>'APPROVED' then raise sqlstate 'PT422' using message='RETURN_APPROVAL_REQUIRED'; end if;
  i.item_status:='WAITING_RETURN';
 when 'pickup' then
  if stage<>'WAITING_RETURN' then raise sqlstate 'PT422' using message='INVALID_RETURN_TRANSITION'; end if;
  if nullif(btrim(p_payload->>'carrier'),'') is null or nullif(btrim(p_payload->>'trackingNumber'),'') is null then
   raise sqlstate 'PT422' using message='TRACKING_REQUIRED'; end if;
  if length(btrim(coalesce(p_payload->>'pickedUpBy','')))<2 or nullif(p_payload->>'pickedUpAt','') is null
   or (p_payload->>'pickedUpAt')::timestamptz>now() or (p_payload->>'pickedUpAt')::timestamptz<h.created_at then
   raise sqlstate 'PT422' using message='PICKUP_IDENTITY_TIME_REQUIRED'; end if;
  if jsonb_typeof(p_payload->'photoUrls') is distinct from 'array' or jsonb_array_length(p_payload->'photoUrls')<1 then
   raise sqlstate 'PT422' using message='PICKUP_PROOF_REQUIRED'; end if;
  for proof in select jsonb_array_elements_text(p_payload->'photoUrls') loop
   if not public.velura_return_evidence_owned(p_return_id,proof,array['pickup_photo']) then raise sqlstate 'PT422' using message='PICKUP_PROOF_REQUIRED'; end if;
  end loop;
  if nullif(p_payload->>'videoUrl','') is not null and not public.velura_return_evidence_owned(p_return_id,p_payload->>'videoUrl',array['pickup_video','packing_video']) then
   raise sqlstate 'PT422' using message='PICKUP_PROOF_REQUIRED'; end if;
  if exists(select 1 from public.return_shipment where carrier=p_payload->>'carrier' and tracking_code=p_payload->>'trackingNumber'
    and (return_id<>p_return_id or direction<>'inbound')) then raise sqlstate 'PT409' using message='TRACKING_ALREADY_USED'; end if;
  insert into public.return_shipment(return_id,return_item_id,direction,carrier,tracking_code,status,picked_up_at,picked_up_by,pickup_photo_urls,package_video_url,created_by)
  values(p_return_id,i.return_item_id,'inbound',p_payload->>'carrier',p_payload->>'trackingNumber','picked_up',(p_payload->>'pickedUpAt')::timestamptz,p_payload->>'pickedUpBy',
   array(select jsonb_array_elements_text(p_payload->'photoUrls')),nullif(p_payload->>'videoUrl',''),p_actor_id)
  on conflict(carrier,tracking_code) where tracking_code is not null and tracking_code<>'' do nothing;
  insert into public.return_item_shipment(return_item_id,shipment_id)
   select i.return_item_id,shipment_id from public.return_shipment where carrier=p_payload->>'carrier' and tracking_code=p_payload->>'trackingNumber'
   on conflict do nothing;
  i.item_status:='RETURN_SHIPPING';
 when 'receive' then
  if stage<>'RETURN_SHIPPING' or i.decision_status<>'approved' or not exists(
   select 1 from public.return_item_shipment m join public.return_shipment s using(shipment_id)
   where m.return_item_id=i.return_item_id and s.direction='inbound' and s.picked_up_at is not null
    and nullif(s.picked_up_by,'') is not null and cardinality(s.pickup_photo_urls)>0)
   then raise sqlstate 'PT422' using message='PICKUP_REQUIRED'; end if;
  -- AD_RECEIVE_01 / RET-09: the warehouse only confirms the item and the quantity that physically arrived.
  -- Quality facts, photos and disposition are optional recorded information and never gate the refund.
  if nullif(p_payload->>'receivedQuantity','') is null
   or (p_payload->>'receivedQuantity')::numeric<>trunc((p_payload->>'receivedQuantity')::numeric)
   or (p_payload->>'receivedQuantity')::integer<1 or (p_payload->>'receivedQuantity')::integer>i.quantity then
   raise sqlstate 'PT422' using message='INVALID_RECEIVED_QUANTITY'; end if;
  received:=(p_payload->>'receivedQuantity')::integer;
  proof:=nullif(p_payload->>'receiptProofRef','');
  if proof is not null and not public.velura_return_evidence_owned(p_return_id,proof,array['qa_photo','qa_video']) then raise sqlstate 'PT422' using message='WAREHOUSE_PROOF_REQUIRED'; end if;
  if nullif(p_payload->>'disposition','') is not null and p_payload->>'disposition' not in ('restock','repair','scrap','return_supplier') then raise sqlstate 'PT422' using message='DISPOSITION_REQUIRED'; end if;
  if received<i.quantity then
   -- Exception 3: the customer sent fewer units. The received part proceeds alone; the missing remainder becomes
   -- its own released item (no luot consumed, units freed) and is flagged for CSKH follow-up.
   missing_qty:=i.quantity-received;
   insert into public.return_item(return_id,order_item_id,quantity,replacement_variant_id,item_status,decision_status,resolution_type,
     reason,attention_status,split_from_id,decision_at)
    values(i.return_id,i.order_item_id,missing_qty,i.replacement_variant_id,'CANCELLED',i.decision_status,i.resolution_type,
     'Thiếu hàng khi kho nhận: khách gửi '||received||'/'||(received+missing_qty)||' sản phẩm','needs_support',i.return_item_id,i.decision_at) returning * into rem;
   with moved as (select order_item_id,unit_number from public.return_item_unit where return_item_id=i.return_item_id order by unit_number desc limit missing_qty)
   update public.return_item_unit m set return_item_id=rem.return_item_id from moved x
    where m.return_item_id=i.return_item_id and m.order_item_id=x.order_item_id and m.unit_number=x.unit_number;
   update public.return_unit u set active_return_item_id=null where exists
    (select 1 from public.return_item_unit m where m.return_item_id=rem.return_item_id and m.order_item_id=u.order_item_id and m.unit_number=u.unit_number);
   insert into public.return_item_shipment(return_item_id,shipment_id)
    select rem.return_item_id,shipment_id from public.return_item_shipment where return_item_id=i.return_item_id;
   i.quantity:=received;
  end if;
  i.received_quantity:=received;
  i.matches_product:=case when jsonb_typeof(p_payload->'matchesProduct')='boolean' then (p_payload->>'matchesProduct')::boolean end;
  i.tags_intact:=case when jsonb_typeof(p_payload->'tagsIntact')='boolean' then (p_payload->>'tagsIntact')::boolean end;
  i.condition_acceptable:=case when jsonb_typeof(p_payload->'conditionAcceptable')='boolean' then (p_payload->>'conditionAcceptable')::boolean end;
  i.package_match:=case when jsonb_typeof(p_payload->'packageMatch')='boolean' then (p_payload->>'packageMatch')::boolean end;
  i.seal_intact:=case when jsonb_typeof(p_payload->'sealIntact')='boolean' then (p_payload->>'sealIntact')::boolean end;
  i.receipt_proof_ref:=proof; i.receipt_at:=now(); i.disposition:=nullif(p_payload->>'disposition','');
  i.item_status:='RECEIVED';
  -- AD_REFUND_03: refund SLA starts when the warehouse confirms receipt.
  if i.resolution_type='refund' then i.refund_due_at:=public.velura_add_working_days(now(),due_days); end if;
  if i.disposition='restock' then
   -- Only the stock movement is protected: goods explicitly recorded as failing a check never re-enter sellable stock.
   if i.matches_product is false or i.tags_intact is false or i.condition_acceptable is false or i.package_match is false then
    raise sqlstate 'PT422' using message='RESTOCK_QA_REQUIRED'; end if;
   select * into oi from public.order_item where item_id=i.order_item_id;
   select * into v from public.variant where variant_id=oi.variant_id for update;
   before_stock:=v.stock_quantity;
   insert into public.return_stock_movement(return_id,return_item_id,variant_id,order_id,disposition,quantity,before_quantity,after_quantity,actor_id,note)
    values(p_return_id,i.return_item_id,v.variant_id,h.order_id,'restock',i.quantity,before_stock,before_stock+i.quantity,p_actor_id,note)
    on conflict(return_id,return_item_id) do nothing returning movement_id into movement;
   if movement is not null then
    update public.variant set stock_quantity=stock_quantity+i.quantity,version=version+1,updated_at=now() where variant_id=v.variant_id;
    i.stock_restored_quantity:=i.quantity; i.restocked_at:=now();
   end if;
  end if;
 when 'needs_support' then
  if stage in ('REFUND_PENDING') then raise sqlstate 'PT422' using message='REFUND_ALREADY_REQUESTED'; end if;
  i.support_previous_status:=stage; i.item_status:='NEEDS_SUPPORT'; i.attention_status:='needs_support';
 when 'resolve' then
  if stage<>'NEEDS_SUPPORT' or i.support_previous_status is null then raise sqlstate 'PT422' using message='INVALID_RETURN_TRANSITION'; end if;
  i.item_status:=i.support_previous_status; i.attention_status:=null;
 when 'stop' then
  if stage='RETURN_SHIPPING' then
   -- AD_RECEIVE_03 / exception 2: CSKH records that the customer will not continue sending. Allowed only
   -- while the goods have not been confirmed by the warehouse; the unit's quota is freed below.
   if i.received_quantity>0 or i.receipt_at is not null then raise sqlstate 'PT422' using message='RETURN_PART_ALREADY_COMMITTED'; end if;
  elsif stage not in ('REQUESTED','APPROVED','WAITING_RETURN') or exists(
   select 1 from public.return_item_shipment where return_item_id=i.return_item_id) then
   raise sqlstate 'PT422' using message='RETURN_ALREADY_HANDED_OVER'; end if;
  if exists(select 1 from public.payment_refund where return_item_id=i.return_item_id) or i.exchange_order_id is not null then
   raise sqlstate 'PT422' using message='RETURN_PART_ALREADY_COMMITTED'; end if;
  i.item_status:='CANCELLED';
 when 'convert_refund' then
  if i.resolution_type<>'exchange' or i.decision_status<>'approved' then
   raise sqlstate 'PT422' using message='INVALID_RETURN_TRANSITION'; end if;
  if coalesce((p_payload->>'customerConsent')::boolean,false)<>true then
   raise sqlstate 'PT422' using message='CUSTOMER_CONSENT_REQUIRED'; end if;
  if i.exchange_order_id is not null then
   select * into replacement from public.orders where order_id=i.exchange_order_id for update;
   if replacement.status::text not in ('confirmed','pending','cancelled','delivery_failed') then raise sqlstate 'PT422' using message='EXCHANGE_ALREADY_SHIPPED'; end if;
   if replacement.status::text<>'cancelled' and replacement.stock_returned_at is null then
    update public.variant v2 set stock_quantity=v2.stock_quantity+oi2.quantity,version=v2.version+1,updated_at=now()
     from public.order_item oi2 where oi2.order_id=i.exchange_order_id and oi2.variant_id=v2.variant_id;
    update public.orders set status='cancelled',stock_returned_at=now(),updated_at=now() where order_id=i.exchange_order_id;
   end if;
  end if;
  i.resolution_type:='refund';
  i.item_status:=case
   when i.received_quantity>0 and i.receipt_at is not null then 'RECEIVED'
   when stage='RETURN_SHIPPING' then 'RETURN_SHIPPING'
   when stage='NEEDS_SUPPORT' then 'NEEDS_SUPPORT'
   else 'WAITING_RETURN' end;
  if i.item_status='RECEIVED' and i.refund_due_at is null then i.refund_due_at:=public.velura_add_working_days(now(),due_days); end if;
 when 'change_variant' then
  if i.resolution_type<>'exchange' then raise sqlstate 'PT422' using message='INVALID_RETURN_TRANSITION'; end if;
  if i.exchange_order_id is not null then raise sqlstate 'PT422' using message='EXCHANGE_ALREADY_PREPARED'; end if;
  if coalesce((p_payload->>'customerConsent')::boolean,false)<>true then raise sqlstate 'PT422' using message='CUSTOMER_CONSENT_REQUIRED'; end if;
  target:=nullif(p_payload->>'replacementVariantId','')::uuid;
  if target is null or not exists(select 1 from public.variant x join public.variant y on x.product_id=y.product_id join public.order_item z on z.variant_id=y.variant_id
   where z.item_id=i.order_item_id and x.variant_id=target) then raise sqlstate 'PT422' using message='EXCHANGE_SAME_PRODUCT_REQUIRED'; end if;
  select * into v from public.variant where variant_id=target for update;
  if v.stock_quantity-v.reserved_quantity<i.quantity then raise sqlstate 'PT409' using message='INSUFFICIENT_STOCK'; end if;
  i.replacement_variant_id:=target;
 when 'prepare_exchange' then
  if stage<>'RECEIVED' or i.resolution_type<>'exchange' or i.decision_status<>'approved' then raise sqlstate 'PT422' using message='WAREHOUSE_QA_REQUIRED'; end if;
  select * into oi from public.order_item where item_id=i.order_item_id;
  target:=coalesce(i.replacement_variant_id,oi.variant_id);
  select * into v from public.variant where variant_id=target for update;
  if not found or v.product_id<>(select product_id from public.variant where variant_id=oi.variant_id) then raise sqlstate 'PT422' using message='EXCHANGE_SAME_PRODUCT_REQUIRED'; end if;
  if v.stock_quantity-v.reserved_quantity<i.quantity then raise sqlstate 'PT409' using message='INSUFFICIENT_STOCK'; end if;
  select * into original from public.orders where order_id=h.order_id;
  insert into public.orders(user_id,order_code,status,shipping_name,shipping_phone,shipping_email,shipping_address,subtotal,discount_amount,total_amount,shipping_fee,payment_method,is_guest,stock_committed_at,internal_note,order_kind,parent_order_id,source_return_id,source_return_item_id)
   values(original.user_id,'EXC'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)),'confirmed',original.shipping_name,original.shipping_phone,original.shipping_email,original.shipping_address,
   0,0,0,0,'COD',original.is_guest,now(),'Replacement of original unit; no new revenue','exchange',original.order_id,p_return_id,i.return_item_id) returning * into replacement;
  insert into public.order_item(order_id,variant_id,product_name,product_image,quantity,unit_price,subtotal_item)
   values(replacement.order_id,target,oi.product_name,oi.product_image,i.quantity,0,0);
  update public.variant set stock_quantity=stock_quantity-i.quantity,version=version+1,updated_at=now() where variant_id=target;
  i.exchange_order_id:=replacement.order_id; i.item_status:='EXCHANGE_PREPARING';
 when 'ship_exchange' then
  if stage<>'EXCHANGE_PREPARING' or i.exchange_order_id is null then raise sqlstate 'PT422' using message='EXCHANGE_PREPARING_REQUIRED'; end if;
  if nullif(btrim(p_payload->>'carrier'),'') is null or nullif(btrim(p_payload->>'trackingNumber'),'') is null then raise sqlstate 'PT422' using message='TRACKING_REQUIRED'; end if;
  update public.orders set status='shipping',carrier=p_payload->>'carrier',tracking_code=p_payload->>'trackingNumber',
   handed_over_at=now(),shipment_created_at=coalesce(shipment_created_at,now()),updated_at=now() where order_id=i.exchange_order_id;
  insert into public.return_shipment(return_id,return_item_id,direction,order_id,carrier,tracking_code,status,picked_up_at,created_by)
   values(p_return_id,i.return_item_id,'outbound',i.exchange_order_id,p_payload->>'carrier',p_payload->>'trackingNumber','picked_up',now(),p_actor_id);
  i.item_status:='EXCHANGE_SHIPPING';
 when 'complete_exchange' then
  if stage<>'EXCHANGE_SHIPPING' or not exists(select 1 from public.orders where order_id=i.exchange_order_id and status::text='delivered' and delivered_at is not null) then
   raise sqlstate 'PT422' using message='EXCHANGE_DELIVERY_REQUIRED'; end if;
  perform public.velura_finish_return_unit(i.return_item_id,false); i.item_status:='COMPLETED'; i.completed_at:=now();
 end case;
 if i.item_status in ('REJECTED','CANCELLED') then update public.return_unit set active_return_item_id=null where active_return_item_id=i.return_item_id; end if;
 update public.return_item set quantity=i.quantity,item_status=i.item_status,decision_status=i.decision_status,resolution_type=i.resolution_type,
  decision_at=i.decision_at,reason=coalesce(note,i.reason),attention_status=i.attention_status,support_previous_status=i.support_previous_status,
  replacement_variant_id=i.replacement_variant_id,exchange_order_id=i.exchange_order_id,received_quantity=i.received_quantity,
  matches_product=i.matches_product,tags_intact=i.tags_intact,condition_acceptable=i.condition_acceptable,package_match=i.package_match,
  seal_intact=i.seal_intact,receipt_proof_ref=i.receipt_proof_ref,receipt_at=i.receipt_at,disposition=i.disposition,
  stock_restored_quantity=i.stock_restored_quantity,restocked_at=i.restocked_at,completed_at=i.completed_at,refund_due_at=i.refund_due_at,version=version+1,updated_at=now()
 where return_item_id=i.return_item_id returning * into i;
 insert into public.return_event(return_id,return_item_id,old_status,new_status,actor_id,actor_type,event_type,payload,note)
 values(p_return_id,i.return_item_id,before_item.item_status,i.item_status,p_actor_id,'admin',
  case when p_action='stop' and stage='RETURN_SHIPPING' then 'customer_stopped' else 'item_action' end,
  p_payload||jsonb_build_object('action',p_action,'quantity',qty,'split_remainder_id',rem.return_item_id,'missing_quantity',missing_qty),note);
 if missing_qty>0 then
  insert into public.return_event(return_id,return_item_id,old_status,new_status,actor_id,actor_type,event_type,payload,note)
  values(p_return_id,rem.return_item_id,'RETURN_SHIPPING','CANCELLED',p_actor_id,'admin','missing_goods',
   jsonb_build_object('received_item_id',i.return_item_id,'received_quantity',i.quantity,'missing_quantity',missing_qty),
   coalesce(note,'Khách gửi thiếu hàng, CSKH cần liên hệ khách'));
  update public.return_exchange set attention_status='needs_support' where return_id=p_return_id;
 end if;
 perform public.velura_append_module_audit('returns',p_actor_id,(select admin_role::text from public.users where user_id=p_actor_id),'update',i.return_item_id,to_jsonb(before_item),to_jsonb(i)||jsonb_build_object('action',p_action,'customer_consent',p_payload->'customerConsent'),coalesce(nullif(current_setting('request.headers',true)::jsonb->>'x-velura-client-ip',''),nullif(current_setting('x-velura-client-ip',true),''),'127.0.0.1'));
 perform public.velura_refresh_return_aggregate(p_return_id);
 return jsonb_build_object('return_id',p_return_id,'item',to_jsonb(i),'lines',(select jsonb_agg(to_jsonb(x) order by x.created_at,x.return_item_id) from public.return_item x where return_id=p_return_id));
end; $$;

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
 -- The warehouse only has to confirm receipt; the refund covers exactly the received units.
 if i.item_status<>'RECEIVED' or i.decision_status<>'approved' or i.resolution_type<>'refund' or i.received_quantity<1 then
  raise sqlstate 'PT422' using message='WAREHOUSE_QA_REQUIRED'; end if;
 select * into p from public.payment where order_id=p_order_id and payment_status::text in ('paid','refund_pending')
 order by created_at desc limit 1 for update;
 if not found then raise sqlstate 'PT422' using message='CAPTURED_PAYMENT_REQUIRED'; end if;
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
 update public.return_item set item_status='REFUND_PENDING',refund_due_at=coalesce(refund_due_at,public.velura_add_working_days(now(),5)),
  version=version+1,updated_at=now() where return_item_id=p_return_item_id;
 insert into public.return_event(return_id,return_item_id,old_status,new_status,actor_type,event_type,payload,note)
 values(p_return_id,p_return_item_id,'RECEIVED','REFUND_PENDING','system','refund',to_jsonb(op),'Reserved captured funds for returned part');
 perform public.velura_refresh_return_aggregate(p_return_id);
 return to_jsonb(op);
end; $$;

-- Backfill the SLA for parts already waiting on a refund, then project it onto each header.
update public.return_item set refund_due_at=public.velura_add_working_days(coalesce(receipt_at,updated_at,now()),5)
 where refund_due_at is null and resolution_type='refund' and item_status in ('RECEIVED','REFUND_PENDING');
update public.return_exchange r set refund_due_at=(select min(i.refund_due_at) from public.return_item i
 where i.return_id=r.return_id and i.resolution_type='refund' and i.item_status in ('RECEIVED','REFUND_PENDING'));

-- Published return policy copy follows the 7-day decision (032 had rewritten it to 30 days).
update public.policy
set summary=replace(summary,'30 ngày','7 ngày'),
    content=replace(content::text,'30 ngày','7 ngày')::jsonb,
    updated_at=now()
where (coalesce(slug,'') ilike '%doi-tra%' or coalesce(slug,'') ilike '%return%' or coalesce(title,'') ilike '%đổi%trả%')
  and (summary like '%30 ngày%' or content::text like '%30 ngày%');

comment on column public.return_item.refund_due_at is 'Refund SLA deadline: 5 working days after warehouse receipt (AD_REFUND_03).';
notify pgrst,'reload schema';
commit;
