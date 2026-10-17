-- KAN-32: durable urgent reports contain only verified, filtered session context.
begin;

create table public.chat_report_outbox (
  report_id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_session on delete cascade,
  case_id uuid not null references public.chat_session on delete cascade,
  event text not null check (event in ('l2','l3','important_update','warning','correction','case_end')),
  context_version text not null,
  source_sequence bigint not null,
  payload jsonb not null,
  status text not null check (status in ('pending','sending','retry','delivered','failed','blocked')),
  recipient_email text,
  webhook_url text,
  email_delivered_at timestamptz,
  webhook_delivered_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 6),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  corrects_report_id uuid references public.chat_report_outbox on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (session_id,event,context_version)
);
create index chat_report_due on public.chat_report_outbox(status,next_attempt_at,lease_until);
create index chat_report_case on public.chat_report_outbox(case_id,created_at desc);
comment on table public.chat_report_outbox is 'Immutable filtered report snapshots; SMTP acceptance is delivery to provider, not proof of human receipt. Stable case and report identifiers support downstream deduplication.';
alter table public.chat_report_outbox enable row level security;
revoke all on public.chat_report_outbox from public,anon,authenticated;
grant all on public.chat_report_outbox to service_role;

create function public.chat_enqueue_report(p_session uuid,p_event text,p_email text,p_webhook text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  s public.chat_session%rowtype; r public.chat_report_outbox%rowtype;
  ctx jsonb; transcript jsonb; snapshot jsonb; version text; previous uuid;
  event_name text := lower(trim(p_event));
  email text := nullif(trim(p_email),''); webhook text := nullif(trim(p_webhook),'');
begin
  if event_name not in ('l2','l3','important_update','warning','correction','case_end') then
    raise sqlstate 'PT400' using message='INVALID_CHAT_REPORT_EVENT';
  end if;
  if email is not null and email !~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$' then
    raise sqlstate 'PT400' using message='INVALID_CHAT_REPORT_EMAIL';
  end if;
  if webhook is not null and webhook !~ '^https?://' then
    raise sqlstate 'PT400' using message='INVALID_CHAT_REPORT_WEBHOOK';
  end if;
  select * into s from public.chat_session where session_id=p_session for update;
  if not found then raise sqlstate 'PT404' using message='CHAT_SESSION_NOT_FOUND'; end if;
  -- This field is produced by the verified filter, never by staff notes or raw analysis.
  ctx := coalesce(s.metadata->'filtered_context','{}'::jsonb);
  select coalesce(jsonb_agg(jsonb_build_object(
    'messageId',m.message_id,'sequence',m.sequence,'version',coalesce(m.metadata->>'filter_revision','0'),
    'sender',m.sender,'text',m.text,'moderationStatus',m.moderation_status,'filterVerified',true
  ) order by m.sequence),'[]'::jsonb) into transcript
  from public.chat_message m where m.session_id=p_session
    and m.moderation_status in ('visible','restricted')
    and m.metadata->>'filter_verified'='true';
  snapshot := jsonb_build_object(
    'sessionId',s.session_id,'caseId',s.session_id,'ticketId',s.support_ticket_id,
    'linkedCaseId',s.metadata->>'previous_session_id',
    'linkedHistory',(select jsonb_build_object('caseId',p.session_id,'contextRevision',p.context_revision,
      'handoffStatus',p.handoff_status,'problem',p.metadata->'filtered_context'->>'problem',
      'wanted',p.metadata->'filtered_context'->>'wanted','failedApproaches',p.metadata->'filtered_context'->'failed_approaches',
      'outcome',jsonb_build_object('resolution',p.metadata->'outcome'->>'resolution',
        'finalSentiment',p.metadata->'outcome'->>'finalSentiment','rating',p.metadata->'outcome'->'rating'))
      from public.chat_session p where p.session_id::text=s.metadata->>'previous_session_id'
      and ((s.profile_user_id is not null and p.profile_user_id=s.profile_user_id) or
        (s.profile_user_id is null and s.guest_id is not null and p.guest_id=s.guest_id))),
    'contextRevision',s.context_revision,'sourceSequence',s.next_sequence,
    'risk',s.risk_level,'handoffStatus',s.handoff_status,'active',s.is_active,
    'context',jsonb_build_object('problem',coalesce(ctx->>'problem',''),
      'wanted',coalesce(ctx->>'wanted',''),'failedApproaches',coalesce(ctx->'failed_approaches','[]'::jsonb),
      'sentiment',coalesce(ctx->>'sentiment','neutral'),'sourceSequence',ctx->'source_sequence'),
    'intelligence',jsonb_build_object('confidence',s.metadata->'intelligence'->'confidence',
      'reasons',s.metadata->'intelligence'->'reasons','trend',s.metadata->'intelligence'->>'trend',
      'filterStatus',s.metadata->'intelligence'->>'filter_status','sourceSequence',s.metadata->'intelligence'->'source_seq',
      'corrected',s.metadata->'intelligence'->'corrected','updatedAt',s.metadata->'intelligence'->'updated_at'),
    'ownerVerification',ctx->>'verified_status',
    'summaryVerification',jsonb_build_object('confirmed',s.metadata->'summary_confirmation'->'confirmed',
      'by',s.metadata->'summary_confirmation'->>'by','at',s.metadata->'summary_confirmation'->'at'),
    'verifiedFacts',coalesce((select jsonb_agg(jsonb_build_object('kind',f->>'kind','id',f->>'id',
      'version',f->>'version','approved',f->'approved'))
      from jsonb_array_elements(coalesce(s.metadata->'verified_facts','[]'::jsonb)) f),'[]'::jsonb),
    'currentSuggestion',case when s.metadata->'current_suggestion' is not null then jsonb_build_object(
      'text',s.metadata->'current_suggestion'->>'text','approach',s.metadata->'current_suggestion'->>'approach',
      'sourceIds',s.metadata->'current_suggestion'->'source_ids','sourceSequence',s.metadata->'current_suggestion'->'source_sequence',
      'verifiedAt',s.metadata->'current_suggestion'->'verified_at') else null end,
    'warnings',coalesce((select jsonb_agg(jsonb_build_object('id',w->>'id','text',w->>'text','resolved',w->'resolved'))
      from jsonb_array_elements(coalesce(s.metadata->'warnings','[]'::jsonb)) w),'[]'::jsonb),
    'outcome',case when s.handoff_status='closed' then jsonb_build_object(
      'resolution',s.metadata->'outcome'->>'resolution','finalSentiment',s.metadata->'outcome'->>'finalSentiment',
      'rating',s.metadata->'outcome'->'rating') else null end,
    'pendingMessages',(select count(*) from public.chat_message where session_id=p_session and
      (moderation_status='pending' or metadata->>'filter_verified' is distinct from 'true')),
    'messages',transcript
  );
  version := s.context_revision::text || ':' || md5(snapshot::text);
  if event_name='correction' then
    select report_id into previous from public.chat_report_outbox where session_id=p_session
      and context_version<>version order by created_at desc,report_id desc limit 1;
  end if;
  insert into public.chat_report_outbox(session_id,case_id,event,context_version,source_sequence,payload,
    status,recipient_email,webhook_url,last_error,corrects_report_id)
  values(p_session,p_session,event_name,version,s.next_sequence,
    snapshot || jsonb_build_object('event',event_name,'contextVersion',version,'priority','urgent','correctsReportId',previous),
    case when email is null then 'blocked' else 'pending' end,email,webhook,
    case when email is null then 'CHAT_REPORT_EMAIL is not configured' else null end,previous)
  on conflict(session_id,event,context_version) do nothing returning * into r;
  if r.report_id is null then
    select * into r from public.chat_report_outbox where session_id=p_session and event=event_name and context_version=version;
    if r.status='blocked' and email is not null then
      update public.chat_report_outbox set recipient_email=email,webhook_url=webhook,status='pending',
        next_attempt_at=now(),last_error=null,updated_at=now() where report_id=r.report_id returning * into r;
    end if;
  end if;
  return jsonb_build_object('reportId',r.report_id,'status',r.status,'caseId',r.case_id,'contextVersion',r.context_version);
end; $$;

create function public.chat_claim_reports(p_limit integer default 10)
returns setof public.chat_report_outbox language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  -- A crashed final attempt becomes visible as failed instead of remaining leased forever.
  update public.chat_report_outbox set status='failed',lease_token=null,lease_until=null,
    last_error='Delivery lease expired after final attempt',updated_at=now()
    where status='sending' and lease_until<=now() and attempts>=6;
  return query
  with due as (
    select report_id from public.chat_report_outbox
    where recipient_email is not null and attempts<6 and
      ((status in ('pending','retry') and next_attempt_at<=now()) or (status='sending' and lease_until<=now()))
    order by next_attempt_at,created_at for update skip locked limit greatest(1,least(coalesce(p_limit,10),10))
  ) update public.chat_report_outbox o set status='sending',attempts=o.attempts+1,
      lease_token=gen_random_uuid(),lease_until=now()+interval '120 seconds',updated_at=now()
    from due where o.report_id=due.report_id returning o.*;
end; $$;

create function public.chat_complete_report(p_report uuid,p_lease uuid,p_email_success boolean,p_webhook_success boolean,p_error text)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.chat_report_outbox%rowtype; finished boolean;
begin
  select * into r from public.chat_report_outbox where report_id=p_report for update;
  if not found or r.status<>'sending' or r.lease_token is distinct from p_lease or r.lease_until<=now() then return false; end if;
  if p_email_success and r.email_delivered_at is null then r.email_delivered_at:=now(); end if;
  if p_webhook_success and r.webhook_url is not null and r.webhook_delivered_at is null then r.webhook_delivered_at:=now(); end if;
  finished := r.email_delivered_at is not null and (r.webhook_url is null or r.webhook_delivered_at is not null);
  update public.chat_report_outbox set email_delivered_at=r.email_delivered_at,webhook_delivered_at=r.webhook_delivered_at,
    status=case when finished then 'delivered' when r.attempts>=6 then 'failed' else 'retry' end,
    delivered_at=case when finished then now() else null end,
    next_attempt_at=now()+make_interval(secs=>least(900,15*power(2,r.attempts-1)::integer)),
    last_error=case when finished then null else left(coalesce(p_error,'Provider did not confirm delivery'),500) end,
    lease_token=null,lease_until=null,updated_at=now() where report_id=p_report;
  return true;
end; $$;

create function public.chat_retry_report(p_session uuid,p_report uuid,p_email text,p_webhook text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.chat_report_outbox%rowtype;
  email text:=nullif(trim(p_email),''); webhook text:=nullif(trim(p_webhook),'');
begin
  if email is null or email !~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$' then
    raise sqlstate 'PT400' using message='CHAT_REPORT_EMAIL_REQUIRED'; end if;
  if webhook is not null and webhook !~ '^https?://' then raise sqlstate 'PT400' using message='INVALID_CHAT_REPORT_WEBHOOK'; end if;
  select * into r from public.chat_report_outbox where session_id=p_session and report_id=p_report for update;
  if not found then raise sqlstate 'PT404' using message='CHAT_REPORT_NOT_FOUND'; end if;
  if r.status='delivered' then raise sqlstate 'PT409' using message='CHAT_REPORT_ALREADY_DELIVERED'; end if;
  if r.status='sending' and r.lease_until>now() then raise sqlstate 'PT409' using message='CHAT_REPORT_DELIVERY_IN_PROGRESS'; end if;
  update public.chat_report_outbox set status='pending',attempts=0,next_attempt_at=now(),lease_token=null,lease_until=null,
    recipient_email=email,webhook_url=webhook,
    email_delivered_at=case when recipient_email=email then email_delivered_at else null end,
    webhook_delivered_at=case when webhook_url is not distinct from webhook then webhook_delivered_at else null end,
    last_error=null,updated_at=now() where report_id=p_report returning * into r;
  return jsonb_build_object('reportId',r.report_id,'status',r.status,'caseId',r.case_id,'contextVersion',r.context_version);
end; $$;

-- Bind committed report intents to explicit runtime configuration; no sender/default address is ever used.
create function public.chat_activate_reports(p_email text,p_webhook text)
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare email text:=nullif(trim(p_email),''); webhook text:=nullif(trim(p_webhook),''); changed integer:=0;
begin
  if email is not null then
    if email !~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$' then
      raise sqlstate 'PT400' using message='INVALID_CHAT_REPORT_EMAIL'; end if;
    if webhook is not null and webhook !~ '^https?://' then raise sqlstate 'PT400' using message='INVALID_CHAT_REPORT_WEBHOOK'; end if;
    with blocked as (
      select report_id from public.chat_report_outbox where status='blocked'
      order by created_at for update skip locked limit 100
    ) update public.chat_report_outbox o set recipient_email=email,webhook_url=webhook,status='pending',
      next_attempt_at=now(),last_error=null,updated_at=now() from blocked where o.report_id=blocked.report_id;
    get diagnostics changed=row_count;
  end if;
  -- Repair a status projection skipped during a simultaneous governance transaction, without reversing row lock order.
  with stale as (
    select s.session_id, jsonb_build_object('state',o.status,'report_id',o.report_id,'event',o.event,
      'attempts',o.attempts,'next_attempt_at',o.next_attempt_at,'last_error',o.last_error,'updated_at',o.updated_at) as projection
    from public.chat_session s join lateral (
      select * from public.chat_report_outbox where session_id=s.session_id order by created_at desc,report_id desc limit 1
    ) o on true
    where s.metadata->'report_status' is distinct from jsonb_build_object('state',o.status,'report_id',o.report_id,'event',o.event,
      'attempts',o.attempts,'next_attempt_at',o.next_attempt_at,'last_error',o.last_error,'updated_at',o.updated_at)
    order by s.session_id for update of s skip locked limit 100
  ) update public.chat_session s set metadata=jsonb_set(coalesce(s.metadata,'{}'::jsonb),'{report_status}',stale.projection)
    from stale where s.session_id=stale.session_id;
  return changed;
end; $$;

create function public.chat_report_sync_status() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  -- Governance locks session then report; delivery must never wait while holding report then session.
  perform 1 from public.chat_session where session_id=new.session_id for update skip locked;
  if not found then return new; end if;
  if not exists(select 1 from public.chat_report_outbox where session_id=new.session_id
    and (created_at,report_id)>(new.created_at,new.report_id)) then
    update public.chat_session set metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{report_status}',jsonb_build_object(
      'state',new.status,'report_id',new.report_id,'event',new.event,'attempts',new.attempts,
      'next_attempt_at',new.next_attempt_at,'last_error',new.last_error,'updated_at',new.updated_at)) where session_id=new.session_id;
  end if;
  return new;
