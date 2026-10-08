-- KAN-32: read-only reporting, transactional source events and audited last-good syncs.
begin;
create table analytics.source_event_outbox (
 event_id bigint generated always as identity primary key, source_table text not null,
 source_key text not null, operation text not null check(operation in ('INSERT','UPDATE','DELETE')),
 occurred_at timestamptz not null default clock_timestamp(), processed_at timestamptz
);
create index source_event_pending on analytics.source_event_outbox(event_id) where processed_at is null;
create table analytics.fact_history (
 history_id bigint generated always as identity primary key, fact_table text not null,
 operation text not null, row_snapshot jsonb not null, recorded_at timestamptz not null default clock_timestamp()
);
create table analytics.sync_run (
 run_id uuid primary key default gen_random_uuid(), actor_id uuid not null,
 started_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
 status text not null check(status in ('running','succeeded','failed')), source_event_through bigint,
 previous_snapshot_at timestamptz, snapshot_at timestamptz, reconciliation jsonb, error_code text
);
create table analytics.refresh_guard (actor_id uuid primary key, attempted_at timestamptz not null);
create table analytics.fact_loyalty_event (
 event_id uuid primary key, event_key text not null unique, event_type text not null,
 customer_key uuid not null, order_id uuid, payload jsonb not null, occurred_at timestamptz not null
);
-- Trigger records only source identity, never addresses, chat messages or customer credentials.
create function analytics.capture_source_event() returns trigger language plpgsql security definer set search_path='' as $$
declare v_row jsonb;
begin
 v_row := case when TG_OP='DELETE' then to_jsonb(OLD) else to_jsonb(NEW) end;
 insert into analytics.source_event_outbox(source_table,source_key,operation)
 values(TG_TABLE_NAME,coalesce(v_row->>TG_ARGV[0], 'unknown'),TG_OP);
 return case when TG_OP='DELETE' then OLD else NEW end;
end; $$;
create function analytics.preserve_fact_history() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if TG_OP='DELETE' or to_jsonb(OLD) is distinct from to_jsonb(NEW) then
  insert into analytics.fact_history(fact_table,operation,row_snapshot) values(TG_TABLE_NAME,TG_OP,to_jsonb(OLD));
 end if;
 return case when TG_OP='DELETE' then OLD else NEW end;
end; $$;
do $$ declare v text[]; t text; begin
 foreach v slice 1 in array array[
 ['product','product_id'],['variant','variant_id'],['orders','order_id'],['order_item','item_id'],
 ['payment','payment_id'],['payment_refund','refund_id'],['promotion','promo_id'],['voucher','voucher_id'],
 ['promotion_product','promo_id'],['users','user_id'],['return_exchange','return_id'],['return_item','return_item_id'],
 ['review','review_id'],['support_ticket','ticket_id'],['order_status_history','order_id']
 ] loop
  if to_regclass('public.'||v[1]) is not null then
   execute format('create trigger analytics_source_change after insert or update or delete on public.%I for each row execute function analytics.capture_source_event(%L)',v[1],v[2]);
  end if;
 end loop;
 foreach t in array array['fact_order','fact_order_item','fact_review','fact_support_ticket','fact_return_item',
 'fact_voucher_redemption','fact_promotion_item','fact_refund','dim_product','dim_customer','dim_promotion'] loop
  execute format('create trigger analytics_preserve_history before update or delete on analytics.%I for each row execute function analytics.preserve_fact_history()',t);
 end loop;
