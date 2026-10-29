-- Disposable PostgreSQL/Supabase only, after migrations 084,085,086.
-- psql -v ON_ERROR_STOP=1 -f tests/database/return-item-workflow.sql
-- Requires canonical tables, enums, auth helpers and existing 038 order-service RPC;
-- fixture insertion alone bypasses triggers/FKs, all business assertions run with triggers ON.
-- Private evidence ledger rows represent uploaded objects; no external storage/network is accessed.
\set ON_ERROR_STOP on
begin;
set local session_replication_role=replica;
insert into public.users(user_id,email,password_hash,full_name,role,admin_role,is_active) values
 ('94000000-0000-4000-8000-000000000001','return-super@example.invalid','fixture','Return Super','admin','super_admin',true),
 ('94000000-0000-4000-8000-000000000002','return-cskh@example.invalid','fixture','Return CSKH','admin','admin_operator_cskh_dt',true),
 ('94000000-0000-4000-8000-000000000003','return-reader@example.invalid','fixture','Return Reader','admin','admin_operator_donhang',true);
insert into public.category(category_id,name,slug) values('94000000-0000-4000-8000-000000000010','Return fixture','return-item-fixture');
insert into public.product(product_id,category_id,sku,name,slug,base_price,sale_price,status) values
 ('94000000-0000-4000-8000-000000000020','94000000-0000-4000-8000-000000000010','RET-ITEM-TEST','Return fixture','return-item-fixture',100000,100000,'on_sale');
insert into public.variant(variant_id,product_id,color,size,stock_quantity,reserved_quantity) values
 ('94000000-0000-4000-8000-000000000031','94000000-0000-4000-8000-000000000020','Black','M',20,0),
 ('94000000-0000-4000-8000-000000000032','94000000-0000-4000-8000-000000000020','Black','L',20,0);
insert into public.orders(order_id,user_id,order_code,status,shipping_name,shipping_phone,shipping_address,subtotal,discount_amount,total_amount,shipping_fee,payment_method,delivered_at) values
 ('94000000-0000-4000-8000-000000000040','94000000-0000-4000-8000-000000000001','RET-ITEM-TEST','delivered','Return Customer','0900000040','Test address',400000,0,400000,0,'COD',now()-interval '1 day');
insert into public.order_item(item_id,order_id,variant_id,product_name,quantity,unit_price,subtotal_item) values
 ('94000000-0000-4000-8000-000000000050','94000000-0000-4000-8000-000000000040','94000000-0000-4000-8000-000000000031','Return fixture',4,100000,400000);
insert into public.payment(payment_id,order_id,payment_method,payment_provider,amount,payment_status) values
 ('94000000-0000-4000-8000-000000000060','94000000-0000-4000-8000-000000000040','COD','cod',400000,'paid');
set local session_replication_role=origin;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.headers','{"x-velura-client-ip":"192.0.2.84"}',true);

do $$
declare
 actor uuid:='94000000-0000-4000-8000-000000000001'; cskh uuid:='94000000-0000-4000-8000-000000000002';
 reader uuid:='94000000-0000-4000-8000-000000000003'; order_id_value uuid:='94000000-0000-4000-8000-000000000040';
 original_item uuid:='94000000-0000-4000-8000-000000000050'; h uuid; second_h uuid; i uuid; remainder uuid; version_value integer;
 op jsonb; replay jsonb; replacement_id uuid; unit_value integer; message_value text; stock_before integer;
 receipt jsonb:='{"receivedQuantity":1,"matchesProduct":true,"tagsIntact":true,"conditionAcceptable":true,"packageMatch":true,"sealIntact":false,"disposition":"restock","receiptProofRef":"storage://return-evidence-private/fixture/qa.png"}';
