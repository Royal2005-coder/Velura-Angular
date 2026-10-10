-- KAN-32: private order OTP grants, ordered turns, fail-closed AI publication and audited human takeover.
begin;

alter table public.guest_tracking_otp
  add column if not exists scoped_order_id uuid references public.orders on delete cascade,
  add column if not exists verified_at timestamptz;

alter table public.chat_session
  add column if not exists ai_epoch bigint not null default 0,
  add column if not exists next_sequence bigint not null default 0,
  add column if not exists ai_failures integer not null default 0,
  add column if not exists issue_counts jsonb not null default '{}'::jsonb,
  add column if not exists risk_level text not null default 'green' check (risk_level in ('green','yellow','orange','red'));
alter table public.chat_message
  add column if not exists sequence bigint,
  add column if not exists moderation_status text not null default 'visible' check (moderation_status in ('visible','restricted'));
with ordered as (
  select message_id, row_number() over (partition by session_id order by created_at, message_id) as seq from public.chat_message
) update public.chat_message m set sequence = o.seq from ordered o where o.message_id = m.message_id and m.sequence is null;
update public.chat_session s set next_sequence = coalesce((select max(m.sequence) from public.chat_message m where m.session_id=s.session_id),0);
alter table public.chat_message alter column sequence set not null;
create unique index if not exists chat_message_session_sequence on public.chat_message(session_id,sequence);

create table public.chat_order_grant (
  session_id uuid not null references public.chat_session on delete cascade,
  order_id uuid not null references public.orders on delete cascade,
  guest_id uuid not null,
  challenge_id uuid not null references public.guest_tracking_otp,
  verified_at timestamptz not null default now(), expires_at timestamptz not null,
  primary key(session_id,order_id)
);
create table public.chat_policy_approval (
  policy_id uuid primary key references public.policy on delete cascade,
  source_updated_at timestamptz not null,
  approved_by uuid not null references public.users,
  approved_at timestamptz not null default now(), expires_at timestamptz not null
);
create table public.chat_moderated_original (
  message_id uuid primary key references public.chat_message on delete cascade,
  session_id uuid not null references public.chat_session on delete cascade,
  original_text text not null, original_metadata jsonb not null,
  risk text not null, reason text not null, created_at timestamptz not null default now()
);
create table public.chat_staff_review (
  review_id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_session on delete cascade,
  message_id uuid references public.chat_message,
  actor_id uuid not null references public.users,
  action text not null check(action in ('correction','outcome','supervisor','moderate','original_access','policy_approval')),
  text text not null, classification jsonb, created_at timestamptz not null default now()
);
comment on table public.chat_staff_review is 'Human correction/outcome audit only; never an automatic training data source.';
alter table public.support_ticket add column if not exists chat_session_id uuid references public.chat_session on delete set null;
create unique index if not exists support_ticket_one_chat_session on public.support_ticket(chat_session_id) where chat_session_id is not null;
-- Direct staff table access would bypass the restricted-original API.
revoke all on public.chat_message, public.chat_session from anon, authenticated;
alter table public.chat_order_grant enable row level security;
alter table public.chat_policy_approval enable row level security;
alter table public.chat_moderated_original enable row level security;
alter table public.chat_staff_review enable row level security;
revoke all on public.chat_order_grant, public.chat_policy_approval, public.chat_moderated_original, public.chat_staff_review from public, anon, authenticated;
grant all on public.chat_order_grant, public.chat_policy_approval, public.chat_moderated_original, public.chat_staff_review to service_role;

create or replace function public.chat_sequence_message() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  update public.chat_session set next_sequence=next_sequence+1, last_message_at=now(),
    last_message_preview=left(new.text,180) where session_id=new.session_id returning next_sequence into new.sequence;
  if new.sequence is null then raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND'; end if;
  return new;
end; $$;
create trigger chat_sequence_message before insert on public.chat_message for each row execute function public.chat_sequence_message();

