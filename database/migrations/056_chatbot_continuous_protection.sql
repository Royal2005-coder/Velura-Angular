-- KAN-32: quarantine originals before any shared read; publish neutral context under session locks.
begin;
alter table public.chat_session add column context_revision bigint not null default 0;
alter table public.chat_message drop constraint chat_message_moderation_status_check;
alter table public.chat_message add constraint chat_message_moderation_status_check check(moderation_status in ('pending','visible','restricted'));
create table public.chat_issue_state (
  session_id uuid not null references public.chat_session on delete cascade,
  issue_key text not null, occurrences integer not null default 0, failures integer not null default 0,
  l2_attempts integer not null default 0, last_sequence bigint not null default 0,
  primary key(session_id,issue_key)
);
alter table public.chat_issue_state enable row level security;
revoke all on public.chat_issue_state from public,anon,authenticated;
grant all on public.chat_issue_state to service_role;
alter table public.chat_staff_review drop constraint chat_staff_review_action_check;
alter table public.chat_staff_review add constraint chat_staff_review_action_check check(action in ('correction','outcome','supervisor','moderate','original_access','policy_approval','summary','refilter','reopen','rating'));

-- Migrate historical participant turns without exposing pre-migration raw previews or tickets.
insert into public.chat_moderated_original(message_id,session_id,original_text,original_metadata,risk,reason)
select message_id,session_id,text,metadata,'yellow','pending_filter' from public.chat_message
where sender in ('user','agent') and not coalesce((metadata->>'system')::boolean,false)
on conflict(message_id) do nothing;
update public.chat_message set text='[Đang lọc nội dung để bảo vệ cuộc trò chuyện]',metadata=jsonb_build_object('filter_verified',false,'speaker',case when sender='agent' then 'HUMAN' else 'CUSTOMER' end),moderation_status='pending'
where sender in ('user','agent') and not coalesce((metadata->>'system')::boolean,false);
update public.chat_session set title='Cuộc trò chuyện hỗ trợ',last_message_preview='Cuộc trò chuyện hỗ trợ',
metadata=(metadata-'handoff_summary')||jsonb_build_object('intelligence',jsonb_build_object('filter_status','pending','source_seq',0),'warnings','[]'::jsonb),context_revision=context_revision+1;
update public.support_ticket set description='{"summary":"Cuộc trò chuyện đang được lọc lại"}',admin_reply=null where chat_session_id is not null;

create or replace function public.chat_sequence_message() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if new.sender in ('user','agent') and not coalesce((new.metadata->>'system')::boolean,false) then
    new.metadata:=jsonb_build_object('pending_original_text',new.text,'pending_original_metadata',new.metadata,'filter_verified',false,'speaker',case when new.sender='agent' then 'HUMAN' else 'CUSTOMER' end);
    new.text:='[Đang lọc nội dung để bảo vệ cuộc trò chuyện]'; new.moderation_status:='pending';
  end if;
  if new.sender='bot' or coalesce((new.metadata->>'system')::boolean,false) then
    new.metadata:=new.metadata||jsonb_build_object('filter_verified',true);
  end if;
  update public.chat_session set next_sequence=next_sequence+1,last_message_at=now(),last_message_preview=left(new.text,180),context_revision=context_revision+1,
    metadata=case when new.moderation_status='pending' then jsonb_set(metadata,'{intelligence}',coalesce(metadata->'intelligence','{}')||jsonb_build_object('filter_status','pending')) else metadata end
    where session_id=new.session_id returning next_sequence into new.sequence;
  if new.moderation_status<>'pending' then
    new.metadata:=new.metadata||jsonb_build_object('filter_revision',(select context_revision from public.chat_session where session_id=new.session_id));
  end if;
  if new.sequence is null then raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND'; end if;
  return new;