end; $$;
create trigger chat_report_status after insert or update on public.chat_report_outbox
for each row execute function public.chat_report_sync_status();

-- Enqueue within the governance transaction so an API crash between commit and dispatch cannot lose an event.
create function public.chat_report_session_event() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare event_name text;
begin
  if new.context_revision=old.context_revision and new.handoff_status is not distinct from old.handoff_status then return new; end if;
  if new.handoff_status='closed' and (old.handoff_status<>'closed' or new.metadata->'outcome' is distinct from old.metadata->'outcome') then
    event_name:='case_end';
  elsif new.handoff_status='requested' and old.handoff_status in ('ai','closed') then event_name:='l3';
  elsif new.metadata->'intelligence'->>'corrected'='true'
    and new.metadata->'intelligence'->>'corrected' is distinct from old.metadata->'intelligence'->>'corrected' then event_name:='correction';
  elsif new.metadata->'warnings' is distinct from old.metadata->'warnings'
    and exists(select 1 from jsonb_array_elements(coalesce(new.metadata->'warnings','[]'::jsonb)) w where w->>'resolved'='false') then event_name:='warning';
  elsif new.next_sequence<>old.next_sequence then return new; -- BEFORE INSERT: the new message is not queryable yet.
  elsif new.metadata->'current_suggestion' is distinct from old.metadata->'current_suggestion'
    or new.metadata->'verified_facts' is distinct from old.metadata->'verified_facts' then
    select case when m.metadata->>'level'='L2' then 'l2' else 'important_update' end into event_name
      from public.chat_message m where m.session_id=new.session_id and m.sender='bot'
      and m.metadata->>'filter_verified'='true' order by m.sequence desc limit 1;
    event_name:=coalesce(event_name,'important_update');
  else event_name:='important_update';
  end if;
  perform public.chat_enqueue_report(new.session_id,event_name,null,null);
  return new;
