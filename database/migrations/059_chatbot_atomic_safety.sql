-- KAN-32: quarantine participant text, fence queued acknowledgements and retain ordered filtered evidence.
begin;

create or replace function public.chat_sequence_message() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; participant boolean;
begin
  select * into s from public.chat_session where session_id=new.session_id for update;
  if s.session_id is null then raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND'; end if;
  if new.sender='bot' and (not s.is_active or s.handoff_status in ('assigned','closed') or s.assigned_to is not null) then
    raise sqlstate 'PT409' using message='CHAT_AI_DISABLED';
  end if;
  new.metadata:=coalesce(new.metadata,'{}'::jsonb);
  participant:=new.sender='user' or (new.sender='agent' and not
    (new.metadata->>'system'='true' and new.text='Nhân viên CSKH đã tiếp nhận cuộc trò chuyện.'));
  if participant then
    new.metadata:=jsonb_build_object('pending_original_text',new.text,'pending_original_metadata',new.metadata,
      'filter_verified',false,'speaker',case when new.sender='agent' then 'HUMAN' else 'CUSTOMER' end);
    new.text:='[Đang lọc nội dung để bảo vệ cuộc trò chuyện]';
    new.moderation_status:='pending';
  else
    new.metadata:=new.metadata||jsonb_build_object('filter_verified',true,'speaker',case when new.sender='agent' then 'HUMAN' else 'AI' end);
    new.moderation_status:='visible';
  end if;
  update public.chat_session set next_sequence=next_sequence+1,last_message_at=now(),
    last_message_preview=left(new.text,180),context_revision=context_revision+1,
    metadata=jsonb_set(metadata,'{intelligence}',coalesce(metadata->'intelligence','{}')||jsonb_build_object(
      'filter_status',case when participant or exists(select 1 from public.chat_message where session_id=new.session_id and moderation_status='pending') then 'pending' else 'ready' end))
    where session_id=new.session_id returning next_sequence into new.sequence;
  return new;
end; $$;

-- Do not trust previously auto-verified participant rows lacking actual classification evidence.
insert into public.chat_moderated_original(message_id,session_id,original_text,original_metadata,risk,reason)
select message_id,session_id,text,metadata,'yellow','pending_filter' from public.chat_message
where sender in ('user','agent') and metadata->'classification' is null
  and not (sender='agent' and metadata->>'system'='true' and text='Nhân viên CSKH đã tiếp nhận cuộc trò chuyện.')
on conflict(message_id) do nothing;
update public.chat_message set text='[Đang lọc nội dung để bảo vệ cuộc trò chuyện]',moderation_status='pending',
  metadata=jsonb_build_object('filter_verified',false,'speaker',case when sender='agent' then 'HUMAN' else 'CUSTOMER' end)
where sender in ('user','agent') and metadata->'classification' is null
  and not (sender='agent' and metadata->>'system'='true' and text='Nhân viên CSKH đã tiếp nhận cuộc trò chuyện.');
update public.chat_session s set title='Cuộc trò chuyện hỗ trợ',last_message_preview='[Đang lọc nội dung để bảo vệ cuộc trò chuyện]',
  ai_epoch=ai_epoch+1,context_revision=context_revision+1,
  metadata=(metadata-'handoff_summary'-'filtered_context'-'current_suggestion'-'verified_facts')||
    jsonb_build_object('intelligence',jsonb_build_object('filter_status','pending','source_seq',0),'summary_confirmation',jsonb_build_object('confirmed',false))
where exists(select 1 from public.chat_message m where m.session_id=s.session_id and m.moderation_status='pending');
update public.support_ticket t set description='{"summary":"Yêu cầu hỗ trợ đang được lọc"}',admin_reply=null
where exists(select 1 from public.chat_message m where m.session_id=t.chat_session_id and m.moderation_status='pending');