create or replace function public.chat_require_owner(p_session uuid,p_profile uuid,p_guest uuid)
returns public.chat_session language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype;
begin
  select * into s from public.chat_session where session_id=p_session for update;
  if s.session_id is null or not s.is_active or
    (p_profile is not null and s.profile_user_id is distinct from p_profile) or
    (p_profile is null and (s.profile_user_id is not null or p_guest is null or s.guest_id is distinct from p_guest)) then
    raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND';
  end if;
  if p_profile is not null and not exists(select 1 from public.users where user_id=p_profile and is_active and role::text in ('member','admin')) then
    raise sqlstate 'PT403' using message='ACCOUNT_ACCESS_DENIED';
  end if;
  return s;
end; $$;

create or replace function public.chat_append_user_turn(p_session uuid,p_profile uuid,p_guest uuid,p_text text,p_metadata jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; m public.chat_message%rowtype;
begin
  s:=public.chat_require_owner(p_session,p_profile,p_guest);
  if s.handoff_status='closed' then raise sqlstate 'PT409' using message='CHAT_SESSION_CLOSED'; end if;
  if length(btrim(p_text)) not between 1 and 1000 then raise sqlstate 'PT422' using message='INVALID_CHAT_TEXT'; end if;
  insert into public.chat_message(session_id,sender,text,metadata) values(p_session,'user',p_text,coalesce(p_metadata,'{}')) returning * into m;
  select * into s from public.chat_session where session_id=p_session;
  return jsonb_build_object('session',to_jsonb(s),'message',to_jsonb(m),'epoch',s.ai_epoch);
end; $$;

create or replace function public.chat_record_analysis(p_session uuid,p_message uuid,p_issue text,p_analysis jsonb,p_failed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; m public.chat_message%rowtype; count_issue integer; risk text; misconduct text;
begin
  select * into s from public.chat_session where session_id=p_session for update;
  select * into m from public.chat_message where message_id=p_message and session_id=p_session and sender='user';
  if s.session_id is null or m.message_id is null then raise sqlstate 'PT404' using message='CHAT_MESSAGE_NOT_FOUND'; end if;
  if p_failed then
    if not coalesce((m.metadata->>'model_failed')::boolean,false) then
      update public.chat_session set ai_failures=ai_failures+1 where session_id=p_session returning * into s;
      update public.chat_message set metadata=metadata||'{"model_failed":true}' where message_id=p_message;
    end if;
    return jsonb_build_object('ai_failures',s.ai_failures);
  end if;
  count_issue:=coalesce((s.issue_counts->>p_issue)::integer,0);
  if m.metadata ? 'analysis' then return jsonb_build_object('occurrences',count_issue,'ai_failures',s.ai_failures); end if;
  count_issue:=count_issue+1;
  risk:=coalesce(p_analysis->>'risk','green'); misconduct:=coalesce(p_analysis->>'moderation','none');
  if risk not in ('green','yellow','orange','red') then raise sqlstate 'PT422' using message='INVALID_RISK'; end if;
  if misconduct='none' and risk in ('orange','red') then risk:='yellow'; end if;
  update public.chat_session set issue_counts=jsonb_set(issue_counts,array[p_issue],to_jsonb(count_issue)),risk_level=risk where session_id=p_session;
  update public.chat_message set metadata=metadata||jsonb_build_object('analysis',p_analysis,'risk',risk) where message_id=p_message;
  if risk in ('orange','red') and misconduct<>'none' then
    insert into public.chat_moderated_original(message_id,session_id,original_text,original_metadata,risk,reason)
    values(p_message,p_session,m.text,m.metadata||jsonb_build_object('analysis',p_analysis),risk,misconduct) on conflict(message_id) do nothing;
    update public.chat_message set text='[Nội dung được kiểm duyệt]',metadata=jsonb_build_object('risk',risk,'classification',p_analysis-'context'),moderation_status='restricted' where message_id=p_message;
    update public.chat_session set title='Cuộc trò chuyện hỗ trợ',last_message_preview='[Nội dung được kiểm duyệt]',ai_epoch=ai_epoch+1 where session_id=p_session;
  end if;
  return jsonb_build_object('occurrences',count_issue,'ai_failures',s.ai_failures);
end; $$;

create or replace function public.chat_commit_ai_turn(p_session uuid,p_epoch bigint,p_user_sequence bigint,p_draft jsonb,p_sources jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; m public.chat_message%rowtype; src jsonb; v jsonb; o public.orders%rowtype;
begin
  select * into s from public.chat_session where session_id=p_session for update;
  if s.session_id is null then raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND'; end if;
  if not s.is_active or s.handoff_status<>'ai' or s.ai_epoch<>p_epoch or
     p_user_sequence<>(select max(sequence) from public.chat_message where session_id=p_session and sender='user') then
    return jsonb_build_object('sent',false,'reason','HUMAN_OR_NEWER_TURN','session',to_jsonb(s));
  end if;
  if length(btrim(p_draft->>'text')) not between 1 and 4000 then raise sqlstate 'PT422' using message='INVALID_CHAT_TEXT'; end if;
  for src in select value from jsonb_array_elements(p_sources) loop
    if src->>'kind'='policy' then
      perform 1 from public.policy where policy_id=(src->>'id')::uuid and status='published' and updated_at=(src->>'version')::timestamptz for share;
      if not found then return jsonb_build_object('sent',false,'reason','SOURCE_STALE'); end if;
      if coalesce((src->>'approved')::boolean,false) then
        perform 1 from public.chat_policy_approval where policy_id=(src->>'id')::uuid and source_updated_at=(src->>'version')::timestamptz and expires_at>now() for share;
        if not found then return jsonb_build_object('sent',false,'reason','SOURCE_STALE'); end if;
      end if;
    elsif src->>'kind'='page' then
      perform 1 from public.static_page where static_page_id=(src->>'id')::uuid and status='published' and updated_at=(src->>'version')::timestamptz for share;
      if not found then return jsonb_build_object('sent',false,'reason','SOURCE_STALE'); end if;
    elsif src->>'kind'='product' then
      perform 1 from public.product where product_id=(src->>'id')::uuid and status::text='on_sale' and updated_at=(src->>'version')::timestamptz
        and base_price=(src->'snapshot'->>'base_price')::numeric and sale_price is not distinct from (src->'snapshot'->>'sale_price')::numeric for share;
      if not found then return jsonb_build_object('sent',false,'reason','SOURCE_STALE'); end if;
      for v in select value from jsonb_array_elements(src->'snapshot'->'variants') loop
        perform 1 from public.variant where variant_id=(v->>'variant_id')::uuid and product_id=(src->>'id')::uuid
          and stock_quantity=(v->>'stock_quantity')::integer and reserved_quantity=(v->>'reserved_quantity')::integer
          and stock_quantity-reserved_quantity>0 for share;
        if not found then return jsonb_build_object('sent',false,'reason','SOURCE_STALE'); end if;
      end loop;
    elsif src->>'kind'='order' then
      select * into o from public.orders where order_id=(src->>'id')::uuid and updated_at=(src->>'version')::timestamptz for share;
      if o.order_id is null or (s.profile_user_id is not null and o.user_id is distinct from s.profile_user_id) or
        (s.profile_user_id is null and not exists(select 1 from public.chat_order_grant where session_id=p_session and order_id=o.order_id and guest_id=s.guest_id and expires_at>now())) then
        return jsonb_build_object('sent',false,'reason','SOURCE_STALE');
      end if;
    else raise sqlstate 'PT422' using message='INVALID_CHAT_SOURCE'; end if;
  end loop;
  insert into public.chat_message(session_id,sender,text,metadata,product_ids)
  values(p_session,'bot',p_draft->>'text',coalesce(p_draft->'metadata','{}'),array(select jsonb_array_elements_text(coalesce(p_draft->'product_ids','[]'))::uuid)) returning * into m;
  if not coalesce((p_draft->'metadata'->>'model_failure')::boolean,false) then update public.chat_session set ai_failures=0 where session_id=p_session; end if;
  select * into s from public.chat_session where session_id=p_session;
  return jsonb_build_object('sent',true,'message',to_jsonb(m),'session',to_jsonb(s));
end; $$;

create or replace function public.chat_handoff(p_session uuid,p_profile uuid,p_guest uuid,p_summary jsonb,p_reason text,p_supervisor boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; ticket uuid; m public.chat_message%rowtype;
begin
  s:=public.chat_require_owner(p_session,p_profile,p_guest);
  ticket:=s.support_ticket_id;
  if ticket is null then
    select ticket_id into ticket from public.support_ticket where chat_session_id=p_session;
    if ticket is null then
      insert into public.support_ticket(user_id,title,description,priority,status,chat_session_id)
      values(s.profile_user_id,'Chat CSKH '||left(p_session::text,8),p_summary::text,'high'::public.ticket_priority,'open'::public.ticket_status,p_session) returning ticket_id into ticket;
    end if;
  end if;
  update public.chat_session set support_ticket_id=ticket where session_id=p_session and support_ticket_id is null;
  if s.handoff_status='ai' then
    update public.chat_session set handoff_status='requested',ai_epoch=ai_epoch+1,support_ticket_id=ticket,
      metadata=metadata||jsonb_build_object('handoff_summary',p_summary,'handoff_reason',p_reason,'supervisor_required',p_supervisor) where session_id=p_session;
    insert into public.chat_message(session_id,sender,text,metadata) values(p_session,'bot',
      coalesce(p_summary->>'message', 'Dạ Velura thành thật xin lỗi bạn vì trải nghiệm mua sắm chưa được như ý và khiến bạn phiền lòng ạ! Em rất hiểu sự thất vọng và bức xúc của bạn lúc này. Để chuộc lỗi và gửi lời xin lỗi chân thành, Velura xin gửi tặng bạn mã ưu đãi VELURACARE (giảm 15% cho đơn hàng tiếp theo). Đồng thời, bên em luôn có chính sách đổi trả miễn phí trong 30 ngày nếu sản phẩm có bất kỳ vấn đề gì về chất lượng hay mẫu mã. Em cũng đã chuyển thông tin tới chuyên viên CSKH để ưu tiên hỗ trợ trực tiếp cho bạn ngay ạ. Bạn có thể chia sẻ thêm mã đơn hàng hoặc sự cố cụ thể để bên em xử lý dứt điểm cho bạn nhé!'),
      jsonb_build_object('system',false,'handoff',true,'speaker','AI Stylist','ticket_id',ticket)) returning * into m;
  elsif p_supervisor then
    update public.chat_session set metadata=metadata||'{"supervisor_required":true}' where session_id=p_session;
  end if;
  select * into s from public.chat_session where session_id=p_session;
  return jsonb_build_object('session',to_jsonb(s),'ticket_id',ticket,'message',to_jsonb(m));
end; $$;

create or replace function public.chat_staff_actor(p_actor uuid,p_supervisor boolean default false)
returns public.users language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare actor public.users%rowtype;
begin
  select * into actor from public.users where user_id=p_actor;
  if actor.user_id is null or not actor.is_active or actor.role::text<>'admin' or actor.admin_role::text not in ('super_admin','admin_operator_cskh_dt') or
    (p_supervisor and actor.admin_role::text<>'super_admin') or (auth.uid() is not null and actor.auth_user_id is distinct from auth.uid()) then
    raise sqlstate 'PT403' using message='RBAC_DENIED';
  end if;
  return actor;
end; $$;

create or replace function public.chat_staff_action(p_session uuid,p_actor uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor public.users%rowtype; s public.chat_session%rowtype; m public.chat_message%rowtype; risk text;
begin
  actor:=public.chat_staff_actor(p_actor,false);
  select * into s from public.chat_session where session_id=p_session for update;
  if s.session_id is null then raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND'; end if;
  if s.handoff_status='closed' and p_action in ('reply','assign') then raise sqlstate 'PT409' using message='CHAT_SESSION_CLOSED'; end if;
  if coalesce((s.metadata->>'supervisor_required')::boolean,false) and actor.admin_role::text<>'super_admin' and p_action in ('reply','assign','close','outcome') then raise sqlstate 'PT403' using message='SUPERVISOR_REQUIRED'; end if;
  if s.support_ticket_id is null and p_action in ('reply','assign','supervisor','moderate') then
    insert into public.support_ticket(user_id,title,description,priority,status,chat_session_id)
      values(s.profile_user_id,'Chat CSKH '||left(p_session::text,8),
        jsonb_build_object('summary','Staff takeover','problem',coalesce(s.last_message_preview,''),'wanted','Human support',
          'attempts',(select coalesce(jsonb_agg(jsonb_build_object('text',text,'sender',sender)),'[]') from
            (select text,sender from public.chat_message where session_id=p_session order by sequence desc limit 12) history),
          'verified_status',case when s.profile_user_id is not null then 'member_account' else 'unverified_guest' end)::text,'high'::public.ticket_priority,'open'::public.ticket_status,p_session)
      on conflict(chat_session_id) where chat_session_id is not null do update set updated_at=now() returning ticket_id into s.support_ticket_id;
    update public.chat_session set support_ticket_id=s.support_ticket_id where session_id=p_session;
  end if;
  if p_action in ('reply','assign') then
    update public.chat_session set ai_epoch=ai_epoch+1,handoff_status='assigned',assigned_to=actor.auth_user_id where session_id=p_session;
    if p_action='reply' then
      if length(btrim(p_payload->>'text')) not between 1 and 2000 then raise sqlstate 'PT422' using message='INVALID_CHAT_TEXT'; end if;
      insert into public.chat_message(session_id,sender,text,metadata) values(p_session,'agent',p_payload->>'text',jsonb_build_object('agent_id',p_actor,'agent_name',actor.full_name,'speaker','HUMAN')) returning * into m;
    elsif s.handoff_status<>'assigned' then
      insert into public.chat_message(session_id,sender,text,metadata) values(p_session,'agent','Nhân viên CSKH đã tiếp nhận cuộc trò chuyện.',jsonb_build_object('system',true,'agent_name',actor.full_name,'speaker','HUMAN'));
    end if;
    update public.support_ticket set status='processing',admin_reply=case when p_action='reply' then p_payload->>'text' else admin_reply end,version=version+1,updated_at=now() where ticket_id=s.support_ticket_id;
  elsif p_action='close' then
    update public.chat_session set handoff_status='closed',ai_epoch=ai_epoch+1 where session_id=p_session;
    update public.support_ticket set status='closed',resolved_at=now(),version=version+1,updated_at=now() where ticket_id=s.support_ticket_id;
    insert into public.chat_staff_review(session_id,actor_id,action,text) values(p_session,p_actor,'outcome',coalesce(nullif(p_payload->>'outcome',''),'Closed by staff'));
  elsif p_action in ('correction','outcome','supervisor','moderate') then
    if length(btrim(p_payload->>'text')) not between 1 and 2000 then raise sqlstate 'PT422' using message='INVALID_REVIEW_TEXT'; end if;
    if p_action in ('correction','moderate') then
      select * into m from public.chat_message where message_id=(p_payload->>'message_id')::uuid and session_id=p_session;
      if m.message_id is null then raise sqlstate 'PT404' using message='CHAT_MESSAGE_NOT_FOUND'; end if;
    end if;
    if p_action='correction' and (
      not coalesce(p_payload->'classification'->>'intent' in ('facts','catalog','policy_problem','order','human'),false) or
      not coalesce(p_payload->'classification'->>'level' in ('L0','L1','L2','L3'),false) or
      not coalesce(p_payload->'classification'->>'issue' in ('general','catalog','sizing','delivery','return','payment','cancellation'),false) or
      not coalesce(p_payload->'classification'->>'sentiment' in ('positive','neutral','negative'),false) or
      not coalesce(p_payload->'classification'->>'risk' in ('green','yellow','orange','red'),false) or
      not coalesce(p_payload->'classification'->>'moderation' in ('none','abuse','threat','illegal','sensitive'),false)
    ) then raise sqlstate 'PT422' using message='INVALID_STAFF_CLASSIFICATION'; end if;
    insert into public.chat_staff_review(session_id,message_id,actor_id,action,text,classification)
      values(p_session,m.message_id,p_actor,p_action,p_payload->>'text',case when p_action='correction' then
        jsonb_build_object('intent',p_payload->'classification'->>'intent','level',p_payload->'classification'->>'level',
          'issue',p_payload->'classification'->>'issue','sentiment',p_payload->'classification'->>'sentiment',
          'risk',p_payload->'classification'->>'risk','moderation',p_payload->'classification'->>'moderation') else null end);
    if p_action='supervisor' then update public.chat_session set metadata=metadata||'{"supervisor_required":true}',ai_epoch=ai_epoch+1,handoff_status=case when handoff_status='ai' then 'requested' else handoff_status end where session_id=p_session; end if;
    if p_action='outcome' then update public.chat_session set metadata=metadata||jsonb_build_object('staff_outcome',p_payload->>'text') where session_id=p_session; end if;
    if p_action='moderate' then
      risk:=p_payload->>'risk';
      if risk is null or risk not in ('yellow','orange','red') then raise sqlstate 'PT422' using message='INVALID_RISK'; end if;
      insert into public.chat_moderated_original(message_id,session_id,original_text,original_metadata,risk,reason) values(m.message_id,p_session,m.text,m.metadata,risk,p_payload->>'text') on conflict(message_id) do nothing;
      update public.chat_message set text='[Nội dung được kiểm duyệt]',metadata=jsonb_build_object('risk',risk),moderation_status='restricted' where message_id=m.message_id;
      update public.chat_session set risk_level=risk,title='Cuộc trò chuyện hỗ trợ',last_message_preview='[Nội dung được kiểm duyệt]',metadata=(metadata-'handoff_summary'-'handoff_reason')||jsonb_build_object('supervisor_required',coalesce((metadata->>'supervisor_required')::boolean,false) or risk='red'),ai_epoch=ai_epoch+1,handoff_status=case when handoff_status='ai' then 'requested' else handoff_status end where session_id=p_session;
      update public.support_ticket set description=jsonb_build_object('summary','Moderated conversation requires staff review','risk',risk)::text,version=version+1,updated_at=now() where ticket_id=s.support_ticket_id;
      select * into m from public.chat_message where message_id=m.message_id;
    end if;
  else raise sqlstate 'PT422' using message='INVALID_CHAT_STAFF_ACTION'; end if;
  select * into s from public.chat_session where session_id=p_session;
  return jsonb_build_object('session',to_jsonb(s),'message',to_jsonb(m));
end; $$;

create or replace function public.chat_grant_order(p_session uuid,p_guest uuid,p_order uuid,p_phone text,p_expires timestamptz,p_challenge uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; challenge public.guest_tracking_otp%rowtype;
begin
  s:=public.chat_require_owner(p_session,null,p_guest);
  select * into challenge from public.guest_tracking_otp where challenge_id=p_challenge and scoped_order_id=p_order and phone=p_phone and verified_at is not null;
  if challenge.challenge_id is null or challenge.attempts>=5 or challenge.verified_at+interval '15 minutes'<=now() or
    p_expires<=now() or p_expires>challenge.verified_at+interval '15 minutes 5 seconds' or
    not exists(select 1 from public.orders where order_id=p_order and shipping_phone=p_phone) then raise sqlstate 'PT401' using message='CHAT_ORDER_OTP_REQUIRED'; end if;
  insert into public.chat_order_grant(session_id,order_id,guest_id,challenge_id,expires_at) values(p_session,p_order,p_guest,p_challenge,p_expires)
    on conflict(session_id,order_id) do update set challenge_id=excluded.challenge_id,expires_at=excluded.expires_at,verified_at=now();
end; $$;

create or replace function public.chat_read_order(p_session uuid,p_profile uuid,p_guest uuid,p_order uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; o public.orders%rowtype;
begin
  s:=public.chat_require_owner(p_session,p_profile,p_guest);
  select * into o from public.orders where order_id=p_order;
  if o.order_id is null or (p_profile is not null and o.user_id is distinct from p_profile) or
    (p_profile is null and not exists(select 1 from public.chat_order_grant where session_id=p_session and order_id=p_order and guest_id=p_guest and expires_at>now())) then
    raise sqlstate 'PT404' using message='ORDER_NOT_FOUND';
  end if;
  return jsonb_build_object('order_id',o.order_id,'order_code',o.order_code,'status',o.status,'total_amount',o.total_amount,'tracking_code',o.tracking_code,'updated_at',o.updated_at);
end; $$;

create or replace function public.chat_read_moderated_original(p_session uuid,p_message uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare original public.chat_moderated_original%rowtype;
begin
  perform public.chat_staff_actor(p_actor,true);
  select * into original from public.chat_moderated_original where session_id=p_session and message_id=p_message;
  if original.message_id is null then raise sqlstate 'PT404' using message='CHAT_MESSAGE_NOT_FOUND'; end if;
  insert into public.chat_staff_review(session_id,message_id,actor_id,action,text) values(p_session,p_message,p_actor,'original_access','Supervisor viewed restricted original');
  return to_jsonb(original);
end; $$;
create or replace function public.chat_approve_policy(p_policy uuid,p_actor uuid,p_expires timestamptz)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare version_time timestamptz; approved public.chat_policy_approval%rowtype;
begin
  perform public.chat_staff_actor(p_actor,true);
  if p_expires<=now() or p_expires>now()+interval '90 days' then raise sqlstate 'PT422' using message='INVALID_APPROVAL_EXPIRY'; end if;
  select updated_at into version_time from public.policy where policy_id=p_policy and status='published' for share;
  if version_time is null then raise sqlstate 'PT404' using message='POLICY_NOT_FOUND'; end if;
  insert into public.chat_policy_approval(policy_id,source_updated_at,approved_by,expires_at) values(p_policy,version_time,p_actor,p_expires)
    on conflict(policy_id) do update set source_updated_at=excluded.source_updated_at,approved_by=excluded.approved_by,approved_at=now(),expires_at=excluded.expires_at returning * into approved;
  return to_jsonb(approved);
end; $$;

-- Extend the real tracking flow with an exact order scope and atomic five-minute expiry.
drop function public.velura_issue_guest_tracking_otp(text,text,uuid,text);
create function public.velura_issue_guest_tracking_otp(p_phone text,p_ip text,p_nonce uuid,p_hash text,p_order uuid default null)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('tracking-phone:'||p_phone,0));
  perform pg_advisory_xact_lock(hashtextextended('tracking-ip:'||p_ip,0));
  if p_order is not null and not exists(select 1 from public.orders where order_id=p_order and shipping_phone=p_phone) then raise sqlstate 'PT404' using message='ORDER_NOT_FOUND'; end if;
  if (select count(*) from public.guest_tracking_otp where phone=p_phone and created_at>now()-interval '15 minutes')>=3 then raise sqlstate 'PT429' using message='OTP_PHONE_RATE_LIMIT'; end if;
  if (select count(*) from public.guest_tracking_otp where ip_address=p_ip and created_at>now()-interval '1 hour')>=10 then raise sqlstate 'PT429' using message='OTP_IP_RATE_LIMIT'; end if;
  update public.guest_tracking_otp set consumed_at=now() where phone=p_phone and consumed_at is null;
  insert into public.guest_tracking_otp(phone,ip_address,nonce,code_hash,scoped_order_id,expires_at) values(p_phone,p_ip,p_nonce,p_hash,p_order,now()+interval '5 minutes');
end; $$;

create or replace function public.velura_verify_guest_tracking_otp(p_id uuid,p_hash text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare challenge public.guest_tracking_otp%rowtype;
begin
  select * into challenge from public.guest_tracking_otp where challenge_id=p_id for update;
  if challenge.challenge_id is null or challenge.consumed_at is not null then return jsonb_build_object('verified',false,'code','INVALID_OTP'); end if;
  if challenge.attempts>=5 then return jsonb_build_object('verified',false,'code','SESSION_LOCKED'); end if;
  if challenge.expires_at<=now() then return jsonb_build_object('verified',false,'code','EXPIRED_OTP'); end if;
  if challenge.code_hash<>p_hash then
    update public.guest_tracking_otp set attempts=attempts+1 where challenge_id=p_id;
    return jsonb_build_object('verified',false,'code',case when challenge.attempts>=4 then 'SESSION_LOCKED' else 'INVALID_OTP' end);
  end if;
  update public.guest_tracking_otp set consumed_at=now(),verified_at=now() where challenge_id=p_id;
  return jsonb_build_object('verified',true);
end; $$;

-- All actor-bearing RPCs are service-only; staff RPCs still bind active database roles.
do $$ declare fn record; begin
  for fn in select oid::regprocedure as name from pg_proc where pronamespace='public'::regnamespace and
    (proname like 'chat_%' or proname='velura_issue_guest_tracking_otp') loop
    execute format('revoke all on function %s from public,anon,authenticated',fn.name);
    execute format('grant execute on function %s to service_role',fn.name);
  end loop;
end $$;
commit;