end; $$;
create trigger chat_report_session after update on public.chat_session
for each row execute function public.chat_report_session_event();

create function public.chat_report_message_event() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  -- Bot reports are captured after the commit wrapper has persisted verified sources and the current suggestion.
  if new.sender='bot' then return new; end if;
  if new.moderation_status in ('visible','restricted') and new.metadata->>'filter_verified'='true' then
    perform public.chat_enqueue_report(new.session_id,'important_update',null,null);
  end if;
  return new;
end; $$;
create trigger chat_report_message after insert on public.chat_message
for each row execute function public.chat_report_message_event();

do $$ declare fn record; begin
  for fn in select oid::regprocedure as name from pg_proc where pronamespace='public'::regnamespace
    and proname in ('chat_enqueue_report','chat_claim_reports','chat_complete_report','chat_retry_report',
      'chat_activate_reports','chat_report_sync_status','chat_report_session_event','chat_report_message_event') loop
    execute format('revoke all on function %s from public,anon,authenticated',fn.name);
    execute format('grant execute on function %s to service_role',fn.name);
  end loop;
end $$;

-- Read-only release proof shared by the API and TLS-verified migration runner.
-- Catalog metadata only: never expose transcript, recipient, offer or customer rows.
create function public.chat_schema_readiness() returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
with required_columns(check_name,table_name,column_names) as (
  values
    ('governance054','chat_session',array['ai_epoch','next_sequence','ai_failures','issue_counts','risk_level','assigned_to','handoff_status','support_ticket_id']),
    ('governance054','chat_message',array['sequence','moderation_status']),
    ('governance054','guest_tracking_otp',array['scoped_order_id','verified_at']),
    ('governance054','support_ticket',array['chat_session_id']),
    ('governance054','chat_order_grant',array['session_id','order_id','guest_id','challenge_id','verified_at','expires_at']),
    ('governance054','chat_policy_approval',array['policy_id','source_updated_at','approved_by','approved_at','expires_at']),
    ('governance054','chat_moderated_original',array['message_id','session_id','original_text','original_metadata','risk','reason']),
    ('governance054','chat_staff_review',array['review_id','session_id','message_id','actor_id','action','text','classification']),
    ('session056','chat_session',array['context_revision']),
    ('session056','chat_issue_state',array['session_id','issue_key','occurrences','failures','l2_attempts','last_sequence']),
    ('promotions057','promotion',array['recovery_approved','recovery_conditions','recovery_max_offers','recovery_revision','recovery_approved_by','recovery_approved_at']),
    ('promotions057','voucher',array['recovery_approved','recovery_conditions','recovery_max_offers','recovery_revision','recovery_approved_by','recovery_approved_at']),
    ('promotions057','chat_support_offer_claim',array['claim_id','session_id','voucher_id','profile_user_id','guest_phone','voucher_version','promotion_version','voucher_revision','promotion_revision','actor_id','created_at','expires_at']),
    ('reports058','chat_report_outbox',array['report_id','session_id','case_id','event','context_version','source_sequence','payload','status','recipient_email','webhook_url','email_delivered_at','webhook_delivered_at','attempts','next_attempt_at','lease_token','lease_until','last_error','corrects_report_id','created_at','updated_at','delivered_at'])
), required_functions(check_name,signature,execution_role,return_type) as (
  values
    ('governance054','public.chat_append_user_turn(uuid,uuid,uuid,text,jsonb)','service_role','jsonb'),
    ('governance054','public.chat_record_analysis(uuid,uuid,text,jsonb,boolean)','service_role','jsonb'),
    ('governance054','public.chat_commit_ai_turn(uuid,bigint,bigint,jsonb,jsonb)','service_role','jsonb'),
    ('governance054','public.chat_handoff(uuid,uuid,uuid,jsonb,text,boolean)','service_role','jsonb'),
    ('governance054','public.chat_staff_action(uuid,uuid,text,jsonb)','service_role','jsonb'),
    ('governance054','public.chat_grant_order(uuid,uuid,uuid,text,timestamptz,uuid)','service_role','void'),
    ('governance054','public.chat_read_order(uuid,uuid,uuid,uuid)','service_role','jsonb'),
    ('governance054','public.chat_read_moderated_original(uuid,uuid,uuid)','service_role','jsonb'),
    ('governance054','public.chat_approve_policy(uuid,uuid,timestamptz)','service_role','jsonb'),
    ('governance054','public.velura_issue_guest_tracking_otp(text,text,uuid,text,uuid)','service_role','void'),
    ('governance054','public.velura_verify_guest_tracking_otp(uuid,text)','service_role','jsonb'),
    ('session056','public.chat_owner_lifecycle(uuid,uuid,uuid,text,jsonb)','service_role','jsonb'),
    ('session056','public.chat_guard_linked_ticket()','service_role','trigger'),
    ('promotions057','public.chat_list_eligible_support_offers(uuid)','service_role','jsonb'),
    ('promotions057','public.chat_confirm_support_offer(uuid,uuid,uuid)','service_role','jsonb'),
    ('promotions057','public.chat_support_wallet_offer_ids(uuid,text)','service_role','jsonb'),
    ('promotions057','public.admin_save_recovery_promotion(jsonb,uuid)','authenticated','jsonb'),
    ('promotions057','public.admin_save_recovery_voucher(jsonb,uuid)','authenticated','jsonb'),
    ('reports058','public.chat_enqueue_report(uuid,text,text,text)','service_role','jsonb'),
    ('reports058','public.chat_claim_reports(integer)','service_role','chat_report_outbox'),
    ('reports058','public.chat_complete_report(uuid,uuid,boolean,boolean,text)','service_role','boolean'),
    ('reports058','public.chat_retry_report(uuid,uuid,text,text)','service_role','jsonb'),
    ('reports058','public.chat_activate_reports(text,text)','service_role','integer'),
    ('reports058','public.chat_schema_readiness()','service_role','jsonb')
), private_tables(check_name,table_name) as (
  values
    ('governance054','chat_session'),('governance054','chat_message'),
    ('governance054','chat_order_grant'),('governance054','chat_policy_approval'),
    ('governance054','chat_moderated_original'),('governance054','chat_staff_review'),
    ('session056','chat_issue_state'),('promotions057','chat_support_offer_claim'),('reports058','chat_report_outbox')
), assertions(check_name,object_name,ok) as (
  select r.check_name,r.table_name||'.'||col.name,
    exists(select 1 from pg_attribute a where a.attrelid=to_regclass('public.'||r.table_name)
      and a.attname=col.name and a.attnum>0 and not a.attisdropped)
  from required_columns r cross join lateral unnest(r.column_names) col(name)
  union all
  select r.check_name,r.signature,
    case when p.oid is null then false else
      format_type(p.prorettype,null)=r.return_type and
      has_function_privilege(r.execution_role,p.oid,'EXECUTE') and
      not has_function_privilege('anon',p.oid,'EXECUTE') and
      (r.execution_role='authenticated' or not has_function_privilege('authenticated',p.oid,'EXECUTE')) and
      (r.signature<>'public.chat_schema_readiness()' or p.provolatile='s')
    end
  from required_functions r left join pg_proc p on p.oid=to_regprocedure(r.signature)
  union all
  select r.check_name,r.table_name||'.privacy',
    case when c.oid is null then false else c.relrowsecurity and
      has_table_privilege('service_role',c.oid,'SELECT') and
      not has_table_privilege('anon',c.oid,'SELECT') and
      not has_table_privilege('authenticated',c.oid,'SELECT')
    end
  from private_tables r left join pg_class c on c.oid=to_regclass('public.'||r.table_name)
  union all
  select 'governance054','chat_message_session_sequence',
    exists(select 1 from pg_index where indexrelid=to_regclass('public.chat_message_session_sequence') and indisunique and indisvalid)
  union all
  select 'governance054','support_ticket_one_chat_session',
    exists(select 1 from pg_index where indexrelid=to_regclass('public.support_ticket_one_chat_session') and indisunique and indisvalid)
  union all
  select 'session056','pending_moderation_constraint',
    exists(select 1 from pg_constraint where conrelid=to_regclass('public.chat_message')
      and conname='chat_message_moderation_status_check' and convalidated and position('''pending''' in pg_get_constraintdef(oid))>0)
  union all
  select 'session056','pending_original_archive_trigger',
    exists(select 1 from pg_trigger where tgrelid=to_regclass('public.chat_message') and tgname='chat_archive_pending' and tgenabled in ('O','A'))
  union all
  select 'session056','linked_ticket_guard_trigger',
    exists(select 1 from pg_trigger where tgrelid=to_regclass('public.support_ticket') and tgname='chat_guard_linked_ticket' and tgenabled in ('O','A'))
  union all
  select 'governance054','ordered_message_trigger',
    exists(select 1 from pg_trigger where tgrelid=to_regclass('public.chat_message') and tgname='chat_sequence_message' and tgenabled in ('O','A'))
  union all
  select 'promotions057','approved_offer_checkout_trigger',
    exists(select 1 from pg_trigger where tgrelid=to_regclass('public.orders') and tgname='support_offer_checkout' and tgenabled in ('O','A'))
  union all
  select 'reports058',r.trigger_name,
    exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||r.table_name)
      and tgname=r.trigger_name and tgfoid=to_regprocedure(r.signature) and tgenabled in ('O','A'))
  from (values
    ('chat_session','chat_report_session','public.chat_report_session_event()'),
    ('chat_message','chat_report_message','public.chat_report_message_event()'),
    ('chat_report_outbox','chat_report_status','public.chat_report_sync_status()')
  ) r(table_name,trigger_name,signature)
  union all
  select 'reports058','chat_report_dedup',
    exists(select 1 from pg_index i where i.indrelid=to_regclass('public.chat_report_outbox')
      and i.indisunique and i.indisvalid and
      (select array_agg(a.attname::text order by k.position) from unnest(i.indkey) with ordinality k(attnum,position)
        join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum)=array['session_id','event','context_version'])
), grouped as (
  select check_name,bool_and(coalesce(ok,false)) as ok from assertions group by check_name
)
select jsonb_build_object(
  'contract','chatbot-3.1.7',
  'ready',(select bool_and(ok) from grouped),
  'checks',(select jsonb_object_agg(check_name,ok) from grouped),
  'missing',coalesce((select jsonb_agg(object_name order by check_name,object_name) from assertions where not coalesce(ok,false)),'[]'::jsonb)
); $$;
comment on function public.chat_schema_readiness() is 'Read-only service-only metadata proof for chatbot migrations 054, 056, 057 and 058; no private row content.';
revoke all on function public.chat_schema_readiness() from public,anon,authenticated;
grant execute on function public.chat_schema_readiness() to service_role;
notify pgrst,'reload schema';
commit;
