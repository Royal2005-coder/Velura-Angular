-- Disposable/local PostgreSQL only, after migrations 084-087. All fixtures roll back.
\set ON_ERROR_STOP on
begin;
set local session_replication_role=replica;
insert into public.users(user_id,email,password_hash,full_name,role,is_active) values
 ('9f000000-0000-4000-8000-000000000001','loyalty-spend@example.invalid','fixture','Spend Member','member',true);
insert into public.category(category_id,name,slug) values('9f000000-0000-4000-8000-000000000010','Spend','loyalty-spend');
insert into public.product(product_id,category_id,sku,name,slug,base_price,sale_price,status) values
 ('9f000000-0000-4000-8000-000000000020','9f000000-0000-4000-8000-000000000010','SPEND-1','Spend','loyalty-spend',200000,200000,'on_sale');
insert into public.variant(variant_id,product_id,color,size,stock_quantity,reserved_quantity) values
 ('9f000000-0000-4000-8000-000000000031','9f000000-0000-4000-8000-000000000020','Black','M',10,0);
insert into public.orders(order_id,user_id,order_code,status,shipping_name,shipping_phone,shipping_address,subtotal,discount_amount,total_amount,shipping_fee,payment_method,delivered_at) values
 ('9f000000-0000-4000-8000-000000000040','9f000000-0000-4000-8000-000000000001','SPEND-EARN','delivered','Spend','0900000099','Test',200000,0,200000,0,'COD',now()-interval '1 day'),
 ('9f000000-0000-4000-8000-000000000041','9f000000-0000-4000-8000-000000000001','SPEND-ORDER','waiting_payment','Spend','0900000099','Test',100000,0,95000,0,'ONLINE_PAYMENT',null);
insert into public.order_item(item_id,order_id,variant_id,product_name,quantity,unit_price,subtotal_item) values
 ('9f000000-0000-4000-8000-000000000050','9f000000-0000-4000-8000-000000000040','9f000000-0000-4000-8000-000000000031','Spend',1,200000,200000),
 ('9f000000-0000-4000-8000-000000000051','9f000000-0000-4000-8000-000000000041','9f000000-0000-4000-8000-000000000031','Spend',1,100000,100000);
insert into public.payment(payment_id,order_id,payment_method,payment_provider,amount,payment_status) values
 ('9f000000-0000-4000-8000-000000000060','9f000000-0000-4000-8000-000000000040','COD','cod',200000,'paid'),
 ('9f000000-0000-4000-8000-000000000061','9f000000-0000-4000-8000-000000000041','ONLINE_PAYMENT','stripe',95000,'pending');
set local session_replication_role=origin;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);