end; $$;
-- The v2 upsert rebuild stays intact; only authorized audited refreshes may call it.
alter function public.refresh_analytics_star(interval) rename to refresh_analytics_star_v2;
revoke execute on function public.refresh_analytics_star_v2(interval) from service_role;
create function public.admin_refresh_analytics(p_actor_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_last timestamptz; v_run uuid; v_high bigint; v_result jsonb; v_check jsonb; v_snapshot timestamptz; v_previous timestamptz;
begin
 if not exists(select 1 from public.users where user_id=p_actor_id and role::text='admin'
   and admin_role::text='super_admin' and is_active) then
  raise sqlstate 'PT403' using message='RBAC_DENIED';
 end if;
 if auth.role() <> 'service_role' and public.velura_current_user_id() is distinct from p_actor_id then
  raise sqlstate 'PT403' using message='ACTOR_MISMATCH';
 end if;
 if not pg_try_advisory_xact_lock(hashtextextended('velura.analytics.star',0)) then
  return jsonb_build_object('status','busy','success',false,'retryAfterSeconds',10);
 end if;
 insert into analytics.refresh_guard(actor_id,attempted_at) values(p_actor_id,'-infinity') on conflict do nothing;
 select attempted_at into v_last from analytics.refresh_guard where actor_id=p_actor_id for update;
 if v_last > clock_timestamp()-interval '10 seconds' then
  return jsonb_build_object('status','throttled','success',false,'retryAfterSeconds',10);
 end if;
 update analytics.refresh_guard set attempted_at=clock_timestamp() where actor_id=p_actor_id;
 select refreshed_at into v_snapshot from analytics.etl_watermark where pipeline_name='star';
 v_previous:=v_snapshot;
 select max(event_id) into v_high from analytics.source_event_outbox;
 insert into analytics.sync_run(actor_id,status,source_event_through,previous_snapshot_at)
 values(p_actor_id,'running',v_high,v_snapshot) returning run_id into v_run;
 -- This subtransaction rolls back the entire mart on failure, not the guard or audit record.
 begin
  if exists(select 1 from public.orders where total_amount is null or total_amount<0 or created_at is null)
    or exists(select 1 from public.order_item where quantity<=0 or subtotal_item is null or subtotal_item<0)
    or exists(select 1 from public.review where rating not between 1 and 5)
    or exists(select 1 from public.support_ticket where csat_score is not null and csat_score not between 1 and 5) then
   raise exception 'SOURCE_SCHEMA_INVALID';
  end if;
  v_result:=public.refresh_analytics_star_v2(interval '0 seconds');
  if coalesce((v_result->>'skipped')::boolean,false) then raise exception 'SYNC_SKIPPED'; end if;
  if to_regclass('public.loyalty_event_outbox') is not null then
   execute 'insert into analytics.fact_loyalty_event(event_id,event_key,event_type,customer_key,order_id,payload,occurred_at)
    select event_id,event_key,event_type,member_id,order_id,payload,occurred_at from public.loyalty_event_outbox
    on conflict(event_id) do nothing';
  end if;
  v_check:=jsonb_build_object(
   'sourceOrders',(select count(*) from public.orders),'factOrders',(select count(*) from analytics.fact_order where not source_deleted),
   'sourceLines',(select count(*) from public.order_item),'factLines',(select count(*) from analytics.fact_order_item i where exists(select 1 from public.order_item s where s.item_id=i.item_id)),
   'sourceOrderValue',(select coalesce(sum(total_amount),0) from public.orders),
   'factOrderValue',(select coalesce(sum(revenue),0) from analytics.fact_order where not source_deleted),
   'sourceReviews',(select count(*) from public.review r where exists(select 1 from public.orders o where o.order_id=r.order_id)),
   'factReviews',(select count(*) from analytics.fact_review),
   'sourceTickets',(select count(*) from public.support_ticket),'factTickets',(select count(*) from analytics.fact_support_ticket),
   'sourceVoucherOrders',(select count(*) from public.orders where voucher_id is not null),
   'factVoucherOrders',(select count(*) from analytics.fact_voucher_redemption r join public.orders o on o.order_id=r.order_id and o.voucher_id=r.voucher_id));
  if v_check->'sourceOrders'<>v_check->'factOrders' or v_check->'sourceLines'<>v_check->'factLines'
   or v_check->'sourceOrderValue'<>v_check->'factOrderValue' or v_check->'sourceReviews'<>v_check->'factReviews'
   or v_check->'sourceTickets'<>v_check->'factTickets' or v_check->'sourceVoucherOrders'<>v_check->'factVoucherOrders' then
   raise exception 'RECONCILIATION_FAILED';
  end if;
  select refreshed_at into v_snapshot from analytics.etl_watermark where pipeline_name='star';
  update analytics.source_event_outbox set processed_at=v_snapshot where event_id<=v_high and processed_at is null;
  update analytics.sync_run set status='succeeded',finished_at=clock_timestamp(),snapshot_at=v_snapshot,reconciliation=v_check where run_id=v_run;
 exception when others then
  update analytics.sync_run set status='failed',finished_at=clock_timestamp(),error_code=SQLSTATE,
   reconciliation=jsonb_build_object('reason',case when SQLERRM in ('SOURCE_SCHEMA_INVALID','SYNC_SKIPPED','RECONCILIATION_FAILED') then SQLERRM else 'SYNC_FAILED' end) where run_id=v_run;
  return jsonb_build_object('status','failed','success',false,'runId',v_run,'snapshotAt',v_previous,'errorCode','ANALYTICS_SYNC_FAILED');
 end;
 return jsonb_build_object('status','succeeded','success',true,'runId',v_run,'snapshotAt',v_snapshot,'reconciliation',v_check);
end; $$;
create function public.get_admin_analytics_snapshot(p_from timestamptz,p_to timestamptz,p_category_id uuid default null,p_product_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_at timestamptz; v_summary jsonb; v_facts jsonb; v_run jsonb;
begin
 if p_from>=p_to or p_to-p_from not in (interval '1 day',interval '7 days',interval '30 days') then
  raise sqlstate 'PT400' using message='INVALID_ANALYTICS_PERIOD';
 end if;
 select refreshed_at into v_at from analytics.etl_watermark where pipeline_name='star';
 select to_jsonb(r) into v_run from analytics.sync_run r order by started_at desc limit 1;
 v_summary:=public.get_admin_olap_summary(p_from,p_to,p_category_id,p_product_id);
 if v_at is null then
  -- OLTP fallback is explicitly limited to live operational queues; never financial metrics.
  v_summary:=jsonb_build_object('operations',v_summary->'operations','recentLogs',v_summary->'recentLogs',
   'business',jsonb_build_object('revenue',null,'orderCount',null,'customers',null,'averageOrderValue',null,
    'completionRate',null,'promotionRevenue',null,'promotionRevenueShare',null,'pendingReviews',v_summary#>'{business,pendingReviews}',
    'comparisons','{}'::jsonb,'bestSellers','[]'::jsonb,'categoryContributions','[]'::jsonb,'revenueTrend','[]'::jsonb));
 else
  v_facts:=public.get_admin_management_facts(p_from,p_to,p_category_id,p_product_id);
  if (v_summary#>>'{business,validOrderCount}')::integer=0 then
   v_summary:=jsonb_set(v_summary,'{business,averageOrderValue}','null'::jsonb);
  end if;
  if (v_summary#>>'{business,orderCount}')::integer=0 then
   v_summary:=jsonb_set(v_summary,'{business,completionRate}','null'::jsonb);
  end if;
  if (v_summary#>>'{business,revenue}')::numeric=0 then
   v_summary:=jsonb_set(v_summary,'{business,promotionRevenueShare}','null'::jsonb);
  end if;
  if v_summary#>'{business,comparisons,orderCountPct}'='null'::jsonb then
   v_summary:=jsonb_set(v_summary,'{business,comparisons,completionRatePoints}','null'::jsonb);
  end if;
 end if;
 return jsonb_build_object('schemaVersion',3,'dataset','operational','source','analytics.star.v3',
  'snapshotAt',v_at,'summary',v_summary,'facts',v_facts,'lastSync',v_run,
  'freshness',case when v_at is null then 'unavailable' when v_at<now()-interval '5 minutes' then 'stale' else 'fresh' end,
  'pendingEvents',(select count(*) from analytics.source_event_outbox where processed_at is null),
  'reconciled',exists(select 1 from analytics.sync_run where status='succeeded' and snapshot_at=v_at));
end; $$;
do $$ declare t text; begin
 foreach t in array array['source_event_outbox','fact_history','sync_run','refresh_guard','fact_loyalty_event'] loop
  execute format('alter table analytics.%I enable row level security',t);
  execute format('revoke all on analytics.%I from public, anon, authenticated',t);
  execute format('grant select on analytics.%I to service_role',t);
  execute format('create policy analytics_service_read on analytics.%I for select to service_role using(true)',t);
 end loop;
end; $$;
revoke all on function analytics.capture_source_event(),analytics.preserve_fact_history(),public.admin_refresh_analytics(uuid),
 public.get_admin_analytics_snapshot(timestamptz,timestamptz,uuid,uuid) from public,anon,authenticated;
grant execute on function public.admin_refresh_analytics(uuid),public.get_admin_analytics_snapshot(timestamptz,timestamptz,uuid,uuid) to service_role;
-- The v2 watermark is not v3 reconciliation evidence. An authorized initial sync is required.
commit;
