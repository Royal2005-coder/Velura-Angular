-- Disposable PostgreSQL/Supabase only, after baseline migrations 038/041.
-- psql -v ON_ERROR_STOP=1 -f tests/database/order-cancel-stock.sql
\set ON_ERROR_STOP on
begin;
set local session_replication_role=replica;
insert into public.users(user_id,email,password_hash,full_name,role,is_active) values
 ('9a000000-0000-4000-8000-000000000001','cancel-stock@example.invalid','fixture','Cancel Customer','member',true);
insert into public.category(category_id,name,slug) values('9a000000-0000-4000-8000-000000000010','Cancel','cancel-stock');
insert into public.product(product_id,category_id,sku,name,slug,base_price,sale_price,status) values
 ('9a000000-0000-4000-8000-000000000020','9a000000-0000-4000-8000-000000000010','CANCEL-1','Cancel','cancel-stock',100000,100000,'on_sale');
insert into public.variant(variant_id,product_id,color,size,stock_quantity,reserved_quantity) values
 ('9a000000-0000-4000-8000-000000000031','9a000000-0000-4000-8000-000000000020','Black','M',10,2);
insert into public.orders(order_id,user_id,order_code,status,shipping_name,shipping_phone,shipping_address,subtotal,discount_amount,total_amount,shipping_fee,payment_method,stock_reserved_at,stock_committed_at,created_at,updated_at) values
 ('9a000000-0000-4000-8000-000000000040','9a000000-0000-4000-8000-000000000001','CANCEL-UNPAID','waiting_payment','Cancel','0900000091','Test',100000,0,100000,0,'ONLINE_PAYMENT',now(),null,now(),now()),
 ('9a000000-0000-4000-8000-000000000041','9a000000-0000-4000-8000-000000000001','CANCEL-PAID','confirmed','Cancel','0900000091','Test',100000,0,100000,0,'COD',now(),now(),now(),now());
insert into public.order_item(item_id,order_id,variant_id,product_name,quantity,unit_price,subtotal_item) values
 ('9a000000-0000-4000-8000-000000000050','9a000000-0000-4000-8000-000000000040','9a000000-0000-4000-8000-000000000031','Cancel',1,100000,100000),
 ('9a000000-0000-4000-8000-000000000051','9a000000-0000-4000-8000-000000000041','9a000000-0000-4000-8000-000000000031','Cancel',1,100000,100000);
insert into public.payment(payment_id,order_id,payment_method,payment_provider,amount,payment_status) values
 ('9a000000-0000-4000-8000-000000000060','9a000000-0000-4000-8000-000000000040','ONLINE_PAYMENT','stripe',100000,'pending'),
 ('9a000000-0000-4000-8000-000000000061','9a000000-0000-4000-8000-000000000041','COD','cod',100000,'paid');
set local session_replication_role=origin;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $$
declare
 actor uuid := '9a000000-0000-4000-8000-000000000001';
 unpaid uuid := '9a000000-0000-4000-8000-000000000040';
 paid uuid := '9a000000-0000-4000-8000-000000000041';
 variant uuid := '9a000000-0000-4000-8000-000000000031';
begin
 -- Unpaid online order: cancel must release the reservation, never restock undeducted stock.
 perform public.velura_order_service_action(unpaid,'customer_cancel',actor,'Khách đổi ý','{}'::jsonb,1);
 if (select status::text from public.orders where order_id=unpaid)<>'cancelled' then raise exception 'Unpaid order not cancelled'; end if;
 if (select reserved_quantity from public.variant where variant_id=variant)<>1 then raise exception 'Reservation not released for unpaid order'; end if;
 if (select stock_quantity from public.variant where variant_id=variant)<>10 then raise exception 'Unpaid cancel restocked stock that was never deducted'; end if;
 if (select stock_reservation_released_at from public.orders where order_id=unpaid) is null then raise exception 'Reservation release timestamp missing'; end if;

 -- Paid/committed order: cancel restocks the deducted unit exactly once.
 update public.orders set stock_reserved_at=now(),stock_committed_at=now(),stock_reservation_released_at=now() where order_id=paid;
 update public.variant set stock_quantity=9,reserved_quantity=0 where variant_id=variant;
 perform public.velura_order_service_action(paid,'customer_cancel',actor,'Khách đổi ý','{}'::jsonb,1);
 if (select stock_quantity from public.variant where variant_id=variant)<>10 then raise exception 'Committed order not restocked'; end if;
 if (select stock_returned_at from public.orders where order_id=paid) is null then raise exception 'Restock timestamp missing'; end if;
end $$;
rollback;