-- Isolated fixture supplies the commerce half normally installed by migration 064.
create or replace function public.velura_create_checkout_order_commerce(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_order public.orders%rowtype; v_item jsonb;
begin
  insert into public.orders(user_id,is_guest,checkout_request_key,status,shipping_name,shipping_phone,shipping_address,
    shipping_fee,discount_amount,subtotal,total_amount,payment_method,order_code,stock_committed_at,created_at,updated_at)
  values((p_input->>'userId')::uuid,false,nullif(p_input->>'idempotencyKey',''),'pending',
    p_input#>>'{contact,fullName}',p_input#>>'{contact,phone}',p_input->>'shippingAddress',
    (p_input->>'shippingFee')::numeric,(p_input->>'discountAmount')::numeric,(p_input->>'subtotal')::numeric,
    (p_input->>'totalAmount')::numeric,(p_input->>'paymentMethod')::public.payment_method,p_input->>'orderCode',now(),now(),now())
  returning * into v_order;
  for v_item in select x from jsonb_array_elements(p_input->'items') x loop
    insert into public.order_item(order_id,variant_id,product_name,quantity,unit_price,subtotal_item)
    values(v_order.order_id,(v_item->>'variantId')::uuid,v_item->>'productName',(v_item->>'quantity')::integer,
      (v_item->>'unitPrice')::numeric,(v_item->>'subtotal')::numeric);
  end loop;
  return jsonb_build_object('order',to_jsonb(v_order),'items',(select coalesce(jsonb_agg(to_jsonb(oi)),'[]') from public.order_item oi where order_id=v_order.order_id));
end; $$;

do $$
declare a public.loyalty_account%rowtype; q jsonb; lot public.loyalty_point_lot%rowtype; v_order uuid;
begin
  perform public.velura_award_order_loyalty('9f000000-0000-4000-8000-000000000040');
  select * into a from public.loyalty_account where user_id='9f000000-0000-4000-8000-000000000001';
  if a.balance_milli_points<>10000 then raise exception '5%% of 200000 must be 10000 milli, got %',a.balance_milli_points; end if;
  if (select points_earned_milli from public.orders where order_id='9f000000-0000-4000-8000-000000000040')<>10000 then
    raise exception 'Order earned value not 5%%'; end if;
  select * into lot from public.loyalty_point_lot where user_id='9f000000-0000-4000-8000-000000000001' and source='award';
  if lot.remaining_milli<>10000 or lot.expires_at<now()+interval '5 months 29 days' then raise exception 'Award lot/expiry wrong'; end if;

  -- Policy starts disabled and becomes explicit after a super-admin-style settings change.
  begin perform public.velura_loyalty_quote('9f000000-0000-4000-8000-000000000001',100000,0,0,5);
    raise exception 'Quote allowed while spending disabled'; exception when sqlstate 'PT409' then null; end;
  update public.loyalty_settings set spending_enabled=true,policy_approved_at=now() where id;
  q:=public.velura_loyalty_quote('9f000000-0000-4000-8000-000000000001',100000,0,0,10);
  if (q->>'points_discount_amount')::numeric<>10000 or (q->>'max_points')::integer<>10 then
    raise exception 'Quote cap/amount wrong: %',q; end if;
  begin perform public.velura_loyalty_quote('9f000000-0000-4000-8000-000000000001',100000,0,0,11);
    raise exception 'Quote exceeded available points'; exception when sqlstate 'PT409' then null; end;

  -- Atomic checkout wrapper: order, points ledger and FIFO lot consumption commit together.
  q:=public.velura_create_checkout_order(jsonb_build_object(
    'userId','9f000000-0000-4000-8000-000000000001','actorId','9f000000-0000-4000-8000-000000000001','isGuest',false,
    'idempotencyKey','loyalty-spend-checkout','subtotal',100000,'shippingFee',0,'discountAmount',0,
    'totalAmount',95000,'pointsSpent',5,'paymentMethod','COD','orderCode','SPEND-CHECKOUT-1',
    'shippingAddress','Test','contact',jsonb_build_object('fullName','Spend','phone','0900000099','email','spend@example.invalid'),
    'items',jsonb_build_array(jsonb_build_object('variantId','9f000000-0000-4000-8000-000000000031','quantity',1,
      'productName','Spend','unitPrice',100000,'subtotal',100000))));
  v_order:=(q#>>'{order,order_id}')::uuid;
  select * into a from public.loyalty_account where user_id='9f000000-0000-4000-8000-000000000001';
  if a.balance_milli_points<>5000 or (select points_used from public.orders where order_id=v_order)<>5
     or (select total_amount from public.orders where order_id=v_order)<>95000 then
    raise exception 'Atomic checkout did not consume points/order total: %',q; end if;
  if (select remaining_milli from public.loyalty_point_lot where user_id='9f000000-0000-4000-8000-000000000001' and source='award')<>5000 then
    raise exception 'FIFO lot not consumed by checkout'; end if;
  update public.orders set status='cancelled' where order_id=v_order;
  select * into a from public.loyalty_account where user_id='9f000000-0000-4000-8000-000000000001';
  if a.balance_milli_points<>10000 or not exists(select 1 from public.loyalty_ledger where order_id=v_order and kind='redeem_refund') then
    raise exception 'Cancel did not restore points exactly once: %',to_jsonb(a); end if;
  update public.orders set status='cancelled' where order_id=v_order;
  if (select count(*) from public.loyalty_ledger where order_id=v_order and kind='redeem_refund')<>1 then
    raise exception 'Cancel restore duplicated'; end if;

  -- Expired lots leave the spendable balance and are recorded once.
  insert into public.loyalty_point_lot(user_id,earned_milli,remaining_milli,expires_at,source)
    values('9f000000-0000-4000-8000-000000000001',2000,2000,now()-interval '1 day','reconcile');
  update public.loyalty_account set balance_milli_points=12000 where user_id='9f000000-0000-4000-8000-000000000001';
  perform public.velura_expire_loyalty_lots('9f000000-0000-4000-8000-000000000001');
  select * into a from public.loyalty_account where user_id='9f000000-0000-4000-8000-000000000001';
  if a.balance_milli_points<>10000 then raise exception 'Expiry did not reduce balance'; end if;
  if not exists(select 1 from public.loyalty_ledger where kind='expired' and amount_milli_points=-2000) then
    raise exception 'Expiry ledger missing'; end if;
end $$;
rollback;
