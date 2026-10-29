-- KAN-106: independently versioned return parts, original-unit quota and financial operations.
-- New enum values are used only by RPCs after this migration commits (runner owns the transaction).
alter type public.return_status add value if not exists 'APPROVED';
alter type public.return_status add value if not exists 'IN_PROGRESS';
alter type public.return_status add value if not exists 'REJECTED';

alter table public.return_exchange
  add column if not exists decision_status text not null default 'PENDING',
  add column if not exists attention_status text,
  add column if not exists contact_history jsonb not null default '[]'::jsonb,
  add column if not exists last_contact_at timestamptz;
alter table public.return_item
  add column if not exists item_status text not null default 'REQUESTED',
  add column if not exists decision_status text not null default 'pending',
  add column if not exists resolution_type text,
  add column if not exists version integer not null default 1,
  add column if not exists reason text,
  add column if not exists attention_status text,
  add column if not exists support_previous_status text,
  add column if not exists exchange_order_id uuid references public.orders(order_id),
  add column if not exists refund_amount numeric not null default 0,
  add column if not exists received_quantity integer not null default 0,
  add column if not exists matches_product boolean,
  add column if not exists tags_intact boolean,
  add column if not exists condition_acceptable boolean,
  add column if not exists package_match boolean,
  add column if not exists seal_intact boolean,
  add column if not exists receipt_proof_ref text,
  add column if not exists receipt_at timestamptz,
  add column if not exists decision_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists split_from_id uuid references public.return_item(return_item_id);
alter table public.return_event add column if not exists return_item_id uuid references public.return_item(return_item_id);
alter table public.orders add column if not exists source_return_item_id uuid references public.return_item(return_item_id);
alter table public.return_shipment add column if not exists return_item_id uuid references public.return_item(return_item_id);
alter table public.return_shipment add column if not exists picked_up_by text;
alter table public.return_shipment drop constraint if exists return_shipment_return_id_direction_key;
create unique index if not exists return_shipment_item_direction_key on public.return_shipment(return_item_id,direction) where return_item_id is not null;
create unique index if not exists return_shipment_legacy_direction_key on public.return_shipment(return_id,direction) where return_item_id is null;
alter table public.return_evidence drop constraint if exists return_evidence_kind_check;
alter table public.return_evidence add constraint return_evidence_kind_check check(kind in
 ('request_photo','request_video','packing_photo','packing_video','pickup_photo','pickup_video','qa_photo','qa_video','refund_proof','other'));

-- An ordinal identifies the ORIGINAL purchased unit, including after its first replacement.
create table if not exists public.return_unit (
  order_item_id uuid not null references public.order_item(item_id),
  unit_number integer not null check(unit_number > 0),
  success_count integer not null default 0 check(success_count between 0 and 2),
  refunded boolean not null default false,
  active_return_item_id uuid references public.return_item(return_item_id),
  -- Legacy overlapping requests keep a synthetic unit so backfill never deletes customer history;
  -- it is never allocatable, and finishing it retires the unit at success_count=2.
  legacy_overflow boolean not null default false,
  primary key(order_item_id,unit_number)
);
create table if not exists public.return_item_unit (
  return_item_id uuid not null references public.return_item(return_item_id),
  order_item_id uuid not null,
  unit_number integer not null,
  primary key(return_item_id,order_item_id,unit_number),
  foreign key(order_item_id,unit_number) references public.return_unit(order_item_id,unit_number)
);
create index if not exists return_unit_active_idx on public.return_unit(active_return_item_id) where active_return_item_id is not null;
alter table public.return_unit enable row level security;
alter table public.return_item_unit enable row level security;
revoke all on public.return_unit,public.return_item_unit from public,anon,authenticated;
grant all on public.return_unit,public.return_item_unit to service_role;
create table if not exists public.return_item_shipment (
 return_item_id uuid not null references public.return_item(return_item_id),
 shipment_id uuid not null references public.return_shipment(shipment_id),
 primary key(return_item_id,shipment_id)
);
alter table public.return_item_shipment enable row level security;
revoke all on public.return_item_shipment from public,anon,authenticated;
grant all on public.return_item_shipment to service_role;