-- Scrub legacy fabricated VELURACARE handoff messages and previews, and normalize assigned_to to users.user_id.
update public.chat_message set text='Mình hiểu bạn đang cần được hỗ trợ. Mình đã chuyển cuộc trò chuyện tới nhân viên CSKH. Bạn có thể chia sẻ thêm thông tin trong lúc chờ nhân viên tiếp nhận.',
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('system',false,'handoff',true,'speaker','AI')
where sender='bot' and (text ilike '%VELURACARE%' or text ilike '%Yêu cầu của bạn đã được chuyển tới nhân viên CSKH%');
update public.chat_session set last_message_preview='Mình hiểu bạn đang cần được hỗ trợ. Mình đã chuyển cuộc trò chuyện tới nhân viên CSKH.'
where last_message_preview ilike '%VELURACARE%' or last_message_preview ilike '%Yêu cầu của bạn đã được chuyển tới%';
update public.chat_session s set assigned_to=u.user_id
from public.users u where s.assigned_to=u.auth_user_id and u.user_id is distinct from u.auth_user_id;

create or replace function public.chat_record_analysis(p_session uuid,p_message uuid,p_issue text,p_analysis jsonb,p_failed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; m public.chat_message%rowtype; st public.chat_issue_state%rowtype;
  r text; a jsonb; ctx jsonb; warning jsonb; latest bigint; current_issue text; counted boolean;
begin
  select * into s from public.chat_session where session_id=p_session for update;
  select * into m from public.chat_message where message_id=p_message and session_id=p_session and sender in ('user','agent') for update;
  if s.session_id is null or m.message_id is null then raise sqlstate 'PT404' using message='CHAT_MESSAGE_NOT_FOUND'; end if;
  if nullif(btrim(p_issue),'') is null or length(p_issue)>300 then raise sqlstate 'PT422' using message='INVALID_CHAT_ISSUE'; end if;
  current_issue:=coalesce(m.metadata->>'issue_key',p_issue);
  insert into public.chat_issue_state(session_id,issue_key) values(p_session,current_issue) on conflict do nothing;
  select * into st from public.chat_issue_state where session_id=p_session and issue_key=current_issue for update;
  latest:=coalesce((s.metadata->'intelligence'->>'source_seq')::bigint,0);
  if p_failed then
    if not coalesce((m.metadata->>'model_failed')::boolean,false) then
      update public.chat_issue_state set failures=failures+1 where session_id=p_session and issue_key=current_issue returning * into st;
      update public.chat_message set metadata=metadata||jsonb_build_object('model_failed',true,'issue_key',current_issue,'trace',coalesce(p_analysis->'trace','[]'::jsonb)) where message_id=p_message;
      update public.chat_session set ai_failures=ai_failures+1,context_revision=context_revision+1,
        metadata=case when m.sequence>=latest then jsonb_set(metadata,'{intelligence}',coalesce(metadata->'intelligence','{}')||
          jsonb_build_object('filter_status','outage','source_seq',m.sequence,'updated_at',now(),'trace',coalesce(p_analysis->'trace','[]'::jsonb))) else metadata end where session_id=p_session;
    end if;
  elsif m.metadata->>'filter_verified' is distinct from 'true' then
    r:=p_analysis->>'risk';
    if r is null or r not in ('green','yellow','orange','red') or
      coalesce(p_analysis->>'moderation','') not in ('none','abuse','threat','illegal','sensitive') or
      nullif(btrim(p_analysis->'filtered'->>'text'),'') is null or
      coalesce((p_analysis->>'confidence')::numeric,-1) not between 0 and 1 then
      raise sqlstate 'PT422' using message='INVALID_FILTERED_ANALYSIS';
    end if;
    if p_analysis->>'moderation'='none' and r in ('orange','red') then r:='yellow'; end if;
    counted:=coalesce((m.metadata->>'occurrence_counted')::boolean,false);
    a:=jsonb_build_object('intent',p_analysis->>'intent','level',p_analysis->>'level','issue',p_analysis->>'issue',
      'sentiment',p_analysis->>'sentiment','risk',r,'moderation',p_analysis->>'moderation','confidence',p_analysis->'confidence',
      'reasons',p_analysis->'reasons','emotion',p_analysis->'emotion','riskAssessment',p_analysis->'riskAssessment',
      'context',jsonb_build_object('escalationTrend',p_analysis->'context'->>'escalationTrend','repeatCount',p_analysis->'context'->'repeatCount'),
      'trace',p_analysis->'trace');
    ctx:=jsonb_build_object('summary',p_analysis->'filtered'->>'text','problem',p_analysis->'filtered'->>'problem',
      'wanted',p_analysis->'filtered'->>'wanted','unresolved_need',p_analysis->'filtered'->>'wanted',
      'failed_approaches',coalesce(p_analysis->'filtered'->'failedApproaches','[]'),
      'confirmed_facts',case when s.profile_user_id is not null or exists(select 1 from public.chat_order_grant
        where session_id=p_session and order_id::text=s.metadata->>'selected_order_id' and guest_id=s.guest_id and expires_at>now())
        then jsonb_build_array('Đã xác minh quyền truy cập của khách hàng') else '[]'::jsonb end,
      'unconfirmed_claims',jsonb_build_array(p_analysis->'filtered'->>'problem'),
      'recommendations',jsonb_build_array('Kiểm tra dữ kiện đơn hàng và chính sách đã phê duyệt trước khi cam kết phương án xử lý.'),
      'sentiment',p_analysis->>'sentiment','source_sequence',m.sequence,'session_id',p_session,'updated_at',now(),'issue_key',current_issue,
      'verified_status',case when s.profile_user_id is not null then 'member_account' when exists(select 1 from public.chat_order_grant
        where session_id=p_session and order_id::text=s.metadata->>'selected_order_id' and guest_id=s.guest_id and expires_at>now())
        then 'guest_order_otp' else 'unverified_guest' end);
    update public.chat_message set text=left(p_analysis->'filtered'->>'text',2000),
      moderation_status=case when p_analysis->>'moderation'<>'none' then 'restricted' else 'visible' end,
      metadata=jsonb_build_object('classification',a,'risk',r,'issue_key',current_issue,'context_issue_key',p_analysis->'context'->>'issueKey',
        'filter_verified',true,'filter_revision',s.context_revision+1,'occurrence_counted',m.sender='user' or counted,
        'speaker',case when m.sender='agent' then 'HUMAN' else 'CUSTOMER' end) where message_id=p_message;
    update public.chat_moderated_original set risk=r,reason=p_analysis->>'moderation' where message_id=p_message;
    update public.chat_issue_state set occurrences=occurrences+case when m.sender='user' and not counted then 1 else 0 end,
      last_sequence=greatest(last_sequence,m.sequence) where session_id=p_session and issue_key=current_issue returning * into st;
    select coalesce(jsonb_agg(jsonb_build_object('id',issue,'issue',issue,'text',case when severe then
      'Cần giám sát hỗ trợ xử lý nguy cơ an toàn' else 'Nội dung gây hại đã được lọc; cân nhắc hỗ trợ giám sát' end,'resolved',false) order by issue),'[]')
      into warning from (select coalesce(metadata->>'issue_key',message_id::text) as issue,
        bool_or(metadata->'classification'->>'risk'='red') as severe from public.chat_message where session_id=p_session
        and metadata->'classification'->>'risk' in ('orange','red') group by coalesce(metadata->>'issue_key',message_id::text)) warnings;
    update public.chat_session set context_revision=context_revision+1,
      risk_level=case when m.sequence>=latest then r else risk_level end,
      last_message_preview=case when m.sequence=next_sequence then left(p_analysis->'filtered'->>'text',180) else last_message_preview end,
      metadata=metadata||jsonb_build_object('warnings',warning,'supervisor_required',
        coalesce((metadata->>'supervisor_requested')::boolean,false) or exists(select 1 from public.chat_message
          where session_id=p_session and metadata->'classification'->>'risk'='red'))||
        case when m.sender='user' and m.sequence>=coalesce((metadata->'filtered_context'->>'source_sequence')::bigint,0) then
          jsonb_build_object('filtered_context',ctx,'handoff_summary',ctx,'summary_confirmation',jsonb_build_object('confirmed',false,'source_seq',m.sequence)) else '{}'::jsonb end||
        case when m.sequence>=latest then jsonb_build_object('intelligence',coalesce(metadata->'intelligence','{}')||
          jsonb_build_object('classification',case when m.sender='user' then a else coalesce(metadata->'intelligence'->'classification',a) end,
            'confidence',p_analysis->'confidence','reasons',p_analysis->'reasons','emotion',p_analysis->'emotion',
            'riskAssessment',p_analysis->'riskAssessment','trace',p_analysis->'trace',
            'trend',coalesce(p_analysis->'context'->>'escalationTrend',case when s.risk_level=r then 'stable' else 'changed' end),
            'updated_at',now(),'source_seq',m.sequence,'filter_status',case when exists(select 1 from public.chat_message
              where session_id=p_session and moderation_status='pending') then 'pending' else 'ready' end,
            'customer_sentiment',case when m.sender='user' then p_analysis->>'sentiment' else metadata->'intelligence'->>'customer_sentiment' end,
            'staff_sentiment',case when m.sender='agent' then p_analysis->>'sentiment' else metadata->'intelligence'->>'staff_sentiment' end))
        else jsonb_build_object('intelligence',coalesce(metadata->'intelligence','{}')||jsonb_build_object('filter_status',
          case when exists(select 1 from public.chat_message where session_id=p_session and moderation_status='pending') then 'pending' else 'ready' end)) end
      where session_id=p_session;
    update public.support_ticket set description=(select coalesce(metadata->'handoff_summary','{}') from public.chat_session where session_id=p_session)::text,
      admin_reply=case when m.sender='agent' and m.sequence=(select max(sequence) from public.chat_message where session_id=p_session and sender='agent')
        then p_analysis->'filtered'->>'text' else admin_reply end,
      priority=case when r='red' then 'urgent'::public.ticket_priority else priority end,version=version+1 where chat_session_id=p_session;
  end if;
  select * into s from public.chat_session where session_id=p_session;
  return jsonb_build_object('session',to_jsonb(s),'occurrences',st.occurrences,'issue_failures',st.failures,'ai_failures',s.ai_failures,'l2_attempts',st.l2_attempts);
end; $$;

create or replace function public.chat_handoff(p_session uuid,p_profile uuid,p_guest uuid,p_summary jsonb,p_reason text,p_supervisor boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; ticket uuid; m public.chat_message%rowtype; ctx jsonb;
begin
  s:=public.chat_require_owner(p_session,p_profile,p_guest);
  if s.handoff_status='closed' then return jsonb_build_object('session',to_jsonb(s)); end if;
  -- Only this session's committed filtered context can describe a case; caller prose is not evidence.
  ctx:=coalesce(s.metadata->'handoff_summary',jsonb_build_object('summary','Yêu cầu hỗ trợ đang được lọc','session_id',p_session));
  insert into public.support_ticket(user_id,title,description,priority,status,chat_session_id)
    values(s.profile_user_id,'Chat CSKH '||left(p_session::text,8),ctx::text,
      case when p_supervisor then 'urgent'::public.ticket_priority else 'high'::public.ticket_priority end,'open'::public.ticket_status,p_session)
    on conflict(chat_session_id) where chat_session_id is not null do update set
      priority=case when p_supervisor then 'urgent'::public.ticket_priority else support_ticket.priority end returning ticket_id into ticket;
  update public.chat_session set support_ticket_id=ticket where session_id=p_session and support_ticket_id is distinct from ticket;
  if s.handoff_status='ai' and s.assigned_to is null then
    update public.chat_session set handoff_status='requested',ai_epoch=ai_epoch+1,context_revision=context_revision+1,
      metadata=metadata||jsonb_build_object('handoff_summary',ctx,'handoff_reason',p_reason,
        'supervisor_required',coalesce((metadata->>'supervisor_required')::boolean,false) or p_supervisor,
        'summary_confirmation',jsonb_build_object('confirmed',false)) where session_id=p_session;
    insert into public.chat_message(session_id,sender,text,metadata) values(p_session,'bot',
      'Mình hiểu bạn đang cần được hỗ trợ. Mình đã chuyển cuộc trò chuyện tới nhân viên CSKH. Bạn có thể chia sẻ thêm thông tin trong lúc chờ nhân viên tiếp nhận.',
      jsonb_build_object('system',false,'handoff',true,'speaker','AI','ticket_id',ticket)) returning * into m;
  elsif p_supervisor and not coalesce((s.metadata->>'supervisor_required')::boolean,false) then
    update public.chat_session set metadata=metadata||'{"supervisor_required":true}',context_revision=context_revision+1 where session_id=p_session;
  end if;
  select * into s from public.chat_session where session_id=p_session;
  return jsonb_build_object('session',to_jsonb(s),'ticket_id',ticket,'message',to_jsonb(m));
end; $$;

-- Keep official-source version, live stock, order ownership/OTP and approved-promotion validation.
create or replace function public.chat_commit_ai_turn_governed(p_session uuid,p_epoch bigint,p_user_sequence bigint,p_draft jsonb,p_sources jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb; issue text; st public.chat_issue_state%rowtype; s public.chat_session%rowtype;
begin
  select * into s from public.chat_session where session_id=p_session for update;
  if s.session_id is null then raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND'; end if;
  if not s.is_active or s.handoff_status<>'ai' or s.assigned_to is not null or s.ai_epoch is distinct from p_epoch or
    p_user_sequence is distinct from (select max(sequence) from public.chat_message where session_id=p_session and sender='user') then
    return jsonb_build_object('sent',false,'reason','HUMAN_OR_NEWER_TURN','session',to_jsonb(s));
  end if;
  select metadata->>'issue_key' into issue from public.chat_message where session_id=p_session and sequence=p_user_sequence
    and sender='user' and metadata->>'filter_verified'='true';
  if issue is null then return jsonb_build_object('sent',false,'reason','FILTER_PENDING','session',to_jsonb(s)); end if;
  if exists(select 1 from public.chat_message where session_id=p_session and sender='bot' and metadata->>'user_sequence'=p_user_sequence::text) then
    return jsonb_build_object('sent',false,'reason','ALREADY_REPLIED','session',to_jsonb(s));
  end if;
  select * into st from public.chat_issue_state where session_id=p_session and issue_key=issue for update;
  if st.occurrences>=3 then return jsonb_build_object('sent',false,'reason','REPEATED_ISSUE','session',to_jsonb(s)); end if;
  if p_draft->'metadata'->>'level'='L2' and coalesce(st.l2_attempts,0)>=2 then
    return jsonb_build_object('sent',false,'reason','L2_ATTEMPTS_EXHAUSTED','session',to_jsonb(s));
  end if;
  result:=public.chat_commit_ai_turn_base(p_session,p_epoch,p_user_sequence,
    jsonb_set(p_draft,'{metadata}',coalesce(p_draft->'metadata','{}')||jsonb_build_object('user_sequence',p_user_sequence)),p_sources);
  if result->>'sent'='true' then
    if p_draft->'metadata'->>'level'='L2' then
      update public.chat_issue_state set l2_attempts=l2_attempts+1 where session_id=p_session and issue_key=issue;
    end if;
    update public.chat_session set metadata=metadata||jsonb_build_object('verified_facts',
      (select coalesce(jsonb_agg(jsonb_build_object('kind',src->>'kind','id',src->>'id','version',src->>'version','approved',src->'approved')),'[]') from jsonb_array_elements(p_sources) src),
      'current_suggestion',jsonb_build_object('text',p_draft->>'text','approach',p_draft->'metadata'->>'approach',
        'source_ids',p_draft->'metadata'->'source_ids','source_sequence',p_user_sequence,'verified_at',now())),
      context_revision=context_revision+1 where session_id=p_session returning * into s;
    result:=jsonb_set(result,'{session}',to_jsonb(s));
  end if;
  return result;
end; $$;

/** The queue may acknowledge a filtered latest turn, never publish a new business answer. */
create or replace function public.chat_commit_queued_turn(p_session uuid,p_epoch bigint,p_user_sequence bigint,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; m public.chat_message%rowtype; ack text;
begin
  select * into s from public.chat_session where session_id=p_session for update;
  if s.session_id is null then raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND'; end if;
  if not s.is_active or s.handoff_status<>'requested' or s.assigned_to is not null or s.ai_epoch is distinct from p_epoch or
    p_user_sequence is distinct from (select max(sequence) from public.chat_message where session_id=p_session and sender='user') then
    return jsonb_build_object('sent',false,'reason','HUMAN_OR_NEWER_TURN','session',to_jsonb(s));
  end if;
  if not exists(select 1 from public.chat_message where session_id=p_session and sequence=p_user_sequence and sender='user' and metadata->>'filter_verified'='true') then
    return jsonb_build_object('sent',false,'reason','FILTER_PENDING','session',to_jsonb(s));
  end if;
  if exists(select 1 from public.chat_message where session_id=p_session and sender='bot' and metadata->>'user_sequence'=p_user_sequence::text) then
    return jsonb_build_object('sent',false,'reason','ALREADY_REPLIED','session',to_jsonb(s));
  end if;
  if coalesce(p_payload->>'kind','received') not in ('received','distress') then raise sqlstate 'PT422' using message='INVALID_QUEUE_ACKNOWLEDGEMENT'; end if;
  ack:=case when p_payload->>'kind'='distress' then
    'Mình hiểu việc phải chờ có thể khiến bạn thêm phiền lòng. Mình đã ghi nhận điều bạn vừa chia sẻ để nhân viên CSKH tiếp tục hỗ trợ khi tiếp nhận cuộc trò chuyện.' else
    'Mình đã ghi nhận thông tin bạn vừa chia sẻ. Cuộc trò chuyện vẫn đang chờ nhân viên CSKH tiếp nhận; bạn có thể bổ sung thông tin nếu cần.' end;
  insert into public.chat_message(session_id,sender,text,metadata) values(p_session,'bot',ack,
    jsonb_build_object('queued_acknowledgement',true,'user_sequence',p_user_sequence,'level','L3','trace',p_payload->'trace')) returning * into m;
  select * into s from public.chat_session where session_id=p_session;
  return jsonb_build_object('sent',true,'message',to_jsonb(m),'session',to_jsonb(s));
end; $$;

comment on function public.chat_commit_queued_turn(uuid,bigint,bigint,jsonb) is 'Atomic requested-only acknowledgement. payload.kind is received or distress; no arbitrary text, solution, offer or SLA. Session lock fences staff join, epoch and latest filtered customer sequence.';
comment on function public.chat_record_analysis(uuid,uuid,text,jsonb,boolean) is 'Filtered analysis is monotonic by source sequence. classification.trace and intelligence.trace retain content-free model measurements; emotion and riskAssessment remain separate. Originals stay supervisor-audited.';

create or replace function public.chat_owner_lifecycle(p_session uuid,p_profile uuid,p_guest uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; linked public.chat_session%rowtype; hours numeric;
begin
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
  elsif p_action='confirm_summary' then
    if coalesce((p_payload->>'confirmed')::boolean,false) is not true then raise sqlstate 'PT422' using message='SUMMARY_CONFIRMATION_REQUIRED'; end if;
    if coalesce((p_payload->>'source_sequence')::bigint,-1) is distinct from coalesce((s.metadata->'handoff_summary'->>'source_sequence')::bigint,-2) then
      raise sqlstate 'PT409' using message='SUMMARY_STALE';
    end if;
    update public.chat_session set metadata=metadata||jsonb_build_object('summary_confirmation',
      jsonb_build_object('confirmed',true,'by','customer','source_seq',(p_payload->>'source_sequence')::bigint,'context_revision',s.context_revision,'at',now())),
      context_revision=context_revision+1 where session_id=p_session;
  elsif p_action='reopen' then
    if s.handoff_status<>'closed' then raise sqlstate 'PT409' using message='CHAT_NOT_CLOSED'; end if;
    hours:=greatest(1,least(2160,coalesce((p_payload->>'reopen_hours')::numeric,168)));
    if coalesce((s.metadata->>'closed_at')::timestamptz,s.updated_at)+hours*interval '1 hour'>now() then
      update public.chat_session set is_active=true,handoff_status='requested',assigned_to=null,ai_epoch=ai_epoch+1,context_revision=context_revision+1,metadata=(metadata-'closed_at')||jsonb_build_object('reopen_reason',coalesce(p_payload->>'filtered_text',''),'reopened_at',now()) where session_id=p_session;
      update public.support_ticket set status='open',resolved_at=null,version=version+1 where chat_session_id=p_session;
    else
      insert into public.chat_session(user_id,profile_user_id,guest_id,title,source,is_active,handoff_status,metadata)
      values(s.user_id,s.profile_user_id,s.guest_id,'Cuộc trò chuyện hỗ trợ','chatbot',true,'requested',jsonb_build_object('previous_session_id',p_session,'handoff_summary',coalesce(s.metadata->'handoff_summary','{}'),'filtered_context',coalesce(s.metadata->'filtered_context','{}'),'reopen_reason',coalesce(p_payload->>'filtered_text',''),'reopened_at',now())) returning * into linked;
      insert into public.support_ticket(user_id,title,description,priority,status,chat_session_id) values(s.profile_user_id,'Chat CSKH '||left(linked.session_id::text,8),coalesce(s.metadata->'handoff_summary','{}')::text,'high'::public.ticket_priority,'open'::public.ticket_status,linked.session_id) returning ticket_id into linked.support_ticket_id;
      update public.chat_session set support_ticket_id=linked.support_ticket_id where session_id=linked.session_id;
      return jsonb_build_object('session',to_jsonb(linked),'linked_from',p_session);
    end if;
  else raise sqlstate 'PT422' using message='INVALID_CHAT_LIFECYCLE'; end if;
  select * into s from public.chat_session where session_id=p_session;
  return jsonb_build_object('session',to_jsonb(s));
end; $$;

create or replace function public.chat_staff_action_base(p_session uuid,p_actor uuid,p_action text,p_payload jsonb)
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
    update public.chat_session set ai_epoch=ai_epoch+1,handoff_status='assigned',assigned_to=actor.user_id,
      metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('assigned_agent_name',actor.full_name)
      where session_id=p_session;
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

create or replace function public.chat_staff_action(p_session uuid,p_actor uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.chat_session%rowtype; actor public.users%rowtype; m public.chat_message%rowtype; result jsonb; ctx jsonb; a jsonb;
begin
  actor:=public.chat_staff_actor(p_actor,false);
  select * into s from public.chat_session where session_id=p_session for update;
  if s.session_id is null then raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND'; end if;
  if p_action in ('assign','reply','close','resolve','outcome','summary','offer') and s.assigned_to is not null and s.assigned_to is distinct from actor.user_id and s.assigned_to is distinct from actor.auth_user_id then raise sqlstate 'PT409' using message='CHAT_ASSIGNED_TO_OTHER'; end if;
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

create or replace function public.chat_confirm_support_offer(p_session uuid,p_actor uuid,p_offer uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare actor public.users%rowtype; s public.chat_session%rowtype; v public.voucher%rowtype; p public.promotion%rowtype;
  c public.chat_support_offer_claim%rowtype; customer uuid; phone text; offers jsonb;
begin
  actor:=public.chat_staff_actor(p_actor,false);
  select * into s from public.chat_session where session_id=p_session for update;
  if s.session_id is null then raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND'; end if;
  if not s.is_active or s.handoff_status<>'assigned' or (s.assigned_to is distinct from actor.user_id and s.assigned_to is distinct from actor.auth_user_id) then
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

do $$ declare fn regprocedure; begin
  for fn in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname like 'chat_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',fn);
    execute format('grant execute on function %s to service_role',fn);
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
