-- KAN-32: explicit, versioned recovery approval on real campaigns/vouchers; no AI grants.
begin;
alter table public.promotion
  add column recovery_approved boolean not null default false,
  add column recovery_conditions text,
  add column recovery_max_offers integer not null default 0 check(recovery_max_offers >= 0),
  add column recovery_revision integer not null default 0,
  add column recovery_approved_by uuid references public.users(user_id),
  add column recovery_approved_at timestamptz;
alter table public.voucher
  add column recovery_approved boolean not null default false,
  add column recovery_conditions text,
  add column recovery_max_offers integer not null default 0 check(recovery_max_offers >= 0),
  add column recovery_revision integer not null default 0,
  add column recovery_approved_by uuid references public.users(user_id),
  add column recovery_approved_at timestamptz;

create table public.chat_support_offer_claim (
  claim_id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_session(session_id),
  voucher_id uuid not null references public.voucher(voucher_id),
  profile_user_id uuid references public.users(user_id),
  guest_phone text,
  voucher_version integer not null,
  promotion_version integer not null,
  voucher_revision integer not null,
  promotion_revision integer not null,
  actor_id uuid not null references public.users(user_id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique(session_id,voucher_id),
  check(profile_user_id is not null or guest_phone is not null)
);
create index chat_support_offer_claim_customer on public.chat_support_offer_claim(profile_user_id,voucher_id);
create index chat_support_offer_claim_guest on public.chat_support_offer_claim(guest_phone,voucher_id);
alter table public.chat_support_offer_claim enable row level security;
revoke all on public.chat_support_offer_claim from public,anon,authenticated;
grant select,insert,update on public.chat_support_offer_claim to service_role;

-- Ordinary financial/audience edits cannot silently retain a previous recovery approval.
create function public.recovery_terms_changed() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_table_name='voucher' then
    if (to_jsonb(new)-array['version','updated_at','used_count','is_active','name','recovery_approved','recovery_conditions','recovery_max_offers','recovery_revision','recovery_approved_by','recovery_approved_at'])
       is distinct from (to_jsonb(old)-array['version','updated_at','used_count','is_active','name','recovery_approved','recovery_conditions','recovery_max_offers','recovery_revision','recovery_approved_by','recovery_approved_at']) then
      new.recovery_approved:=false;
    end if;
  else
    if new.budget_limit is distinct from old.budget_limit or new.start_date is distinct from old.start_date
       or new.end_date is distinct from old.end_date or new.applicable_categories is distinct from old.applicable_categories then
      new.recovery_approved:=false;
    end if;
  end if;
  return new;
end; $$;
create trigger recovery_voucher_terms before update on public.voucher for each row execute function public.recovery_terms_changed();
create trigger recovery_campaign_terms before update on public.promotion for each row execute function public.recovery_terms_changed();

create function public.admin_save_recovery_promotion(p_input jsonb,p_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare actor public.users%rowtype; p public.promotion%rowtype; result jsonb; before_state jsonb;
begin
  actor:=public.velura_require_pricing_admin();
  if p_id is null then
    result:=public.admin_create_promotion(
      p_name=>p_input->>'name',p_start_date=>(p_input->>'startDate')::timestamptz,p_end_date=>(p_input->>'endDate')::timestamptz,
      p_promo_type=>coalesce(p_input->>'type','product_discount'),p_description=>p_input->>'description',
      p_applicable_categories=>nullif(p_input->'applicableCategories','null'::jsonb),p_budget_limit=>coalesce((p_input->>'budgetLimit')::numeric,0),
      p_max_vouchers_allowed=>coalesce((p_input->>'maxVouchersAllowed')::integer,0),p_banner_image_url=>p_input->>'bannerImageUrl',
      p_highlight_label=>p_input->>'highlightLabel',p_display_order=>coalesce((p_input->>'displayOrder')::integer,0),p_is_featured=>coalesce((p_input->>'isFeatured')::boolean,false));
    p_id:=(result->>'promo_id')::uuid;
  else
    select to_jsonb(x) into before_state from public.promotion x where promo_id=p_id for update;
    result:=public.admin_update_promotion(p_promo_id=>p_id,p_expected_version=>(p_input->>'expectedVersion')::integer,
      p_name=>p_input->>'name',p_description=>p_input->>'description',p_applicable_categories=>nullif(p_input->'applicableCategories','null'::jsonb),
      p_budget_limit=>(p_input->>'budgetLimit')::numeric,p_banner_image_url=>p_input->>'bannerImageUrl',p_highlight_label=>p_input->>'highlightLabel',
      p_display_order=>(p_input->>'displayOrder')::integer,p_is_featured=>(p_input->>'isFeatured')::boolean,
      p_start_date=>(p_input->>'startDate')::timestamptz,p_end_date=>(p_input->>'endDate')::timestamptz);
  end if;
  select * into p from public.promotion where promo_id=p_id for update;
  if p_input ? 'recoveryApproved' or p_input ? 'recoveryConditions' or p_input ? 'recoveryMaxOffers' then
    p.recovery_approved:=coalesce((p_input->>'recoveryApproved')::boolean,false);
    p.recovery_conditions:=nullif(btrim(p_input->>'recoveryConditions'),'');
    p.recovery_max_offers:=coalesce((p_input->>'recoveryMaxOffers')::integer,0);
    if p.recovery_approved and (p.recovery_conditions is null or length(p.recovery_conditions)>2000
      or p.recovery_max_offers<1 or p.budget_limit<=0 or p.end_date<=now()) then
      raise sqlstate 'PT422' using message='RECOVERY_CAMPAIGN_TERMS_REQUIRED';
    end if;
    update public.promotion set recovery_approved=p.recovery_approved,recovery_conditions=p.recovery_conditions,
      recovery_max_offers=p.recovery_max_offers,
      recovery_revision=case when recovery_revision>0 or p.recovery_approved or p.recovery_conditions is not null or p.recovery_max_offers>0 then recovery_revision+1 else 0 end,
      recovery_approved_by=case when p.recovery_approved then actor.user_id end,
      recovery_approved_at=case when p.recovery_approved then now() end where promo_id=p_id returning * into p;
  end if;
  perform public.velura_append_module_audit('promotions',actor.user_id,actor.admin_role::text,'update',p_id,before_state,to_jsonb(p),null);
  return to_jsonb(p);
end; $$;

create function public.admin_save_recovery_voucher(p_input jsonb,p_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare actor public.users%rowtype; v public.voucher%rowtype; p public.promotion%rowtype; result jsonb; before_state jsonb;
begin
  actor:=public.velura_require_pricing_admin();
  if p_id is null then
    result:=public.admin_create_voucher(p_code=>p_input->>'code',p_name=>coalesce(p_input->>'name',p_input->>'code'),
      p_discount_type=>p_input->>'type',p_discount_value=>coalesce((p_input->>'value')::numeric,0),
      p_start_date=>(p_input->>'startDate')::timestamptz,p_end_date=>(p_input->>'endDate')::timestamptz,
      p_promo_id=>nullif(p_input->>'promoId','')::uuid,p_max_discount_amount=>(p_input->>'maxDiscount')::numeric,
      p_min_order_value=>coalesce((p_input->>'minOrderValue')::numeric,0),p_usage_limit_total=>(p_input->>'maxUses')::integer,
      p_usage_limit_per_user=>coalesce((p_input->>'maxPerUser')::integer,1),
      p_applicable_categories=>nullif(p_input->'applicableCategories','null'::jsonb),p_applicable_user_group=>coalesce(p_input->>'applicableUserGroup','all_users'));
    p_id:=(result->>'voucher_id')::uuid;
  else
    select to_jsonb(x) into before_state from public.voucher x where voucher_id=p_id for update;
    result:=public.admin_update_voucher(p_voucher_id=>p_id,p_expected_version=>(p_input->>'expectedVersion')::integer,
      p_is_active=>(p_input->>'isActive')::boolean,p_name=>p_input->>'name',p_discount_type=>p_input->>'type',p_discount_value=>(p_input->>'value')::numeric,
      p_max_discount_amount=>(p_input->>'maxDiscount')::numeric,p_clear_max_discount=>coalesce((p_input->>'clearMaxDiscount')::boolean,false),
      p_min_order_value=>(p_input->>'minOrderValue')::numeric,p_usage_limit_total=>(p_input->>'maxUses')::integer,
      p_clear_usage_limit_total=>coalesce((p_input->>'clearMaxUses')::boolean,false),p_usage_limit_per_user=>(p_input->>'maxPerUser')::integer,
      p_applicable_user_group=>p_input->>'applicableUserGroup',p_applicable_categories=>nullif(p_input->'applicableCategories','null'::jsonb),
      p_start_date=>(p_input->>'startDate')::timestamptz,p_end_date=>(p_input->>'endDate')::timestamptz,
      p_promo_id=>nullif(p_input->>'promoId','')::uuid,p_clear_promo=>coalesce((p_input->>'clearPromo')::boolean,false));
  end if;
  select * into v from public.voucher where voucher_id=p_id for update;
  if p_input ? 'recoveryApproved' or p_input ? 'recoveryConditions' or p_input ? 'recoveryMaxOffers' then
    v.recovery_approved:=coalesce((p_input->>'recoveryApproved')::boolean,false);
    v.recovery_conditions:=nullif(btrim(p_input->>'recoveryConditions'),'');
    v.recovery_max_offers:=coalesce((p_input->>'recoveryMaxOffers')::integer,0);
    select * into p from public.promotion where promo_id=v.promo_id for share;
    if v.recovery_approved and (v.recovery_conditions is null or length(v.recovery_conditions)>2000 or v.recovery_max_offers<1
      or v.usage_limit_total is null or v.usage_limit_total<1 or v.usage_limit_per_user<1 or v.end_date<=now()
      or p.promo_id is null or not p.recovery_approved or p.budget_limit<=0
      or v.applicable_user_group::text not in ('all_users','member','guest','new_user')
      or (v.discount_type::text='percentage' and coalesce(v.max_discount_amount,0)<=0)) then
      raise sqlstate 'PT422' using message='RECOVERY_VOUCHER_TERMS_REQUIRED';
    end if;
    update public.voucher set recovery_approved=v.recovery_approved,recovery_conditions=v.recovery_conditions,
      recovery_max_offers=v.recovery_max_offers,
      recovery_revision=case when recovery_revision>0 or v.recovery_approved or v.recovery_conditions is not null or v.recovery_max_offers>0 then recovery_revision+1 else 0 end,
      recovery_approved_by=case when v.recovery_approved then actor.user_id end,
      recovery_approved_at=case when v.recovery_approved then now() end where voucher_id=p_id returning * into v;
  end if;
  perform public.velura_append_module_audit('vouchers',actor.user_id,actor.admin_role::text,'update',p_id,before_state,to_jsonb(v),null);
  return to_jsonb(v);
end; $$;

-- Restricted originals, order facts and voucher codes are never returned as AI sources.
create function public.chat_list_eligible_support_offers(p_session uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; customer uuid; phone text; result jsonb;
begin
  select * into s from public.chat_session where session_id=p_session;
  if s.session_id is null or not s.is_active or s.handoff_status='closed' then return '[]'::jsonb; end if;
  customer:=s.profile_user_id;
  if customer is null then
    select o.user_id,o.shipping_phone into customer,phone from public.chat_order_grant g join public.orders o on o.order_id=g.order_id
      where g.session_id=p_session and g.guest_id=s.guest_id and g.expires_at>now()
        and g.order_id=nullif(s.metadata->>'selected_order_id','')::uuid limit 1;
    if phone is null then return '[]'::jsonb; end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('offer_id',v.voucher_id,'version',
    concat(v.version,':',p.version,':',v.recovery_revision,':',p.recovery_revision),'approved',true,
    'snapshot',jsonb_build_object('name',v.name,'campaign',p.promo_name,'discount_type',v.discount_type,'discount_value',v.discount_value,
      'maximum_discount',v.max_discount_amount,'min_order_value',v.min_order_value,'audience',v.applicable_user_group,
      'categories',v.applicable_categories,'campaign_categories',p.applicable_categories,
      'conditions',jsonb_build_array(p.recovery_conditions,v.recovery_conditions),'expiry',least(v.end_date,p.end_date),
      'remaining_uses',v.usage_limit_total-v.used_count,'per_customer_limit',v.usage_limit_per_user,
      'budget_remaining',p.budget_limit-p.total_discount_issued))), '[]'::jsonb) into result
  from public.voucher v join public.promotion p on p.promo_id=v.promo_id
  where v.recovery_approved and p.recovery_approved and v.is_active and p.is_active
    and now()>=v.start_date and now()<v.end_date and now()>=p.start_date and now()<p.end_date
    and p.budget_limit>p.total_discount_issued and v.usage_limit_total>v.used_count
    and (v.reward_member_id is null or (s.profile_user_id is not null and v.reward_member_id=s.profile_user_id))
    and (v.applicable_user_group::text='all_users' or (v.applicable_user_group::text='guest' and s.profile_user_id is null)
      or (v.applicable_user_group::text='member' and s.profile_user_id is not null)
      or (v.applicable_user_group::text='new_user' and s.profile_user_id is not null and not exists(
        select 1 from public.orders where user_id=customer and status::text<>'cancelled')))
    and (select count(*) from public.orders o where o.voucher_id=v.voucher_id and o.status::text<>'cancelled'
      and ((s.profile_user_id is not null and o.user_id=customer) or (phone is not null and o.shipping_phone=phone)))<v.usage_limit_per_user
    and ((select count(*) from public.chat_support_offer_claim c where c.voucher_id=v.voucher_id)<v.recovery_max_offers
      or exists(select 1 from public.chat_support_offer_claim c where c.session_id=p_session and c.voucher_id=v.voucher_id))
    and ((select count(*) from public.chat_support_offer_claim c join public.voucher cv on cv.voucher_id=c.voucher_id where cv.promo_id=p.promo_id)<p.recovery_max_offers
      or exists(select 1 from public.chat_support_offer_claim c where c.session_id=p_session and c.voucher_id=v.voucher_id));
  return result;
end; $$;

create function public.chat_confirm_support_offer(p_session uuid,p_actor uuid,p_offer uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare actor public.users%rowtype; s public.chat_session%rowtype; v public.voucher%rowtype; p public.promotion%rowtype;
  c public.chat_support_offer_claim%rowtype; customer uuid; phone text; offers jsonb;
begin
  actor:=public.chat_staff_actor(p_actor,false);
  select * into s from public.chat_session where session_id=p_session for update;
  if s.session_id is null then raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND'; end if;
  if not s.is_active or s.handoff_status<>'assigned' or s.assigned_to is distinct from actor.auth_user_id then
    raise sqlstate 'PT409' using message='CHAT_NOT_ASSIGNED_TO_ACTOR'; end if;
  if coalesce((s.metadata->>'supervisor_required')::boolean,false) and actor.admin_role::text<>'super_admin' then
    raise sqlstate 'PT403' using message='SUPERVISOR_REQUIRED'; end if;
  select * into v from public.voucher where voucher_id=p_offer for update;
  select * into p from public.promotion where promo_id=v.promo_id for update;
  offers:=public.chat_list_eligible_support_offers(p_session);
  if not exists(select 1 from jsonb_array_elements(offers) x where x->>'offer_id'=p_offer::text) then
    raise sqlstate 'PT409' using message='SUPPORT_OFFER_NO_LONGER_ELIGIBLE'; end if;
  customer:=s.profile_user_id;
  if customer is null then
    select o.user_id,o.shipping_phone into customer,phone from public.chat_order_grant g join public.orders o on o.order_id=g.order_id
      where g.session_id=p_session and g.guest_id=s.guest_id and g.expires_at>now()
        and g.order_id=nullif(s.metadata->>'selected_order_id','')::uuid limit 1;
  end if;
  -- Serialize confirmations for the same buyer across independent chat sessions.
  perform pg_advisory_xact_lock(hashtextextended(coalesce(phone,customer::text)||':'||p_offer::text,0));
  select * into c from public.chat_support_offer_claim where session_id=p_session and voucher_id=p_offer;
  if c.claim_id is null then
    if (select count(*) from public.chat_support_offer_claim x where x.voucher_id=p_offer and
      ((phone is null and x.profile_user_id=customer and x.guest_phone is null) or (phone is not null and x.guest_phone=phone)))>=v.usage_limit_per_user then
      raise sqlstate 'PT409' using message='SUPPORT_OFFER_CUSTOMER_LIMIT'; end if;
    insert into public.chat_support_offer_claim(session_id,voucher_id,profile_user_id,guest_phone,voucher_version,promotion_version,
      voucher_revision,promotion_revision,actor_id,expires_at)
      values(p_session,p_offer,customer,phone,v.version,p.version,v.recovery_revision,p.recovery_revision,p_actor,least(v.end_date,p.end_date)) returning * into c;
    update public.chat_session set ai_epoch=ai_epoch+1,context_revision=context_revision+1,
      metadata=metadata||jsonb_build_object('confirmed_support_offer',p_offer) where session_id=p_session;
    perform public.velura_append_module_audit('vouchers',actor.user_id,actor.admin_role::text,'update',p_offer,null,
      jsonb_build_object('session_id',p_session,'claim_id',c.claim_id,'conditions_confirmed',true),null);
  elsif c.expires_at<=now() or c.voucher_revision<>v.recovery_revision or c.promotion_revision<>p.recovery_revision then
    raise sqlstate 'PT409' using message='SUPPORT_OFFER_STALE';
  end if;
  return jsonb_build_object('offer_id',p_offer,'code',v.code,'name',v.name,'expires_at',c.expires_at,
    'conditions',jsonb_build_array(p.recovery_conditions,v.recovery_conditions),'confirmed',true);
end; $$;

create function public.chat_support_wallet_offer_ids(p_profile uuid,p_guest_phone text default null) returns jsonb
language sql security definer set search_path=pg_catalog,public as $$
  select coalesce(jsonb_agg(distinct c.voucher_id),'[]'::jsonb) from public.chat_support_offer_claim c
  join public.voucher v on v.voucher_id=c.voucher_id join public.promotion p on p.promo_id=v.promo_id
  where ((p_guest_phone is null and c.guest_phone is null and c.profile_user_id=p_profile)
    or (p_guest_phone is not null and c.guest_phone=p_guest_phone))
    and c.expires_at>now()
    and c.voucher_revision=v.recovery_revision and c.promotion_revision=p.recovery_revision
    and v.recovery_approved and p.recovery_approved and v.is_active and p.is_active
    and now()>=v.start_date and now()<v.end_date and now()>=p.start_date and now()<p.end_date
    and p.budget_limit>p.total_discount_issued and v.usage_limit_total>v.used_count;
$$;

-- Final database guard applies to every checkout/order writer, not only the wallet UI.
create function public.enforce_support_offer_checkout() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v public.voucher%rowtype; p public.promotion%rowtype; c public.chat_support_offer_claim%rowtype;
begin
  if new.voucher_id is null then return new; end if;
  if tg_op='UPDATE' and new.voucher_id is not distinct from old.voucher_id then return new; end if;
  select * into v from public.voucher where voucher_id=new.voucher_id for update;
  select * into p from public.promotion where promo_id=v.promo_id for update;
  if v.recovery_revision=0 and coalesce(p.recovery_revision,0)=0 then return new; end if;
  if not v.recovery_approved or not coalesce(p.recovery_approved,false) or not v.is_active or not p.is_active
    or now()<v.start_date or now()>=v.end_date or now()<p.start_date or now()>=p.end_date
    or coalesce(v.usage_limit_total,0)<=v.used_count or p.budget_limit<p.total_discount_issued+new.discount_amount then
    raise sqlstate 'PT409' using message='SUPPORT_OFFER_NO_LONGER_ELIGIBLE'; end if;
  select * into c from public.chat_support_offer_claim x where x.voucher_id=new.voucher_id and x.expires_at>now()
    and x.voucher_revision=v.recovery_revision and x.promotion_revision=p.recovery_revision
    and ((not coalesce(new.is_guest,false) and x.guest_phone is null and x.profile_user_id=new.user_id)
      or (coalesce(new.is_guest,false) and x.guest_phone=new.shipping_phone)) order by x.created_at desc limit 1 for update;
  if c.claim_id is null then raise sqlstate 'PT403' using message='SUPPORT_OFFER_CONFIRMATION_REQUIRED'; end if;
  if (select count(*) from public.orders o where o.voucher_id=new.voucher_id and o.status::text<>'cancelled' and
    ((c.guest_phone is null and o.user_id=new.user_id) or (c.guest_phone is not null and o.shipping_phone=c.guest_phone)))>=v.usage_limit_per_user then
    raise sqlstate 'PT409' using message='SUPPORT_OFFER_CUSTOMER_LIMIT'; end if;
  return new;
end; $$;
create trigger support_offer_checkout before insert or update of voucher_id on public.orders for each row execute function public.enforce_support_offer_checkout();

alter function public.chat_commit_ai_turn(uuid,bigint,bigint,jsonb,jsonb) rename to chat_commit_ai_turn_governed;
create function public.chat_commit_ai_turn(p_session uuid,p_epoch bigint,p_user_sequence bigint,p_draft jsonb,p_sources jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare src jsonb; offers jsonb; filtered jsonb:='[]'::jsonb; promotion_refs jsonb:='[]'::jsonb;
  result jsonb; s public.chat_session%rowtype; v public.voucher%rowtype; p public.promotion%rowtype;
begin
  perform 1 from public.chat_session where session_id=p_session for update;
  for src in select value from jsonb_array_elements(p_sources) loop
    if src->>'kind'='promotion' then
      select * into v from public.voucher where voucher_id=(src->>'id')::uuid for share;
      select * into p from public.promotion where promo_id=v.promo_id for share;
      offers:=public.chat_list_eligible_support_offers(p_session);
      if not exists(select 1 from jsonb_array_elements(offers) x where x->>'offer_id'=src->>'id' and x->>'version'=src->>'version'
        and x->'snapshot'=src->'snapshot' and coalesce((src->>'approved')::boolean,false)) then
        return jsonb_build_object('sent',false,'reason','SOURCE_STALE'); end if;
      promotion_refs:=promotion_refs||jsonb_build_array(jsonb_build_object(
        'kind','promotion','id',src->>'id','version',src->>'version','approved',true));
    else filtered:=filtered||jsonb_build_array(src); end if;
  end loop;
  result:=public.chat_commit_ai_turn_governed(p_session,p_epoch,p_user_sequence,p_draft,filtered);
  if coalesce((result->>'sent')::boolean,false) and jsonb_array_length(promotion_refs)>0 then
    update public.chat_session set
      metadata=jsonb_set(metadata,'{verified_facts}',coalesce(metadata->'verified_facts','[]'::jsonb)||promotion_refs),
      context_revision=context_revision+1 where session_id=p_session returning * into s;
    result:=jsonb_set(result,'{session}',to_jsonb(s));
  end if;
  return result;
end; $$;

revoke all on function public.admin_save_recovery_promotion(jsonb,uuid),public.admin_save_recovery_voucher(jsonb,uuid) from public,anon;
grant execute on function public.admin_save_recovery_promotion(jsonb,uuid),public.admin_save_recovery_voucher(jsonb,uuid) to authenticated;
revoke all on function public.recovery_terms_changed(),public.enforce_support_offer_checkout(),public.chat_list_eligible_support_offers(uuid),
  public.chat_confirm_support_offer(uuid,uuid,uuid),public.chat_support_wallet_offer_ids(uuid,text),
  public.chat_commit_ai_turn_governed(uuid,bigint,bigint,jsonb,jsonb),public.chat_commit_ai_turn(uuid,bigint,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.chat_list_eligible_support_offers(uuid),public.chat_confirm_support_offer(uuid,uuid,uuid),
  public.chat_support_wallet_offer_ids(uuid,text),public.chat_commit_ai_turn(uuid,bigint,bigint,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
