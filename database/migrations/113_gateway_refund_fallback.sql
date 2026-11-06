-- KAN-109: VNPay/MoMo hoàn tiền được như Stripe, và khi cổng từ chối thì CSKH có đường lùi thật.
--
-- Vì sao: `classifyReturnPayment` đã xếp MoMo/VNPay vào nhóm "online khác" từ lâu, nhưng mọi đường
-- thực thi tiền đều chặn ở Stripe/COD: `velura_record_manual_return_refund` từ chối đơn không phải
-- COD, còn `velura_return_requires_refund_receiver` chỉ bật cho COD. Kết quả là một đơn VNPay/MoMo
-- cần hoàn tiền KHÔNG CÓ hành động nào chạy được — không tự động, cũng không ghi tay được.
--
-- Cách giải quyết: giữ nguyên bất biến "một phần hàng chỉ được trả tiền một lần". Đường chuyển
-- khoản tay cho đơn qua cổng chỉ mở khi chính phần hàng đó đã có một lần refund bị cổng từ chối
-- (payment_refund.status='failed'), tức là đã chắc chắn tiền chưa về từ cổng.
begin;

-- QR payload của phiên hosted (MoMo trả qrCodeUrl là DỮ LIỆU để vẽ QR, không phải ảnh). Lưu lại để
-- khách thoát ra rồi vào lại vẫn quét đúng mã của đơn, không phải mở lại phiên mới.
alter table public.payment add column if not exists gateway_qr_url text;

-- COD luôn cần tài khoản nhận. Đơn qua cổng cần thêm khi nhà mạng đã từ chối lệnh hoàn tiền.
create or replace function public.velura_return_requires_refund_receiver(p_return_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(
   select 1 from public.return_exchange r
   where r.return_id=p_return_id
     and (r.return_type::text='refund'
          or exists(select 1 from public.return_item i where i.return_id=r.return_id and i.resolution_type='refund'))
     and (
       exists(select 1 from public.orders o where o.order_id=r.order_id and o.payment_method::text='COD')
       -- tiền đã bị cổng từ chối trả → buộc phải chuyển khoản tay → buộc phải có tài khoản nhận
       or exists(select 1 from public.payment_refund pf where pf.return_id=r.return_id and pf.status::text='failed')
     ));
 $$;
revoke all on function public.velura_return_requires_refund_receiver(uuid) from public,anon,authenticated;
grant execute on function public.velura_return_requires_refund_receiver(uuid) to service_role;

-- 084 là bản đang chạy; viết lại chỉ để thay điều kiện nhà mạng và ghi đúng payment_kind.
create or replace function public.velura_record_manual_return_refund(
 p_return_id uuid,p_expected_version integer,p_reference text,p_amount numeric,p_transferred_at timestamptz,
 p_proof text,p_note text,p_actor_id uuid,p_return_item_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare h public.return_exchange%rowtype; p public.payment%rowtype; receiver public.return_refund_receiver%rowtype;
 op jsonb; prior public.return_manual_refund%rowtype; reference_value text:=btrim(p_reference);
 kind text; gateway_refund_failed boolean;
begin
 perform public.velura_require_return_actor(p_actor_id);
 select * into h from public.return_exchange where return_id=p_return_id for update;
 if not found then raise sqlstate 'PT404' using message='RETURN_NOT_FOUND'; end if;
 select * into prior from public.return_manual_refund where return_item_id=p_return_item_id;
 if found then
  if upper(prior.reference)=upper(reference_value) and prior.amount=p_amount then return to_jsonb(prior); end if;
  raise sqlstate 'PT409' using message='REFUND_ALREADY_REQUESTED';
 end if;
 select * into p from public.payment where order_id=h.order_id order by created_at desc limit 1 for update;
 if p.payment_method::text='COD' then
   kind:='cod';
 elsif p.payment_provider in ('stripe','vnpay','momo') then
   -- COD thì tiền đi tay là đường chính. Đơn qua cổng chỉ được ghi tay SAU KHI cổng từ chối lệnh
   -- hoàn của chính phần hàng này; nếu không sẽ hoàn hai lần cho cùng một phần hàng.
   select exists(select 1 from public.payment_refund pf
     where pf.return_item_id=p_return_item_id and pf.status::text='failed') into gateway_refund_failed;
   if not gateway_refund_failed then raise sqlstate 'PT422' using message='GATEWAY_REFUND_REQUIRED'; end if;
   kind:='other_online';
 else
   -- Không có payment row (đơn COD đời đầu) hoặc nhà mạng không xác định: giữ nguyên lỗi cũ.
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
 'Ghi chuyển khoản tay cho phần hoàn tiền: COD tự do, đơn qua cổng chỉ sau khi cổng từ chối (payment_refund failed).';

notify pgrst,'reload schema';
commit;