alter table public.payment_refund drop constraint if exists payment_refund_return_id_key;
alter table public.payment_refund add column if not exists return_item_id uuid references public.return_item(return_item_id);
create unique index if not exists payment_refund_item_key on public.payment_refund(return_item_id) where return_item_id is not null;
alter table public.return_manual_refund drop constraint if exists return_manual_refund_pkey;
alter table public.return_manual_refund add primary key(refund_id);
alter table public.return_manual_refund add column if not exists return_item_id uuid references public.return_item(return_item_id);
-- Historical multi-line operations remain request-scoped: never invent financial amounts per part.
update public.payment_refund p set return_item_id = i.return_item_id
from public.return_item i where i.return_id=p.return_id
  and (select count(*) from public.return_item x where x.return_id=p.return_id)=1 and p.return_item_id is null;
update public.return_manual_refund m set return_item_id=p.return_item_id from public.payment_refund p where p.refund_id=m.refund_id;

update public.return_item i set resolution_type=r.return_type::text,
 item_status=case r.status::text when 'CANCELLED' then case when r.cancelled_by='admin' then 'REJECTED' else 'CANCELLED' end
   when 'REFUNDED' then 'COMPLETED' when 'RETURN_IN_TRANSIT' then 'RETURN_SHIPPING'
   when 'REFUND_PROCESSING' then 'REFUND_PENDING' when 'CONTACTING' then 'REQUESTED' else r.status::text end,
 decision_status=case when r.status::text='CANCELLED' and r.cancelled_by='admin' then 'rejected'
   when r.status::text in ('REQUESTED','CONTACTING','CANCELLED') then 'pending' else 'approved' end,
 reason=coalesce(r.rejection_reason,r.description), exchange_order_id=r.exchange_order_id,
 received_quantity=case when r.condition_check_result::text='qa_pass' then i.quantity else 0 end,
 matches_product=case when r.condition_check_result::text='qa_pass' then true end,
 tags_intact=case when r.condition_check_result::text='qa_pass' then true end,
 condition_acceptable=case when r.condition_check_result::text='qa_pass' then true end,
 package_match=coalesce(r.package_match,r.condition_check_result::text='qa_pass'),seal_intact=r.seal_intact,
 receipt_proof_ref=r.warehouse_proof, completed_at=case when r.status::text in ('REFUNDED','COMPLETED') then r.resolved_at end,
 refund_amount=coalesce((select p.amount from public.payment_refund p where p.return_item_id=i.return_item_id and p.status='succeeded'),0)
from public.return_exchange r where r.return_id=i.return_id and i.resolution_type is null;
alter table public.return_item add constraint return_item_resolution_check check(resolution_type in ('refund','exchange'));
alter table public.return_item add constraint return_item_decision_check check(decision_status in ('pending','approved','rejected'));
alter table public.return_item add constraint return_item_stage_check check(item_status in
 ('REQUESTED','APPROVED','WAITING_RETURN','RETURN_SHIPPING','RECEIVED','NEEDS_SUPPORT','REFUND_PENDING','EXCHANGE_PREPARING','EXCHANGE_SHIPPING','COMPLETED','REJECTED','CANCELLED'));

