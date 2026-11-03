-- Migration 107: Allow manual refund for delivered COD orders even if payment row is missing or pending
-- Resolves PT422 COD_PAYMENT_REQUIRED when admin confirms manual refund on return requests.

create or replace function public.velura_record_return_manual_refund(
  p_return_id uuid,
  p_expected_version integer,
  p_reference text,
  p_amount numeric,
  p_transferred_at timestamptz,
  p_proof text,
  p_note text,
  p_actor_id uuid,
  p_return_item_id uuid
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  h public.return_exchange%rowtype;
  p public.payment%rowtype;
  receiver public.return_refund_receiver%rowtype;
  op jsonb;
  prior public.return_manual_refund%rowtype;
  reference_value text := btrim(p_reference);
  v_order_pm text;
  v_order_total numeric;
begin
  perform public.velura_require_return_actor(p_actor_id);

  select * into h from public.return_exchange where return_id = p_return_id for update;
  if not found then
    raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND';
  end if;

  select * into prior from public.return_manual_refund where return_item_id = p_return_item_id;
  if found then
    if upper(prior.reference) = upper(reference_value) and prior.amount = p_amount then
      return to_jsonb(prior);
    end if;
    raise sqlstate 'PT409' using message = 'REFUND_ALREADY_REQUESTED';
  end if;

  select payment_method, coalesce(total_amount, p_amount) into v_order_pm, v_order_total
  from public.orders where order_id = h.order_id;

  select * into p from public.payment where order_id = h.order_id order by created_at desc limit 1 for update;
  if not found then
    if upper(coalesce(v_order_pm, '')) = 'COD' then
      insert into public.payment(order_id, payment_method, payment_provider, amount, payment_status, created_at, paid_at)
      values(h.order_id, 'COD', 'cod', coalesce(v_order_total, p_amount), 'paid', now(), now())
      returning * into p;
    else
      raise sqlstate 'PT422' using message = 'COD_PAYMENT_REQUIRED';
    end if;
  else
    if upper(coalesce(p.payment_method::text, v_order_pm, '')) <> 'COD' or coalesce(p.payment_provider, '') = 'stripe' then
      raise sqlstate 'PT422' using message = 'COD_PAYMENT_REQUIRED';
    end if;
    if p.payment_status not in ('paid', 'refund_pending') then
      update public.payment set payment_status = 'paid', paid_at = coalesce(paid_at, now())
      where payment_id = p.payment_id returning * into p;
    end if;
  end if;

  if not public.velura_return_refund_receiver_ready(p_return_id) then
    raise sqlstate 'PT422' using message = 'REFUND_RECEIVER_REQUIRED';
  end if;

  if reference_value is null or length(reference_value) < 6 then
    raise sqlstate 'PT422' using message = 'TRANSFER_REFERENCE_REQUIRED';
  end if;

  if exists(select 1 from public.return_manual_refund where upper(btrim(reference)) = upper(reference_value)) then
    raise sqlstate 'PT409' using message = 'DUPLICATE_TRANSFER_REFERENCE';
  end if;

  if p_transferred_at is null or p_transferred_at > now() + interval '5 minutes' or p_transferred_at < h.created_at then
    raise sqlstate 'PT422' using message = 'TRANSFER_TIME_INVALID';
  end if;

  if not public.velura_return_evidence_owned(p_return_id, p_proof, array['refund_proof'], p_actor_id) then
    raise sqlstate 'PT422' using message = 'TRANSFER_PROOF_REQUIRED';
  end if;

  op := public.velura_prepare_return_refund(p_return_id, h.order_id, p_expected_version, p_return_item_id);
  if p_amount is null or p_amount <> (op->>'amount')::numeric then
    raise sqlstate 'PT422' using message = 'REFUND_AMOUNT_MISMATCH';
  end if;

  select * into receiver from public.return_refund_receiver where return_id = p_return_id;
  insert into public.return_manual_refund(
    return_id, return_item_id, refund_id, payment_kind, reference, amount, transferred_at,
    receiver_bank_name, receiver_account_number, receiver_account_holder, proof, note, recorded_by
  )
  values(
    p_return_id, p_return_item_id, (op->>'refund_id')::uuid, 'cod', reference_value, p_amount, p_transferred_at,
    receiver.bank_name, receiver.account_number, receiver.account_holder, p_proof, p_note, p_actor_id
  );

  op := public.velura_complete_return_refund(p_return_id, 'manual:' || upper(reference_value), p_return_item_id);

  perform public.velura_append_module_audit(
    'returns', p_actor_id, (select admin_role::text from public.users where user_id = p_actor_id),
    'update', p_return_item_id, null,
    op || jsonb_build_object('reference', reference_value, 'proof', p_proof, 'transferred_at', p_transferred_at),
    coalesce(nullif(current_setting('request.headers', true)::jsonb->>'x-velura-client-ip', ''), nullif(current_setting('x-velura-client-ip', true), ''), '127.0.0.1')
  );

  return op;
end; $$;
