-- KAN-32: heal drifted promotion timestamps and gate releases on the atomic quarantine contract.
begin;

-- Databases provisioned before 005 (or from a partial dump) lack these columns while 057/058 RPCs
-- and PostgREST selects already reference them, so every promotion read fails with 400.
alter table public.promotion add column if not exists updated_at timestamptz not null default now();
alter table public.voucher add column if not exists updated_at timestamptz not null default now();

-- Supersede 058's readiness proof: a database can satisfy 054/056/057/058 and still run 056's
-- auto-verifying trigger, which leaves every participant turn without issue_key and makes the bot
-- return FILTER_PENDING forever. The trigger body marker below only exists after 059.
create or replace function public.chat_schema_readiness() returns jsonb
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
    ('promotions057','promotion',array['recovery_approved','recovery_conditions','recovery_max_offers','recovery_revision','recovery_approved_by','recovery_approved_at','updated_at']),
    ('promotions057','voucher',array['recovery_approved','recovery_conditions','recovery_max_offers','recovery_revision','recovery_approved_by','recovery_approved_at','updated_at']),
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
    ('reports058','public.chat_schema_readiness()','service_role','jsonb'),
    ('atomic059','public.chat_commit_ai_turn_governed(uuid,bigint,bigint,jsonb,jsonb)','service_role','jsonb'),
    ('atomic059','public.chat_commit_queued_turn(uuid,bigint,bigint,jsonb)','service_role','jsonb')
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
  union all
  select 'atomic059','participant_quarantine_trigger',
    exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid
      where t.tgrelid=to_regclass('public.chat_message') and t.tgname='chat_sequence_message'
        and t.tgenabled in ('O','A') and p.prosecdef
        and position('pending_original_text' in pg_get_functiondef(p.oid))>0)
), grouped as (
  select check_name,bool_and(coalesce(ok,false)) as ok from assertions group by check_name
)
select jsonb_build_object(
  'contract','chatbot-3.1.7',
  'ready',(select bool_and(ok) from grouped),
  'checks',(select jsonb_object_agg(check_name,ok) from grouped),
  'missing',coalesce((select jsonb_agg(object_name order by check_name,object_name) from assertions where not coalesce(ok,false)),'[]'::jsonb)
); $$;
comment on function public.chat_schema_readiness() is 'Read-only service-only metadata proof for chatbot migrations 054, 056, 057, 058 and 059; no private row content.';
revoke all on function public.chat_schema_readiness() from public,anon,authenticated;
grant execute on function public.chat_schema_readiness() to service_role;
notify pgrst,'reload schema';
commit;