end; $$;
create function public.chat_archive_pending() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if new.moderation_status='pending' then
    insert into public.chat_moderated_original(message_id,session_id,original_text,original_metadata,risk,reason)
      values(new.message_id,new.session_id,new.metadata->>'pending_original_text',coalesce(new.metadata->'pending_original_metadata','{}'),'yellow','pending_filter');
    update public.chat_message set metadata=metadata-'pending_original_text'-'pending_original_metadata' where message_id=new.message_id;
  end if;
  return null;
end; $$;
create trigger chat_archive_pending after insert on public.chat_message for each row execute function public.chat_archive_pending();
-- INSERT RETURNING observes the before-trigger row: scrub it before returning any append/reply RPC.
create or replace function public.chat_append_user_turn(p_session uuid,p_profile uuid,p_guest uuid,p_text text,p_metadata jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; m public.chat_message%rowtype;
begin
  s:=public.chat_require_owner(p_session,p_profile,p_guest);
  if s.handoff_status='closed' then raise sqlstate 'PT409' using message='CHAT_SESSION_CLOSED'; end if;
  if length(btrim(p_text)) not between 1 and 1000 then raise sqlstate 'PT422' using message='INVALID_CHAT_TEXT'; end if;
  insert into public.chat_message(session_id,sender,text,metadata) values(p_session,'user',p_text,coalesce(p_metadata,'{}')) returning * into m;
  select * into m from public.chat_message where message_id=m.message_id;
  select * into s from public.chat_session where session_id=p_session;
  return jsonb_build_object('session',to_jsonb(s),'message',to_jsonb(m),'epoch',s.ai_epoch);
end; $$;

create or replace function public.chat_record_analysis(p_session uuid,p_message uuid,p_issue text,p_analysis jsonb,p_failed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; m public.chat_message%rowtype; st public.chat_issue_state%rowtype; r text; a jsonb; ctx jsonb; latest bigint; warning jsonb;
begin
  select * into s from public.chat_session where session_id=p_session for update;
  select * into m from public.chat_message where message_id=p_message and session_id=p_session and sender in ('user','agent') for update;
  if s.session_id is null or m.message_id is null then raise sqlstate 'PT404' using message='CHAT_MESSAGE_NOT_FOUND'; end if;
  insert into public.chat_issue_state(session_id,issue_key) values(p_session,p_issue) on conflict do nothing;
  select * into st from public.chat_issue_state where session_id=p_session and issue_key=p_issue for update;
  if p_failed then
    if not coalesce((m.metadata->>'model_failed')::boolean,false) then
      update public.chat_issue_state set failures=failures+1 where session_id=p_session and issue_key=p_issue returning * into st;
      update public.chat_message set metadata=metadata||'{"model_failed":true}' where message_id=p_message;
      update public.chat_session set ai_failures=ai_failures+1,context_revision=context_revision+1,
        metadata=jsonb_set(metadata,'{intelligence}',coalesce(metadata->'intelligence','{}')||jsonb_build_object('filter_status','outage','updated_at',now())) where session_id=p_session;
    end if;
  elsif not coalesce((m.metadata->>'filter_verified')::boolean,false) then
    r:=p_analysis->>'risk';
    if r not in ('green','yellow','orange','red') or nullif(btrim(p_analysis->'filtered'->>'text'),'') is null or
      coalesce((p_analysis->>'confidence')::numeric,-1) not between 0 and 1 then raise sqlstate 'PT422' using message='INVALID_FILTERED_ANALYSIS'; end if;
    if p_analysis->>'moderation'='none' and r in ('orange','red') then r:='yellow'; end if;
    a:=jsonb_build_object('intent',p_analysis->>'intent','level',p_analysis->>'level','issue',p_analysis->>'issue','sentiment',p_analysis->>'sentiment','risk',r,'moderation',p_analysis->>'moderation','confidence',p_analysis->'confidence','reasons',p_analysis->'reasons');
    ctx:=jsonb_build_object('summary',p_analysis->'filtered'->>'text','problem',p_analysis->'filtered'->>'problem','wanted',p_analysis->'filtered'->>'wanted','failed_approaches',coalesce(p_analysis->'filtered'->'failedApproaches','[]'),'sentiment',p_analysis->>'sentiment','source_sequence',m.sequence,'updated_at',now(),'issue_key',p_issue,'verified_status',case when s.profile_user_id is not null then 'member_account' when exists(select 1 from public.chat_order_grant where session_id=p_session and order_id=(s.metadata->>'selected_order_id')::uuid and guest_id=s.guest_id and expires_at>now()) then 'guest_order_otp' else 'unverified_guest' end);
    update public.chat_message set text=left(p_analysis->'filtered'->>'text',2000),moderation_status=case when p_analysis->>'moderation'<>'none' then 'restricted' else 'visible' end,
      metadata=jsonb_build_object('classification',a,'risk',r,'issue_key',p_issue,'context_issue_key',p_analysis->'context'->>'issueKey','filter_verified',true,'filter_revision',s.context_revision+1,'speaker',case when m.sender='agent' then 'HUMAN' else 'CUSTOMER' end)
      where message_id=p_message;
    update public.chat_moderated_original set risk=r,reason=p_analysis->>'moderation' where message_id=p_message;
    update public.chat_issue_state set occurrences=occurrences+case when m.sender='user' then 1 else 0 end,last_sequence=greatest(last_sequence,m.sequence) where session_id=p_session and issue_key=p_issue returning * into st;
    latest:=coalesce((s.metadata->'intelligence'->>'source_seq')::bigint,0);
    if m.sequence>=latest then
      select coalesce(jsonb_agg(jsonb_build_object('id',message_id,'issue',metadata->>'issue_key','text',case when metadata->'classification'->>'risk'='red' then 'Cần giám sát hỗ trợ xử lý nguy cơ an toàn' else 'Nội dung gây hại đã được lọc; cân nhắc hỗ trợ giám sát' end,'resolved',false)),'[]') into warning from
        (select distinct on (metadata->>'issue_key') message_id,metadata from public.chat_message where session_id=p_session and metadata->'classification'->>'risk' in ('orange','red') order by metadata->>'issue_key',sequence desc) grouped_warnings;
      update public.chat_session set risk_level=r,context_revision=context_revision+1,last_message_preview=case when m.sequence=next_sequence then left(p_analysis->'filtered'->>'text',180) else last_message_preview end,
        metadata=metadata||jsonb_build_object('filtered_context',ctx,'handoff_summary',case when m.sender='user' then ctx else coalesce(metadata->'handoff_summary',ctx) end,'summary_confirmation',jsonb_build_object('confirmed',false,'source_seq',m.sequence),
          'warnings',warning,'supervisor_required',coalesce((s.metadata->>'supervisor_required')::boolean,false) or exists(select 1 from public.chat_message where session_id=p_session and metadata->'classification'->>'risk'='red'),'intelligence',jsonb_build_object('confidence',p_analysis->'confidence','reasons',p_analysis->'reasons','trend',case when s.risk_level=r then 'stable' else 'changed' end,'updated_at',now(),'source_seq',m.sequence,'filter_status',case when exists(select 1 from public.chat_message where session_id=p_session and moderation_status='pending') then 'pending' else 'ready' end,
          'customer_sentiment',case when m.sender='user' then p_analysis->>'sentiment' else s.metadata->'intelligence'->>'customer_sentiment' end,'staff_sentiment',case when m.sender='agent' then p_analysis->>'sentiment' else s.metadata->'intelligence'->>'staff_sentiment' end))
        where session_id=p_session;
    else update public.chat_session set context_revision=context_revision+1 where session_id=p_session; end if;
    update public.support_ticket set description=(select metadata->'handoff_summary' from public.chat_session where session_id=p_session)::text,
      admin_reply=case when m.sender='agent' then p_analysis->'filtered'->>'text' else admin_reply end,priority=case when r='red' then 'urgent' else priority end,version=version+1 where chat_session_id=p_session;
  end if;
  select * into s from public.chat_session where session_id=p_session;
  return jsonb_build_object('session',to_jsonb(s),'occurrences',st.occurrences,'issue_failures',st.failures,'ai_failures',s.ai_failures,'l2_attempts',st.l2_attempts);
end; $$;

alter function public.chat_commit_ai_turn(uuid,bigint,bigint,jsonb,jsonb) rename to chat_commit_ai_turn_base;
create function public.chat_commit_ai_turn(p_session uuid,p_epoch bigint,p_user_sequence bigint,p_draft jsonb,p_sources jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb; issue text; attempts integer; s public.chat_session%rowtype;
begin
  select * into s from public.chat_session where session_id=p_session for update;
  select metadata->>'issue_key' into issue from public.chat_message where session_id=p_session and sequence=p_user_sequence and sender='user' and coalesce((metadata->>'filter_verified')::boolean,false);
  if issue is null then return jsonb_build_object('sent',false,'reason','FILTER_PENDING','session',to_jsonb(s)); end if;
  if exists(select 1 from public.chat_message where session_id=p_session and sender='bot' and (metadata->>'user_sequence')::bigint=p_user_sequence) then
    return jsonb_build_object('sent',false,'reason','ALREADY_REPLIED','session',to_jsonb(s));
  end if;
  if p_draft->'metadata'->>'level'='L2' then
    select l2_attempts into attempts from public.chat_issue_state where session_id=p_session and issue_key=issue for update;
    if attempts>=2 then return jsonb_build_object('sent',false,'reason','L2_ATTEMPTS_EXHAUSTED','session',to_jsonb(s)); end if;
  end if;
  result:=public.chat_commit_ai_turn_base(p_session,p_epoch,p_user_sequence,jsonb_set(p_draft,'{metadata}',coalesce(p_draft->'metadata','{}')||jsonb_build_object('user_sequence',p_user_sequence)),p_sources);
  if coalesce((result->>'sent')::boolean,false) and p_draft->'metadata'->>'level'='L2' then
    update public.chat_issue_state set l2_attempts=l2_attempts+1 where session_id=p_session and issue_key=issue;
  end if;
  if coalesce((result->>'sent')::boolean,false) then
    update public.chat_session set metadata=metadata||jsonb_build_object('verified_facts',(select coalesce(jsonb_agg(jsonb_build_object('kind',src->>'kind','id',src->>'id','version',src->>'version','approved',src->'approved')),'[]') from jsonb_array_elements(p_sources) src),
      'current_suggestion',jsonb_build_object('text',p_draft->>'text','approach',p_draft->'metadata'->>'approach','source_ids',p_draft->'metadata'->'source_ids','source_sequence',p_user_sequence,'verified_at',now())),context_revision=context_revision+1 where session_id=p_session;
    select * into s from public.chat_session where session_id=p_session;
    result:=jsonb_set(result,'{session}',to_jsonb(s));
  end if;
  return result;
end; $$;

alter function public.chat_handoff(uuid,uuid,uuid,jsonb,text,boolean) rename to chat_handoff_base;
create function public.chat_handoff(p_session uuid,p_profile uuid,p_guest uuid,p_summary jsonb,p_reason text,p_supervisor boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; result jsonb;
begin
  s:=public.chat_require_owner(p_session,p_profile,p_guest);
  if s.handoff_status='closed' then return jsonb_build_object('session',to_jsonb(s)); end if;
  result:=public.chat_handoff_base(p_session,p_profile,p_guest,coalesce(s.metadata->'handoff_summary',jsonb_build_object('summary','Yêu cầu hỗ trợ đang được lọc','problem','Cần nhân viên hỗ trợ','wanted','Nhân viên hỗ trợ','failed_approaches','[]'::jsonb)),p_reason,p_supervisor);
  update public.support_ticket set priority=case when p_supervisor then 'urgent' else 'high' end where ticket_id=(result->>'ticket_id')::uuid;
  return result;
end; $$;

alter function public.chat_staff_action(uuid,uuid,text,jsonb) rename to chat_staff_action_base;
create function public.chat_staff_action(p_session uuid,p_actor uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; actor public.users%rowtype; m public.chat_message%rowtype; result jsonb; ctx jsonb; a jsonb;
begin
  actor:=public.chat_staff_actor(p_actor,false);
  if actor.auth_user_id is null then raise sqlstate 'PT403' using message='STAFF_AUTH_ID_REQUIRED'; end if;
  select * into s from public.chat_session where session_id=p_session for update;
  if s.session_id is null then raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND'; end if;
  if p_action in ('assign','reply','close','resolve','outcome','summary','offer') and s.assigned_to is not null and s.assigned_to is distinct from actor.auth_user_id then raise sqlstate 'PT409' using message='CHAT_ASSIGNED_TO_OTHER'; end if;
  if coalesce((s.metadata->>'supervisor_required')::boolean,false) and actor.admin_role::text<>'super_admin' and p_action in ('assign','reply','close','resolve','outcome') then raise sqlstate 'PT403' using message='SUPERVISOR_REQUIRED'; end if;
  if p_action in ('summary','resolve','close','reopen','correction','refilter') and not coalesce((p_payload->>'confirmed')::boolean,false) then raise sqlstate 'PT422' using message='REVIEW_CONFIRMATION_REQUIRED'; end if;
  if p_action in ('correction','refilter') then
    select * into m from public.chat_message where session_id=p_session and message_id=(p_payload->>'message_id')::uuid;
    if m.message_id is null then raise sqlstate 'PT404' using message='CHAT_MESSAGE_NOT_FOUND'; end if;
    perform public.chat_staff_actor(p_actor,true);
    a:=p_payload->'analysis';
    if a is null then raise sqlstate 'PT422' using message='FILTERED_ANALYSIS_REQUIRED'; end if;
    update public.chat_message set metadata=metadata-'filter_verified',moderation_status='pending' where message_id=m.message_id;
    result:=public.chat_record_analysis(p_session,m.message_id,coalesce(m.metadata->>'issue_key','review:'||m.message_id::text),a,false);
    -- Corrections/refilters do not count as another customer occurrence.
    update public.chat_issue_state set occurrences=greatest(0,occurrences-1) where session_id=p_session and issue_key=coalesce(m.metadata->>'issue_key','review:'||m.message_id::text) and m.sender='user' and coalesce((m.metadata->>'filter_verified')::boolean,false);
    update public.chat_session set metadata=jsonb_set(metadata,'{intelligence,corrected}','true'),context_revision=context_revision+1,ai_epoch=ai_epoch+1 where session_id=p_session;
    update public.chat_session set metadata=metadata||jsonb_build_object('supervisor_required',exists(select 1 from public.chat_message where session_id=p_session and metadata->'classification'->>'risk'='red'),'warnings',
      (select coalesce(jsonb_agg(jsonb_build_object('id',message_id,'text','Nội dung gây hại đã được lọc; cần xem xét giám sát','resolved',false)),'[]') from public.chat_message where session_id=p_session and metadata->'classification'->>'risk' in ('orange','red'))) where session_id=p_session;
    if s.is_active and s.handoff_status='ai' and a->>'risk' in ('orange','red') and a->>'moderation'<>'none' then
      perform public.chat_handoff(p_session,s.profile_user_id,s.guest_id,'{}','CLASSIFICATION_CORRECTED',a->>'risk'='red');
    end if;
  elsif p_action='summary' then
    ctx:=p_payload->'filtered_summary';
    if ctx is null then raise sqlstate 'PT422' using message='FILTERED_SUMMARY_REQUIRED'; end if;
    update public.chat_session set metadata=metadata||jsonb_build_object('handoff_summary',ctx,'filtered_context',ctx,'summary_confirmation',jsonb_build_object('confirmed',true,'by',p_actor,'at',now())),context_revision=context_revision+1 where session_id=p_session;
    update public.support_ticket set description=ctx::text,version=version+1 where chat_session_id=p_session;
  elsif p_action in ('resolve','close') then
    if nullif(p_payload->'outcome'->>'resolution','') is null or p_payload->'outcome'->>'finalSentiment' not in ('positive','neutral','negative') then raise sqlstate 'PT422' using message='RESOLUTION_OUTCOME_REQUIRED'; end if;
    result:=public.chat_staff_action_base(p_session,p_actor,'close',jsonb_build_object('outcome',p_payload->'outcome'->>'resolution'));
    update public.chat_session set metadata=metadata||jsonb_build_object('outcome',p_payload->'outcome','closed_at',now()),context_revision=context_revision+1 where session_id=p_session;
  elsif p_action='reopen' then
    result:=public.chat_owner_lifecycle(p_session,s.profile_user_id,s.guest_id,'reopen',p_payload);
    insert into public.chat_staff_review(session_id,actor_id,action,text) values(p_session,p_actor,'reopen',coalesce(p_payload->>'text','Reopened by staff'));
    return result;
  else
    result:=public.chat_staff_action_base(p_session,p_actor,p_action,p_payload);
    if p_action='reply' then
      select * into m from public.chat_message where message_id=(result->'message'->>'message_id')::uuid;
      update public.support_ticket set admin_reply='[Đang lọc nội dung]' where chat_session_id=p_session;
    end if;
  end if;
  if p_action in ('summary','resolve','reopen','correction','refilter') then
    insert into public.chat_staff_review(session_id,message_id,actor_id,action,text,classification) values(p_session,m.message_id,p_actor,case when p_action='resolve' then 'outcome' else p_action end,coalesce(p_payload->>'text','Staff review'),p_payload->'classification');
  end if;
  select * into s from public.chat_session where session_id=p_session;
  return jsonb_build_object('session',to_jsonb(s),'message',to_jsonb(m));
end; $$;

create function public.chat_owner_lifecycle(p_session uuid,p_profile uuid,p_guest uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; linked public.chat_session%rowtype; hours numeric;
begin
  -- Closed/archived ownership checked under the same lock without requiring is_active.
  select * into s from public.chat_session where session_id=p_session for update;
  if s.session_id is null or (p_profile is not null and s.profile_user_id is distinct from p_profile) or
    (p_profile is null and (s.profile_user_id is not null or p_guest is null or s.guest_id is distinct from p_guest)) then raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND'; end if;
  if p_profile is not null and not exists(select 1 from public.users where user_id=p_profile and is_active and role::text in ('member','admin')) then raise sqlstate 'PT403' using message='ACCOUNT_ACCESS_DENIED'; end if;
  if p_action='close' then
    update public.chat_session set is_active=false,handoff_status='closed',ai_epoch=ai_epoch+1,context_revision=context_revision+1,
      metadata=metadata||jsonb_build_object('closed_at',now(),'outcome',jsonb_build_object('resolution','Khách hàng kết thúc cuộc trò chuyện','finalSentiment',coalesce(metadata->'intelligence'->>'customer_sentiment','unknown'))) where session_id=p_session;
    update public.support_ticket set status='closed',resolved_at=now(),version=version+1 where chat_session_id=p_session;
  elsif p_action='rating' then
    if s.handoff_status<>'closed' or (p_payload->>'rating')::integer not between 1 and 5 then raise sqlstate 'PT422' using message='INVALID_CASE_RATING'; end if;
    update public.chat_session set metadata=jsonb_set(metadata,'{outcome}',coalesce(metadata->'outcome','{}')||jsonb_build_object('rating',(p_payload->>'rating')::integer,'feedback',coalesce(p_payload->>'filtered_text',''),'rated_at',now())),context_revision=context_revision+1 where session_id=p_session;
  elsif p_action='reopen' then
    if s.handoff_status<>'closed' then raise sqlstate 'PT409' using message='CHAT_NOT_CLOSED'; end if;
    hours:=greatest(1,least(2160,coalesce((p_payload->>'reopen_hours')::numeric,168)));
    if coalesce((s.metadata->>'closed_at')::timestamptz,s.updated_at)+hours*interval '1 hour'>now() then
      update public.chat_session set is_active=true,handoff_status='requested',assigned_to=null,ai_epoch=ai_epoch+1,context_revision=context_revision+1,metadata=(metadata-'closed_at')||jsonb_build_object('reopen_reason',coalesce(p_payload->>'filtered_text',''),'reopened_at',now()) where session_id=p_session;
      update public.support_ticket set status='open',resolved_at=null,version=version+1 where chat_session_id=p_session;
    else
      insert into public.chat_session(user_id,profile_user_id,guest_id,title,source,is_active,handoff_status,metadata)
      values(s.user_id,s.profile_user_id,s.guest_id,'Cuộc trò chuyện hỗ trợ','chatbot',true,'requested',jsonb_build_object('previous_session_id',p_session,'handoff_summary',coalesce(s.metadata->'handoff_summary','{}'),'filtered_context',coalesce(s.metadata->'filtered_context','{}'),'reopen_reason',coalesce(p_payload->>'filtered_text',''),'reopened_at',now())) returning * into linked;
      insert into public.support_ticket(user_id,title,description,priority,status,chat_session_id) values(s.profile_user_id,'Chat CSKH '||left(linked.session_id::text,8),coalesce(s.metadata->'handoff_summary','{}')::text,'high','open',linked.session_id) returning ticket_id into linked.support_ticket_id;
      update public.chat_session set support_ticket_id=linked.support_ticket_id where session_id=linked.session_id;
      return jsonb_build_object('session',to_jsonb(linked),'linked_from',p_session);
    end if;
  else raise sqlstate 'PT422' using message='INVALID_CHAT_LIFECYCLE'; end if;
  select * into s from public.chat_session where session_id=p_session;
  return jsonb_build_object('session',to_jsonb(s));
end; $$;

alter function public.chat_read_order(uuid,uuid,uuid,uuid) rename to chat_read_order_base;
create function public.chat_read_order(p_session uuid,p_profile uuid,p_guest uuid,p_order uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
  result:=public.chat_read_order_base(p_session,p_profile,p_guest,p_order);
  update public.chat_session set metadata=metadata||jsonb_build_object('selected_order_id',p_order) where session_id=p_session;
  return result;
end; $$;

-- Legacy ticket RPCs are SECURITY DEFINER: their elevated current_user is not an authorization signal.
create function public.chat_guard_linked_ticket() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare linked boolean; jwt_role text; request_role text;
begin
  if tg_op='INSERT' then linked:=new.chat_session_id is not null;
  elsif tg_op='DELETE' then linked:=old.chat_session_id is not null;
  else linked:=old.chat_session_id is not null or new.chat_session_id is not null; end if;
  if linked then
    jwt_role:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','');
    request_role:=coalesce(current_setting('role',true),'');
    if auth.uid() is not null or jwt_role in ('anon','authenticated') or request_role in ('anon','authenticated') then
      raise sqlstate 'PT403' using message='CHAT_LINKED_TICKET_CANONICAL_REQUIRED';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end; $$;
create trigger chat_guard_linked_ticket before insert or update or delete on public.support_ticket
for each row execute function public.chat_guard_linked_ticket();

-- New functions default to PUBLIC execute; retain a single trusted server boundary.
do $$ declare fn regprocedure; begin
  for fn in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname like 'chat_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',fn);
    execute format('grant execute on function %s to service_role',fn);
  end loop;
end $$;
comment on column public.chat_session.context_revision is 'Monotonic canonical filtered-context revision; durable report idempotency key.';
comment on table public.chat_issue_state is 'Per unresolved issue failure and bounded L2 attempt state; never inferred from session-wide counters.';
commit;