create or replace function public.velura_reserve_return_units(p_return_item_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare i public.return_item%rowtype; n integer;
begin
 select * into i from public.return_item where return_item_id=p_return_item_id for update;
 if not found then raise sqlstate 'PT404' using message='RETURN_ITEM_NOT_FOUND'; end if;
 perform 1 from public.order_item where item_id=i.order_item_id for update;
 if exists(select 1 from public.return_item_unit where return_item_id=p_return_item_id) then return; end if;
 insert into public.return_unit(order_item_id,unit_number)
 select oi.item_id,generate_series(1,oi.quantity) from public.order_item oi where oi.item_id=i.order_item_id on conflict do nothing;
 with chosen as (select order_item_id,unit_number from public.return_unit
   where order_item_id=i.order_item_id and active_return_item_id is null and not refunded and success_count<2
     and not legacy_overflow
   order by success_count,unit_number limit i.quantity for update), assigned as (
   update public.return_unit u set active_return_item_id=i.return_item_id from chosen c
   where u.order_item_id=c.order_item_id and u.unit_number=c.unit_number returning u.order_item_id,u.unit_number)
 insert into public.return_item_unit(return_item_id,order_item_id,unit_number) select i.return_item_id,order_item_id,unit_number from assigned;
 get diagnostics n=row_count;
 if n<>i.quantity then raise sqlstate 'PT422' using message='RETURN_QUANTITY_EXCEEDED'; end if;
end; $$;

-- Backfill-only allocator: obeys the purchased-unit pool first, then parks unavoidable legacy
-- excess on non-allocatable overflow units so a production migration never deletes requests.
create or replace function public.velura_reserve_legacy_units(p_return_item_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare i public.return_item%rowtype; n integer; missing integer; next_number integer;
begin
 select * into i from public.return_item where return_item_id=p_return_item_id for update;
 if not found then raise sqlstate 'PT404' using message='RETURN_ITEM_NOT_FOUND'; end if;
 perform 1 from public.order_item where item_id=i.order_item_id for update;
 if exists(select 1 from public.return_item_unit where return_item_id=p_return_item_id) then return; end if;
 insert into public.return_unit(order_item_id,unit_number)
 select oi.item_id,generate_series(1,oi.quantity) from public.order_item oi where oi.item_id=i.order_item_id on conflict do nothing;
 with chosen as (select order_item_id,unit_number from public.return_unit
   where order_item_id=i.order_item_id and active_return_item_id is null and not refunded and success_count<2
     and not legacy_overflow
   order by success_count,unit_number limit i.quantity for update), assigned as (
   update public.return_unit u set active_return_item_id=i.return_item_id from chosen c
   where u.order_item_id=c.order_item_id and u.unit_number=c.unit_number returning u.order_item_id,u.unit_number)
 insert into public.return_item_unit(return_item_id,order_item_id,unit_number) select i.return_item_id,order_item_id,unit_number from assigned;
 get diagnostics n=row_count;
 missing:=i.quantity-n;
 if missing>0 then
  select coalesce(max(unit_number),0) into next_number from public.return_unit where order_item_id=i.order_item_id;
  insert into public.return_unit(order_item_id,unit_number,legacy_overflow,active_return_item_id)
   select i.order_item_id,next_number+g,true,i.return_item_id from generate_series(1,missing) g;
  insert into public.return_item_unit(return_item_id,order_item_id,unit_number)
   select i.return_item_id,i.order_item_id,next_number+g from generate_series(1,missing) g;
 end if;
end; $$;
revoke all on function public.velura_reserve_legacy_units(uuid) from public,anon,authenticated,service_role;

-- Rebuild original-unit identity chronologically without discarding legacy overlapping requests.
do $$ declare i record; begin
 for i in select ri.* from public.return_item ri join public.return_exchange r using(return_id)
   where ri.item_status not in ('REJECTED','CANCELLED') order by r.created_at,ri.return_item_id loop
  perform public.velura_reserve_legacy_units(i.return_item_id);
  if i.item_status='COMPLETED' then
   update public.return_unit set success_count=(case when legacy_overflow then 2 else success_count+1 end),
     refunded=(i.resolution_type='refund'),active_return_item_id=null
   where active_return_item_id=i.return_item_id;
  end if;
 end loop;
end $$;

create or replace function public.velura_return_item_holds(p_order_item_id uuid)
returns table(attempts integer,held_quantity integer,succeeded_quantity integer,open_requests integer,open_code text)
language sql stable security invoker set search_path=pg_catalog,public as $$
 select coalesce(max(u.success_count),0)::integer,
 count(*) filter(where u.active_return_item_id is not null or u.refunded or u.success_count>=2)::integer,
 count(*) filter(where u.success_count>0)::integer,
 count(distinct i.return_id) filter(where u.active_return_item_id is not null)::integer,
 max(r.tracking_return_code)::text
 from public.return_unit u left join public.return_item i on i.return_item_id=u.active_return_item_id
 left join public.return_exchange r on r.return_id=i.return_id where u.order_item_id=p_order_item_id;
$$;

create or replace function public.velura_return_item_initialize()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.resolution_type is null then select return_type::text into new.resolution_type from public.return_exchange where return_id=new.return_id; end if;
 return new;
end; $$;
create trigger return_item_initialize before insert on public.return_item for each row execute function public.velura_return_item_initialize();

-- Header is a projection, never an authorization to advance stock, money or replacements.
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
 version=version+1,updated_at=now() where return_id=p_return_id;
 perform set_config('app.return_projection','off',true);
end; $$;

create or replace function public.velura_return_workflow_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_op='INSERT' then
  if new.status::text<>'REQUESTED' then raise sqlstate 'PT422' using message='RETURN_INITIAL_STATE_REQUIRED'; end if;
  new.contact_due_at:=coalesce(new.contact_due_at,now()+interval '24 hours'); return new;
 end if;
 if new.return_type is distinct from old.return_type then raise sqlstate 'PT422' using message='RETURN_TYPE_IMMUTABLE'; end if;
 if new.status is distinct from old.status and coalesce(current_setting('app.return_projection',true),'')<>'on' then
  if new.status::text<>'CANCELLED' or coalesce(current_setting('app.return_actor_type',true),'')<>'customer' then
   raise sqlstate 'PT422' using message='ITEM_ACTION_REQUIRED'; end if;
  if exists(select 1 from public.return_item where return_id=new.return_id and item_status not in ('REQUESTED','APPROVED','WAITING_RETURN','REJECTED','CANCELLED')) then
   raise sqlstate 'PT422' using message='RETURN_CANNOT_CANCEL'; end if;
  update public.return_item set item_status='CANCELLED',version=version+1,updated_at=now()
    where return_id=new.return_id and item_status not in ('REJECTED','CANCELLED');
  update public.return_unit set active_return_item_id=null where active_return_item_id in
    (select return_item_id from public.return_item where return_id=new.return_id);
  new.cancelled_by:='customer'; new.resolved_at:=now();
 end if;
 return new;
end; $$;
drop trigger if exists return_workflow_guard on public.return_exchange;
create trigger return_workflow_guard before insert or update on public.return_exchange for each row execute function public.velura_return_workflow_guard();
drop trigger if exists return_refund_state_guard on public.return_exchange;
drop trigger if exists return_refund_receiver_guard on public.return_exchange;

create or replace function public.velura_require_return_actor(p_actor_id uuid,p_decision boolean default false)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if not exists(select 1 from public.users where user_id=p_actor_id and role::text='admin' and is_active
  and (admin_role::text='super_admin' or (not p_decision and admin_role::text='admin_operator_cskh_dt'))) then
  raise sqlstate 'PT403' using message='RBAC_DENIED'; end if;
end; $$;

create or replace function public.velura_return_evidence_owned(p_return_id uuid,p_ref text,p_kinds text[],p_actor_id uuid default null)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from public.return_evidence where return_id=p_return_id and kind=any(p_kinds)
  and 'storage://'||storage_bucket||'/'||storage_path=p_ref and (p_actor_id is null or uploaded_by=p_actor_id));
$$;

create or replace function public.velura_finish_return_unit(p_return_item_id uuid,p_refund boolean)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare n integer; q integer;
begin
 select quantity into q from public.return_item where return_item_id=p_return_item_id;
 update public.return_unit set success_count=(case when legacy_overflow then 2 else success_count+1 end),
   refunded=p_refund,active_return_item_id=null
 where active_return_item_id=p_return_item_id and not refunded and (legacy_overflow or success_count<2);
 get diagnostics n=row_count;
 if n<>q then raise sqlstate 'PT409' using message='RETURN_UNIT_CONFLICT'; end if;
end; $$;

create or replace function public.velura_return_item_action(
 p_return_id uuid,p_return_item_id uuid,p_action text,p_payload jsonb,p_expected_version integer,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare i public.return_item%rowtype; before_item public.return_item%rowtype; rem public.return_item%rowtype;
 h public.return_exchange%rowtype; oi public.order_item%rowtype; original public.orders%rowtype;
 replacement public.orders%rowtype; v public.variant%rowtype; qty integer; target uuid; note text; stage text;
 before_stock integer; proof text; units integer; movement uuid;
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
  if (p_payload->>'receivedQuantity')::numeric is distinct from i.quantity::numeric then raise sqlstate 'PT422' using message='WAREHOUSE_LINE_MISMATCH'; end if;
  if jsonb_typeof(p_payload->'matchesProduct') is distinct from 'boolean' or jsonb_typeof(p_payload->'tagsIntact') is distinct from 'boolean'
   or jsonb_typeof(p_payload->'conditionAcceptable') is distinct from 'boolean' or jsonb_typeof(p_payload->'packageMatch') is distinct from 'boolean'
   or jsonb_typeof(p_payload->'sealIntact') is distinct from 'boolean' then raise sqlstate 'PT422' using message='RECEIPT_FACTS_REQUIRED'; end if;
  proof:=p_payload->>'receiptProofRef';
  if not public.velura_return_evidence_owned(p_return_id,proof,array['qa_photo','qa_video']) then raise sqlstate 'PT422' using message='WAREHOUSE_PROOF_REQUIRED'; end if;
  if coalesce(p_payload->>'disposition','') not in ('restock','repair','scrap','return_supplier') then raise sqlstate 'PT422' using message='DISPOSITION_REQUIRED'; end if;
  i.received_quantity:=i.quantity; i.matches_product:=(p_payload->>'matchesProduct')::boolean; i.tags_intact:=(p_payload->>'tagsIntact')::boolean;
  i.condition_acceptable:=(p_payload->>'conditionAcceptable')::boolean; i.package_match:=(p_payload->>'packageMatch')::boolean;
  i.seal_intact:=(p_payload->>'sealIntact')::boolean; i.receipt_proof_ref:=proof; i.receipt_at:=now(); i.disposition:=p_payload->>'disposition';
  i.item_status:=case when i.matches_product and i.tags_intact and i.condition_acceptable and i.package_match then 'RECEIVED' else 'NEEDS_SUPPORT' end;
  if i.item_status='NEEDS_SUPPORT' then i.support_previous_status:='RETURN_SHIPPING'; end if;
  if i.disposition='restock' then
   if i.item_status<>'RECEIVED' then raise sqlstate 'PT422' using message='RESTOCK_QA_REQUIRED'; end if;
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
  if stage not in ('REQUESTED','APPROVED','WAITING_RETURN') or exists(
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
   when i.received_quantity=i.quantity and i.matches_product and i.tags_intact and i.condition_acceptable and i.package_match then 'RECEIVED'
   when stage='RETURN_SHIPPING' then 'RETURN_SHIPPING'
   when stage='NEEDS_SUPPORT' then 'NEEDS_SUPPORT'
   else 'WAITING_RETURN' end;
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
  stock_restored_quantity=i.stock_restored_quantity,restocked_at=i.restocked_at,completed_at=i.completed_at,version=version+1,updated_at=now()
 where return_item_id=i.return_item_id returning * into i;
 insert into public.return_event(return_id,return_item_id,old_status,new_status,actor_id,actor_type,event_type,payload,note)
 values(p_return_id,i.return_item_id,before_item.item_status,i.item_status,p_actor_id,'admin','item_action',p_payload||jsonb_build_object('action',p_action,'quantity',qty,'split_remainder_id',rem.return_item_id),note);
 perform public.velura_append_module_audit('returns',p_actor_id,(select admin_role::text from public.users where user_id=p_actor_id),'update',i.return_item_id,to_jsonb(before_item),to_jsonb(i)||jsonb_build_object('action',p_action,'customer_consent',p_payload->'customerConsent'),coalesce(nullif(current_setting('request.headers',true)::jsonb->>'x-velura-client-ip',''),nullif(current_setting('x-velura-client-ip',true),''),'127.0.0.1'));
 perform public.velura_refresh_return_aggregate(p_return_id);
 return jsonb_build_object('return_id',p_return_id,'item',to_jsonb(i),'lines',(select jsonb_agg(to_jsonb(x) order by x.created_at,x.return_item_id) from public.return_item x where return_id=p_return_id));
end; $$;

-- Allocate discount/points-funded cash to original unit ordinals, so splitting cannot change cash due.
create or replace function public.velura_original_unit_refundable_amount(p_order_item_id uuid,p_unit_number integer)
returns numeric language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce(floor(oi.unit_price*p_unit_number*f.ratio)-floor(oi.unit_price*(p_unit_number-1)*f.ratio),0)
 from public.order_item oi join public.orders o on o.order_id=oi.order_id
 left join public.voucher v on v.voucher_id=o.voucher_id
 cross join lateral (select case when o.subtotal>0 then greatest(0,o.subtotal-
   case when v.discount_type::text='free_shipping' then 0 else coalesce(o.discount_amount,0) end-
   coalesce(o.points_discount,0))/o.subtotal else 0 end as ratio) f
 where oi.item_id=p_order_item_id and p_unit_number between 1 and oi.quantity;
$$;
create or replace function public.velura_return_item_refundable_amount(p_return_item_id uuid)
returns numeric language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce((select amount from public.payment_refund where return_item_id=p_return_item_id),
 (select coalesce(sum(public.velura_original_unit_refundable_amount(order_item_id,unit_number)),0)
 from public.return_item_unit where return_item_id=p_return_item_id),0);
$$;
revoke all on function public.velura_original_unit_refundable_amount(uuid,integer) from public,anon,authenticated;
grant execute on function public.velura_original_unit_refundable_amount(uuid,integer) to service_role;

create or replace function public.velura_return_refundable_amount(p_return_id uuid)
returns numeric language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce(sum(public.velura_return_item_refundable_amount(return_item_id)),0)
 from public.return_item where return_id=p_return_id and resolution_type='refund' and decision_status<>'rejected' and item_status<>'CANCELLED';
$$;

-- Remove every old overload so a request-level call cannot bypass item QA or consume all parts.
drop function if exists public.velura_prepare_return_refund(uuid,uuid,integer);
drop function if exists public.velura_complete_return_refund(uuid,text);
drop function if exists public.velura_record_manual_return_refund(uuid,integer,text,numeric,timestamptz,text,text,uuid);
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
 update public.return_item set item_status='REFUND_PENDING',version=version+1,updated_at=now() where return_item_id=p_return_item_id;
 insert into public.return_event(return_id,return_item_id,old_status,new_status,actor_type,event_type,payload,note)
 values(p_return_id,p_return_item_id,'RECEIVED','REFUND_PENDING','system','refund',to_jsonb(op),'Reserved captured funds for returned part');
 perform public.velura_refresh_return_aggregate(p_return_id);
 return to_jsonb(op);
end; $$;

create or replace function public.velura_complete_return_refund(p_return_id uuid,p_provider_ref text,p_return_item_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare op public.payment_refund%rowtype; p public.payment%rowtype; order_id_value uuid; pending numeric;
begin
 select order_id into order_id_value from public.return_exchange where return_id=p_return_id;
 perform 1 from public.orders where order_id=order_id_value for update;
 perform 1 from public.return_exchange where return_id=p_return_id for update;
 select * into op from public.payment_refund where return_id=p_return_id and return_item_id=p_return_item_id for update;
 if not found then raise sqlstate 'PT404' using message='REFUND_NOT_FOUND'; end if;
 if op.status='succeeded' then
  if op.provider_ref is distinct from p_provider_ref then raise sqlstate 'PT409' using message='REFUND_PROVIDER_CONFLICT'; end if;
  return to_jsonb(op);
 end if;
 if nullif(btrim(p_provider_ref),'') is null or (op.provider_ref is not null and op.provider_ref<>p_provider_ref) then
  raise sqlstate 'PT409' using message='REFUND_PROVIDER_CONFLICT'; end if;
 select * into p from public.payment where payment_id=op.payment_id for update;
 if coalesce(p.refunded_amount,0)+op.amount>p.amount then raise sqlstate 'PT409' using message='REFUND_BALANCE_EXHAUSTED'; end if;
 update public.payment_refund set status='succeeded',provider_ref=p_provider_ref,updated_at=now()
 where refund_id=op.refund_id returning * into op;
 select coalesce(sum(amount),0) into pending from public.payment_refund where payment_id=p.payment_id and status in ('requested','pending','failed');
 update public.payment set refunded_amount=coalesce(refunded_amount,0)+op.amount,
  payment_status=(case when coalesce(refunded_amount,0)+op.amount>=amount then 'refunded' when pending>0 then 'refund_pending' else 'paid' end)::public.payment_status,
  refund_amount=coalesce(refunded_amount,0)+op.amount+pending,refund_at=now(),gateway_response_code='REFUNDED',version=version+1,updated_at=now()
 where payment_id=p.payment_id;
 perform public.velura_finish_return_unit(p_return_item_id,true);
 update public.return_item set item_status='COMPLETED',refund_amount=op.amount,completed_at=now(),version=version+1,updated_at=now()
 where return_item_id=p_return_item_id;
 insert into public.return_event(return_id,return_item_id,old_status,new_status,actor_type,event_type,payload,note)
 values(p_return_id,p_return_item_id,'REFUND_PENDING','COMPLETED','system','refund',to_jsonb(op),'Provider confirmed successful item refund');
 insert into public.order_event(order_id,action,actor_type,result,note,payload)
 values(order_id_value,'return_item_refund_succeeded','system','success','Successful return part refund',to_jsonb(op));
 perform public.velura_refresh_return_aggregate(p_return_id);
 perform public.velura_adjust_loyalty_for_return(p_return_id);
 return to_jsonb(op);
end; $$;

create or replace function public.velura_return_requires_refund_receiver(p_return_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from public.return_exchange r join public.orders o using(order_id)
 where r.return_id=p_return_id and o.payment_method::text='COD' and
 (r.return_type::text='refund' or exists(select 1 from public.return_item i where i.return_id=r.return_id and i.resolution_type='refund')));
$$;

create or replace function public.velura_record_manual_return_refund(
 p_return_id uuid,p_expected_version integer,p_reference text,p_amount numeric,p_transferred_at timestamptz,
 p_proof text,p_note text,p_actor_id uuid,p_return_item_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare h public.return_exchange%rowtype; p public.payment%rowtype; receiver public.return_refund_receiver%rowtype;
 op jsonb; prior public.return_manual_refund%rowtype; reference_value text:=btrim(p_reference);
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
 if p.payment_method::text is distinct from 'COD' or p.payment_provider='stripe' or p.payment_status::text not in ('paid','refund_pending')
 then raise sqlstate 'PT422' using message='COD_PAYMENT_REQUIRED'; end if;
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
 values(p_return_id,p_return_item_id,(op->>'refund_id')::uuid,'cod',reference_value,p_amount,p_transferred_at,
 receiver.bank_name,receiver.account_number,receiver.account_holder,p_proof,p_note,p_actor_id);
 op:=public.velura_complete_return_refund(p_return_id,'manual:'||upper(reference_value),p_return_item_id);
 perform public.velura_append_module_audit('returns',p_actor_id,(select admin_role::text from public.users where user_id=p_actor_id),
 'update',p_return_item_id,null,op||jsonb_build_object('reference',reference_value,'proof',p_proof,'transferred_at',p_transferred_at),coalesce(nullif(current_setting('request.headers',true)::jsonb->>'x-velura-client-ip',''),nullif(current_setting('x-velura-client-ip',true),''),'127.0.0.1'));
 return op;
end; $$;

-- Actual carrier delivery of a linked replacement consumes the original units once.
create or replace function public.velura_return_exchange_delivery()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare i public.return_item%rowtype;
begin
 if new.source_return_item_id is null or new.status is not distinct from old.status then return new; end if;
 select * into i from public.return_item where return_item_id=new.source_return_item_id for update;
 if i.resolution_type<>'exchange' or i.item_status in ('COMPLETED','REJECTED','CANCELLED') then return new; end if;
 if new.status::text='delivered' and new.delivered_at is not null then
  if i.item_status not in ('EXCHANGE_SHIPPING','NEEDS_SUPPORT') then raise sqlstate 'PT422' using message='EXCHANGE_SHIPPING_REQUIRED'; end if;
  perform public.velura_finish_return_unit(i.return_item_id,false);
  update public.return_item set item_status='COMPLETED',completed_at=now(),version=version+1,updated_at=now() where return_item_id=i.return_item_id;
 elsif new.status::text in ('delivery_failed','cancelled','returned') then
  update public.return_item set support_previous_status=item_status,item_status='NEEDS_SUPPORT',attention_status='needs_support',
   reason='Replacement delivery failed',version=version+1,updated_at=now() where return_item_id=i.return_item_id;
 else return new;
 end if;
 insert into public.return_event(return_id,return_item_id,old_status,new_status,actor_type,event_type,payload,note)
 values(i.return_id,i.return_item_id,i.item_status,case when new.status::text='delivered' then 'COMPLETED' else 'NEEDS_SUPPORT' end,
 'carrier','exchange_delivery',jsonb_build_object('exchange_order_id',new.order_id,'order_status',new.status),'Carrier replacement status');
 perform public.velura_refresh_return_aggregate(i.return_id);
 return new;
end; $$;
create trigger return_exchange_item_delivery after update of status on public.orders for each row execute function public.velura_return_exchange_delivery();

create or replace function public.velura_apply_return_carrier_event(p_shipment_id uuid,p_status text,p_note text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.return_shipment%rowtype; action_value text;
begin
 if p_status not in ('delivered','failed_retrying','failed_returned') then raise sqlstate 'PT422' using message='CARRIER_STATUS_UNSUPPORTED'; end if;
 select * into s from public.return_shipment where shipment_id=p_shipment_id for update;
 if not found then raise sqlstate 'PT404' using message='RETURN_SHIPMENT_NOT_FOUND'; end if;
 update public.return_shipment set status=case p_status when 'delivered' then 'delivered' when 'failed_retrying' then 'in_transit' else 'failed' end,
 delivered_at=case when p_status='delivered' then coalesce(delivered_at,now()) else delivered_at end,version=version+1,updated_at=now()
 where shipment_id=p_shipment_id returning * into s;
 if s.direction='outbound' and s.order_id is not null then
  action_value:=case p_status when 'delivered' then 'carrier_delivered' when 'failed_retrying' then 'carrier_failed_retrying' else 'carrier_failed_returned' end;
  perform public.velura_order_service_action(s.order_id,action_value,null,coalesce(nullif(p_note,''),'Carrier return update'),coalesce(p_payload,'{}'::jsonb),null);
 elsif p_status='failed_returned' and s.return_item_id is not null then
  update public.return_item set support_previous_status=item_status,item_status='NEEDS_SUPPORT',attention_status='needs_support',reason=coalesce(p_note,'Return shipment failed'),
  version=version+1,updated_at=now() where return_item_id=s.return_item_id and item_status not in ('COMPLETED','REJECTED','CANCELLED');
  perform public.velura_refresh_return_aggregate(s.return_id);
 end if;
 insert into public.return_event(return_id,return_item_id,new_status,actor_type,event_type,payload,note)
 values(s.return_id,s.return_item_id,s.status,'carrier','carrier',jsonb_build_object('shipment_id',s.shipment_id,'provider_status',p_status),p_note);
 return jsonb_build_object('return_id',s.return_id,'shipment',to_jsonb(s));
end; $$;

-- Revoke obsolete whole-request mutation RPCs (including the legacy authenticated admin RPCs).
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('admin_approve_refund','admin_approve_exchange','admin_reject_return',
 'velura_prepare_exchange','velura_complete_exchange','velura_ship_exchange','velura_receive_return',
 'velura_confirm_return_pickup','velura_create_return_shipment','velura_update_return_shipment_status') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
revoke insert,update,delete on public.return_item,public.return_exchange from anon,authenticated;
revoke all on function public.velura_return_item_action(uuid,uuid,text,jsonb,integer,uuid),
 public.velura_prepare_return_refund(uuid,uuid,integer,uuid),public.velura_complete_return_refund(uuid,text,uuid),
 public.velura_record_manual_return_refund(uuid,integer,text,numeric,timestamptz,text,text,uuid,uuid),
 public.velura_reserve_return_units(uuid),public.velura_finish_return_unit(uuid,boolean),
 public.velura_refresh_return_aggregate(uuid),public.velura_require_return_actor(uuid,boolean),
 public.velura_return_evidence_owned(uuid,text,text[],uuid) from public,anon,authenticated;
grant execute on function public.velura_return_item_action(uuid,uuid,text,jsonb,integer,uuid),
 public.velura_prepare_return_refund(uuid,uuid,integer,uuid),public.velura_complete_return_refund(uuid,text,uuid),
 public.velura_record_manual_return_refund(uuid,integer,text,numeric,timestamptz,text,text,uuid,uuid),
 public.velura_reserve_return_units(uuid),public.velura_refresh_return_aggregate(uuid) to service_role;
revoke all on function public.velura_return_item_refundable_amount(uuid),public.velura_return_refundable_amount(uuid) from public,anon,authenticated;
grant execute on function public.velura_return_item_refundable_amount(uuid),public.velura_return_refundable_amount(uuid) to service_role;
comment on table public.return_unit is 'Original purchased unit identity: active hold, at most two successful resolutions, refund permanently retires unit.';
comment on function public.velura_return_item_action(uuid,uuid,text,jsonb,integer,uuid) is 'Versioned per-part return decisions, quantity splitting, receipt, stock and replacement workflow; immutable initial request type.';
notify pgrst,'reload schema';