begin
 insert into public.return_exchange(order_id,user_id,return_type,status,description) values(order_id_value,actor,'exchange','REQUESTED','Original exchange request') returning return_id into h;
 insert into public.return_item(return_id,order_item_id,quantity,replacement_variant_id) values(h,original_item,2,'94000000-0000-4000-8000-000000000032') returning return_item_id into i;
 perform public.velura_reserve_return_units(i);
 insert into public.return_evidence(return_id,kind,storage_bucket,storage_path,mime_type,uploaded_by_role,uploaded_by) values
 (h,'qa_photo','return-evidence-private','fixture/qa.png','image/png','admin',cskh),
 (h,'refund_proof','return-evidence-private','fixture/refund.png','image/png','admin',cskh),
 (h,'pickup_photo','return-evidence-private','fixture/pickup.png','image/png','carrier',cskh);
 -- CSKH cannot approve even with general operational permissions; reader cannot perform operations.
 begin perform public.velura_return_item_action(h,i,'approve','{"reason":"Reason for approval"}',1,cskh); raise exception 'CSKH approved';
 exception when sqlstate 'PT403' then null; end;
 begin perform public.velura_return_item_action(h,i,'needs_support','{"reason":"Operational note"}',1,reader); raise exception 'Reader mutated';
 exception when sqlstate 'PT403' then null; end;
 begin perform public.velura_return_item_action(h,i,'approve','{}',1,actor); raise exception 'Blank decision accepted';
 exception when sqlstate 'PT422' then null; end;
 -- Process one of two units; the untouched remainder keeps its own pending decision and version.
 perform public.velura_return_item_action(h,i,'approve','{"quantity":1,"reason":"Customer unreachable; approve from evidence"}',1,actor);
 select return_item_id into remainder from public.return_item where return_id=h and return_item_id<>i;
 if (select quantity from public.return_item where return_item_id=i)<>1 or (select decision_status from public.return_item where return_item_id=remainder)<>'pending' then raise exception 'Split lost independent remainder'; end if;
 if (select count(*) from public.return_item_unit where return_item_id=i)<>1 or (select count(*) from public.return_item_unit where return_item_id=remainder)<>1 then raise exception 'Split lost original-unit mappings'; end if;
 perform public.velura_return_item_action(h,remainder,'reject','{"reason":"Only affected unit qualifies"}',1,actor);
 if (select decision_status from public.return_exchange where return_id=h)<>'PARTIALLY_APPROVED' then raise exception 'Mixed decisions lost'; end if;
 -- Another active request can hold a disjoint original unit, not block the entire purchased line.
 insert into public.return_exchange(order_id,user_id,return_type,status,description) values(order_id_value,actor,'refund','REQUESTED','Disjoint request') returning return_id into second_h;
 insert into public.return_item(return_id,order_item_id,quantity) values(second_h,original_item,1) returning return_item_id into remainder;
 perform public.velura_reserve_return_units(remainder);
 if (select count(*) from public.return_unit where active_return_item_id is not null and order_item_id=original_item)<>2 then raise exception 'Disjoint quota failed'; end if;
 perform public.velura_return_item_action(second_h,remainder,'stop','{"reason":"Customer withdrew this part"}',1,cskh);
 if exists(select 1 from public.return_unit where active_return_item_id=remainder) then raise exception 'Stopped part retained quota'; end if;
 -- Header cannot decide or move goods; initial type is immutable.
 begin update public.return_exchange set return_type='refund' where return_id=h; raise exception 'Type mutated'; exception when sqlstate 'PT422' then null; end;
 begin update public.return_exchange set status='COMPLETED' where return_id=h; raise exception 'Header progressed'; exception when sqlstate 'PT422' then null; end;
 select version into version_value from public.return_item where return_item_id=i;
 perform public.velura_return_item_action(h,i,'wait_return','{}',version_value,cskh);
 select version into version_value from public.return_item where return_item_id=i;
 begin perform public.velura_return_item_action(h,i,'receive',receipt,version_value,cskh); raise exception 'Received without pickup handover';
 exception when sqlstate 'PT422' then null; end;
 begin perform public.velura_return_item_action(h,i,'pickup',jsonb_build_object('carrier','Fixture carrier','trackingNumber','FIXTURE-INBOUND-1','photoUrls',jsonb_build_array('storage://return-evidence-private/fixture/pickup.png'),'pickedUpBy','','pickedUpAt',now()),version_value,cskh); raise exception 'Blank pickup identity accepted';
 exception when sqlstate 'PT422' then null; end;
 perform public.velura_return_item_action(h,i,'pickup',jsonb_build_object('carrier','Fixture carrier','trackingNumber','FIXTURE-INBOUND-1','photoUrls',jsonb_build_array('storage://return-evidence-private/fixture/pickup.png'),'pickedUpBy','Shipper Nguyen','pickedUpAt',now()),version_value,cskh);
 select version into version_value from public.return_item where return_item_id=i;
 begin perform public.velura_return_item_action(h,i,'stop','{"reason":"Customer cancels after shipping"}',version_value,cskh); raise exception 'Shipped parcel stopped';
 exception when sqlstate 'PT422' then null; end;
 select stock_quantity into stock_before from public.variant where variant_id='94000000-0000-4000-8000-000000000031';
 select version into version_value from public.return_item where return_item_id=i;
 perform public.velura_return_item_action(h,i,'receive',receipt,version_value,cskh);
 if (select item_status from public.return_item where return_item_id=i)<>'RECEIVED' or (select seal_intact from public.return_item where return_item_id=i) is distinct from false then raise exception 'Broken seal rejected valid product'; end if;
 if (select stock_quantity from public.variant where variant_id='94000000-0000-4000-8000-000000000031')<>stock_before+1 then raise exception 'Valid restock missing'; end if;
 begin perform public.velura_return_item_action(h,i,'receive',receipt,version_value,cskh); raise exception 'Receipt replay accepted stale version'; exception when sqlstate 'PT409' then null; end;
 if (select count(*) from public.return_stock_movement where return_item_id=i)<>1 then raise exception 'Restock duplicated'; end if;
 select version into version_value from public.return_item where return_item_id=i;
 perform public.velura_return_item_action(h,i,'prepare_exchange','{}',version_value,cskh);
 select exchange_order_id into replacement_id from public.return_item where return_item_id=i;
 if not exists(select 1 from public.orders where order_id=replacement_id and parent_order_id=order_id_value and source_return_item_id=i and total_amount=0 and subtotal=0 and discount_amount=0 and shipping_fee=0) then raise exception 'Replacement revenue/order lineage incorrect'; end if;
 select version into version_value from public.return_item where return_item_id=i;
 perform public.velura_return_item_action(h,i,'ship_exchange','{"carrier":"Fixture carrier","trackingNumber":"FIXTURE-EXCHANGE-1"}',version_value,cskh);
 select version into version_value from public.return_item where return_item_id=i;
 begin perform public.velura_return_item_action(h,i,'complete_exchange','{}',version_value,cskh); raise exception 'Unconfirmed delivery consumed quota'; exception when sqlstate 'PT422' then null; end;
 perform public.velura_order_service_action(replacement_id,'carrier_delivered',null,'Carrier confirms actual delivery','{}',null);
 if (select item_status from public.return_item where return_item_id=i)<>'COMPLETED' then raise exception 'Delivered exchange did not complete target'; end if;
 select m.unit_number into unit_value from public.return_item_unit m where m.return_item_id=i;
 if (select success_count from public.return_unit where order_item_id=original_item and unit_number=unit_value)<>1 then raise exception 'Exchange success not counted once'; end if;
 -- Hold all other units so the second request must follow the same original-unit lineage.
 update public.return_unit set active_return_item_id=remainder where order_item_id=original_item and unit_number<>unit_value;
 insert into public.return_exchange(order_id,user_id,return_type,status,description) values(order_id_value,actor,'exchange','REQUESTED','Second original-unit request') returning return_id into second_h;
 insert into public.return_item(return_id,order_item_id,quantity) values(second_h,original_item,1) returning return_item_id into i;
 perform public.velura_reserve_return_units(i);
 insert into public.return_evidence(return_id,kind,storage_bucket,storage_path,mime_type,uploaded_by_role,uploaded_by) values
 (second_h,'qa_photo','return-evidence-private','fixture/qa.png','image/png','admin',cskh),
 (second_h,'refund_proof','return-evidence-private','fixture/refund.png','image/png','admin',cskh),
 (second_h,'pickup_photo','return-evidence-private','fixture/pickup.png','image/png','carrier',cskh);
 perform public.velura_return_item_action(second_h,i,'approve','{"reason":"Second exchange decision"}',1,actor);
 select version into version_value from public.return_item where return_item_id=i;
 perform public.velura_return_item_action(second_h,i,'wait_return','{}',version_value,cskh);
 select version into version_value from public.return_item where return_item_id=i;
 select version into version_value from public.return_item where return_item_id=i;
 perform public.velura_return_item_action(second_h,i,'pickup',jsonb_build_object('carrier','Fixture carrier','trackingNumber','FIXTURE-INBOUND-2','photoUrls',jsonb_build_array('storage://return-evidence-private/fixture/pickup.png'),'pickedUpBy','Shipper Tran','pickedUpAt',now()),version_value,cskh);
 select version into version_value from public.return_item where return_item_id=i;
 perform public.velura_return_item_action(second_h,i,'receive',receipt,version_value,cskh);
 select version into version_value from public.return_item where return_item_id=i;
 begin perform public.velura_return_item_action(second_h,i,'convert_refund','{"reason":"Customer asks refund"}',version_value,cskh); raise exception 'Conversion without consent accepted'; exception when sqlstate 'PT422' then null; end;
 perform public.velura_return_item_action(second_h,i,'convert_refund','{"reason":"Customer consents to refund","customerConsent":true}',version_value,cskh);
 if (select return_type::text from public.return_exchange where return_id=second_h)<>'exchange' then raise exception 'Conversion mutated initial type'; end if;
 select version into version_value from public.return_item where return_item_id=i;
 begin perform public.velura_prepare_return_refund(second_h,order_id_value,version_value,i); raise exception 'COD refunded without receiver'; exception when sqlstate 'PT422' then get stacked diagnostics message_value=message_text; if message_value<>'REFUND_RECEIVER_REQUIRED' then raise exception 'Wrong receiver error %',message_value; end if; end;
 perform public.velura_set_return_refund_receiver(second_h,actor,'Fixture Bank','0123456789','Fixture Customer');
 begin perform public.velura_record_manual_return_refund(second_h,version_value,'FIXTURE-REFUND',100000,now(),'https://arbitrary.invalid/proof',null,cskh,i); raise exception 'Arbitrary proof accepted'; exception when sqlstate 'PT422' then null; end;
 op:=public.velura_prepare_return_refund(second_h,order_id_value,version_value,i);
 replay:=public.velura_prepare_return_refund(second_h,order_id_value,999,i);
 if op->>'refund_id'<>replay->>'refund_id' then raise exception 'Financial retry changed operation'; end if;
 if (select item_status from public.return_item where return_item_id=i)<>'REFUND_PENDING' then raise exception 'Pending refund completed prematurely'; end if;
 op:=public.velura_record_manual_return_refund(second_h,version_value,'FIXTURE-REFUND',100000,now(),'storage://return-evidence-private/fixture/refund.png','Verified transfer',cskh,i);
 replay:=public.velura_complete_return_refund(second_h,'manual:FIXTURE-REFUND',i);
 if (select refunded_amount from public.payment where payment_id='94000000-0000-4000-8000-000000000060')<>100000 then raise exception 'Replay double-refunded'; end if;
 if not exists(select 1 from public.return_manual_refund where return_item_id=i and receiver_account_number='0123456789') then raise exception 'Receiver snapshot missing'; end if;
 if not exists(select 1 from public.return_unit where order_item_id=original_item and unit_number=unit_value and success_count=2 and refunded and active_return_item_id is null) then raise exception 'Second success did not retire refunded unit'; end if;
 if (select status::text from public.orders where order_id=order_id_value)<>'delivered' then raise exception 'Original order mutated'; end if;
 if not exists(select 1 from public.audit_log where module='returns' and target_id=i and actor_id=cskh and ip_address='192.0.2.84') then raise exception 'Actor/IP audit missing'; end if;
 -- Converting an approved exchange before handover must keep waiting for the goods, not strand NEEDS_SUPPORT.
 select count(*) into unit_value from public.return_unit where order_item_id=original_item and active_return_item_id is null and not refunded and success_count<2;
 if unit_value>0 then
  insert into public.return_exchange(order_id,user_id,return_type,status,description) values(order_id_value,actor,'exchange','REQUESTED','Early conversion request') returning return_id into second_h;
  insert into public.return_item(return_id,order_item_id,quantity) values(second_h,original_item,1) returning return_item_id into i;
  perform public.velura_reserve_return_units(i);
  perform public.velura_return_item_action(second_h,i,'approve','{"reason":"Approve exchange before handover"}',1,actor);
  select version into version_value from public.return_item where return_item_id=i;
  perform public.velura_return_item_action(second_h,i,'convert_refund','{"reason":"Customer changes mind before shipping","customerConsent":true}',version_value,cskh);
  if (select item_status from public.return_item where return_item_id=i)<>'WAITING_RETURN' then raise exception 'Early conversion left unusable stage'; end if;
  select version into version_value from public.return_item where return_item_id=i;
  perform public.velura_return_item_action(second_h,i,'stop','{"reason":"Customer withdraws after conversion"}',version_value,cskh);
 end if;
end $$;
rollback;
