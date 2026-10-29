-- Disposable/local PostgreSQL only, after084 and085. Synthetic storage metadata; no storage/network I/O.
\set ON_ERROR_STOP on
begin;
set local session_replication_role=replica;
 insert into public.users(user_id,email,password_hash,full_name,role,is_active) values
 ('95000000-0000-4000-8000-000000000099','intake-owner@example.invalid','fixture','Intake Owner','member',true) on conflict do nothing;
 insert into public.orders(order_id,user_id,order_code,status,shipping_name,shipping_phone,shipping_address,subtotal,total_amount,payment_method,delivered_at)
 values ('95000000-0000-4000-8000-000000000001','95000000-0000-4000-8000-000000000099','INTAKE-085','delivered','Intake','0900000085','Local',600000,600000,'COD',now()-interval '7 days'),
 ('95000000-0000-4000-8000-000000000002','95000000-0000-4000-8000-000000000099','OTHER-085','delivered','Other','0900000086','Local',1,1,'COD',now());
insert into public.variant(variant_id,product_id,color,size,stock_quantity) values
('95000000-0000-4000-8000-000000000011','95000000-0000-4000-8000-000000000020','Black','M',10),
('95000000-0000-4000-8000-000000000012','95000000-0000-4000-8000-000000000020','Black','L',10);
insert into public.order_item(item_id,order_id,variant_id,product_name,quantity,unit_price,subtotal_item) values
('95000000-0000-4000-8000-000000000031','95000000-0000-4000-8000-000000000001','95000000-0000-4000-8000-000000000011','Intake item',3,200000,600000);
set local session_replication_role=origin;
insert into public.return_intake_upload(storage_ref,order_id,storage_bucket,storage_path,mime_type,kind)
select 'storage://return-evidence-private/return-intake/085/'||n||'.jpg','95000000-0000-4000-8000-000000000001','return-evidence-private','return-intake/085/'||n||'.jpg','image/jpeg','request_photo' from generate_series(1,5) n;
insert into public.return_intake_upload(storage_ref,order_id,storage_bucket,storage_path,mime_type,kind)
select 'storage://return-evidence-private/return-intake/085/'||n||'.mp4','95000000-0000-4000-8000-000000000001','return-evidence-private','return-intake/085/'||n||'.mp4','video/mp4','request_video' from generate_series(1,5) n;
insert into public.return_intake_upload(storage_ref,order_id,storage_bucket,storage_path,mime_type,kind) values
('storage://return-evidence-private/return-intake/other/photo.jpg','95000000-0000-4000-8000-000000000002','return-evidence-private','return-intake/other/photo.jpg','image/jpeg','request_photo');

do $$
declare
  payload jsonb:=jsonb_build_object('order_id','95000000-0000-4000-8000-000000000001','user_id','95000000-0000-4000-8000-000000000099','return_type','exchange','reason','Size does not fit',
    'evidence_images',jsonb_build_array('storage://return-evidence-private/return-intake/085/1.jpg'),
    'evidence_videos',jsonb_build_array('storage://return-evidence-private/return-intake/085/1.mp4'));
  items jsonb:=jsonb_build_array(jsonb_build_object('order_item_id','95000000-0000-4000-8000-000000000031','quantity',1,'replacement_variant_id','95000000-0000-4000-8000-000000000012'));
  result jsonb; second_result jsonb; bad jsonb; message text; before_count int;
begin
  select count(*) into before_count from public.return_exchange;
  -- Reason, both media kinds, ownership and trusted type are enforced inside the transaction.
  foreach bad in array array[payload||'{"reason":""}'::jsonb,payload||'{"evidence_images":[]}'::jsonb,payload||'{"evidence_videos":[]}'::jsonb,
    payload||'{"evidence_images":["https://attacker.test/photo.jpg"]}'::jsonb,
    payload||'{"evidence_images":["storage://return-evidence-private/return-intake/other/photo.jpg"]}'::jsonb,
    payload||'{"evidence_videos":["storage://return-evidence-private/return-intake/085/1.jpg"]}'::jsonb]
  loop
    begin
      perform public.velura_create_return_request(bad,items);
      raise exception 'Invalid proof/reason accepted: %',bad;
    exception when sqlstate 'PT422' then null;
    end;
  end loop;
  if (select count(*) from public.return_exchange)<>before_count then raise exception 'Failed intake left a request'; end if;
  if exists(select 1 from public.return_intake_upload where claimed_return_id is not null and order_id='95000000-0000-4000-8000-000000000001') then raise exception 'Failed intake claimed proof'; end if;

  -- Exactly seven days is accepted. The original remains delivered and the requested variant survives.
  result:=public.velura_create_return_request(payload,items);
  if result->'items'->0->>'replacement_variant_id'<>'95000000-0000-4000-8000-000000000012' then raise exception 'Replacement identity lost'; end if;
  if exists(select 1 from public.return_refund_receiver where return_id=(result->>'return_id')::uuid) then raise exception 'Optional bank manufactured'; end if;
  if (select count(*) from public.return_evidence where return_id=(result->>'return_id')::uuid)<>2 then raise exception 'Both initial media not claimed'; end if;

  -- Disjoint remaining quantity is available despite an active part. Supplied COD bank is bridged privately.
  payload:=payload||jsonb_build_object('return_type','refund','evidence_images',jsonb_build_array('storage://return-evidence-private/return-intake/085/2.jpg'),
    'evidence_videos',jsonb_build_array('storage://return-evidence-private/return-intake/085/2.mp4'),
    'refund_bank_name','VCB','refund_bank_account','0123456789','refund_bank_holder','NGUYEN VAN A');
  second_result:=public.velura_create_return_request(payload,items);
  if not exists(select 1 from public.return_refund_receiver where return_id=(second_result->>'return_id')::uuid and account_number='0123456789') then raise exception 'COD bank bridge lost'; end if;
  if (select count(*) from public.return_unit where order_item_id='95000000-0000-4000-8000-000000000031' and active_return_item_id is not null)<>2 then raise exception 'Disjoint quota reservation failed'; end if;
  begin
    perform public.velura_create_return_request(payload,items);
    raise exception 'Claimed evidence replay accepted';
  exception when sqlstate 'PT422' then null;
  end;

  -- Availability returns per-unit rows with calculated refundable amount.
  if not exists(select 1 from public.velura_return_unit_availability('95000000-0000-4000-8000-000000000031')) then
    raise exception 'Availability returned empty';
  end if;

  -- Customer cancellation releases mapped active units under 084 guard.
  perform public.velura_cancel_customer_return((second_result->>'return_id')::uuid, (second_result->>'version')::int);
  if (select status from public.return_exchange where return_id=(second_result->>'return_id')::uuid)::text <> 'CANCELLED' then
    raise exception 'Customer cancellation failed';
  end if;

  -- Future, missing and just-expired delivery cannot borrow order updated_at.
  foreach message in array array['future','missing','expired'] loop
    update public.orders set delivered_at=case message when 'future' then now()+interval '1 second' when 'missing' then null else now()-interval '7 days 1 millisecond' end
      where order_id='95000000-0000-4000-8000-000000000001';
    begin
      perform public.velura_create_return_request(payload,items);
      raise exception 'Invalid delivery window accepted: %',message;
    exception when sqlstate 'PT422' then
      get stacked diagnostics message=message_text;
      if message<>'RETURN_WINDOW_CLOSED' then raise exception 'Wrong failure: %',message; end if;
    end;
  end loop;
end $$;
rollback;
