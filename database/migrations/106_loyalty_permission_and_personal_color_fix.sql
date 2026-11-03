-- Fix 1: Grant execute on admin loyalty RPCs to authenticated role
-- (migrations 087 and 096 revoked from authenticated, but these RPCs use
-- auth.uid() internally → must run as authenticated with admin JWT, not service_role)
grant execute on function public.admin_set_loyalty_spending(boolean, numeric, text, text) to authenticated;
grant execute on function public.admin_adjust_member_points(uuid, integer, text, text, uuid, text) to authenticated;

-- Fix 2: Personal Color profile action must not crash when style_profile row is absent.
-- New users who open the style quiz or personal color page for the first time have no
-- style_profile row yet. Instead of raising STYLE_PROFILE_REQUIRED, return version=0.
create or replace function public.velura_personal_color(
  p_actor uuid, p_auth_actor uuid, p_action text, p_input jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_profile public.style_profile%rowtype;
  v_analysis public.personal_color_analysis%rowtype;
  v_input jsonb;
  v_color jsonb;
  v_status text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if not exists(select 1 from public.users where user_id=p_actor and auth_user_id=p_auth_actor and is_active=true) then raise exception 'ACTOR_MISMATCH'; end if;
  delete from public.personal_color_analysis where user_id=p_actor and expires_at<now()-interval '1 hour';
  select * into v_profile from public.style_profile where user_id=p_actor for update;
  -- For 'profile' action, gracefully return empty when no style_profile exists yet
  if not found then
    if p_action='profile' then
      return jsonb_build_object('version', 0, 'personal_color', null);
    end if;
    raise exception 'STYLE_PROFILE_REQUIRED';
  end if;
  if p_action='profile' then
    return jsonb_build_object('version',v_profile.style_profile_version,'personal_color',v_profile.personal_color);
  elsif p_action='begin' then
    v_input:=p_input->'analysis';
    if (v_input->>'profile_version')::bigint<>v_profile.style_profile_version then raise exception 'COLOR_PROFILE_CONFLICT'; end if;
    if (v_input->>'status')<>'RUNNING' or (v_input->>'expires_at')::timestamptz<=now() or (v_input->>'expires_at')::timestamptz>now()+interval '1 hour' or coalesce(v_input->>'policy_version','')='' then raise exception 'COLOR_INPUT_INVALID'; end if;
    if (select count(*) from public.personal_color_analysis where user_id=p_actor and status='RUNNING' and expires_at>now())>=2 then raise exception 'COLOR_ANALYSIS_LIMIT'; end if;
    insert into public.personal_color_analysis(id,user_id,profile_version,policy_version,status,expires_at)
      values((v_input->>'id')::uuid,p_actor,v_profile.style_profile_version,v_input->>'policy_version','RUNNING',(v_input->>'expires_at')::timestamptz) returning * into v_analysis;
  else
    select * into v_analysis from public.personal_color_analysis where id=(p_input->>'id')::uuid and user_id=p_actor for update;
    if not found then raise exception 'COLOR_ANALYSIS_NOT_FOUND'; end if;
    if v_analysis.expires_at<=now() and v_analysis.status<>'CONFIRMED' then
      update public.personal_color_analysis set status='TIMEOUT',result=null,error='COLOR_EXPIRED' where id=v_analysis.id returning * into v_analysis;
    end if;
    if p_action='confirm' then
      if v_analysis.status<>'SUCCESS' or v_analysis.result is null or v_analysis.expires_at<=now() then raise exception 'COLOR_NOT_CONFIRMABLE'; end if;
      if v_analysis.profile_version<>(p_input->>'version')::bigint or v_profile.style_profile_version<>(p_input->>'version')::bigint then raise exception 'COLOR_PROFILE_CONFLICT'; end if;
      v_color:=v_analysis.result||jsonb_build_object('status','CONFIRMED','analysis_id',v_analysis.id,'confirmed_at',now());
      update public.style_profile set personal_color=v_color,
        skin_tone=case when v_analysis.result->>'season' in ('Spring','Autumn') then 'Warm' else 'Cool' end,
        updated_at=now() where user_id=p_actor returning * into v_profile;
      update public.personal_color_analysis set status='CONFIRMED' where id=v_analysis.id;
      return jsonb_build_object('version',v_profile.style_profile_version,'personal_color',v_color);
    elsif p_action='finish' then
      v_input:=p_input->'patch'; v_status:=v_input->>'status';
      if v_status not in ('SUCCESS','LOW_CONFIDENCE','VALIDATION_FAILED','FAILED','TIMEOUT','CANCELLED') then raise exception 'COLOR_INPUT_INVALID'; end if;
      if v_status in ('SUCCESS','LOW_CONFIDENCE') and (jsonb_typeof(v_input->'result')<>'object' or v_input->'result'->>'policy_version'<>v_analysis.policy_version) then raise exception 'COLOR_OUTPUT_INVALID'; end if;
      if v_analysis.status='RUNNING' or (v_status='CANCELLED' and v_analysis.status in ('SUCCESS','LOW_CONFIDENCE')) then
        update public.personal_color_analysis set status=v_status,result=case when v_status in ('SUCCESS','LOW_CONFIDENCE') then v_input->'result' else null end,error=v_input->>'error' where id=v_analysis.id returning * into v_analysis;
      end if;
    elsif p_action<>'get' then raise exception 'COLOR_ACTION_INVALID';
    end if;
  end if;
  return to_jsonb(v_analysis)-'user_id'-'created_at';
end $$;
revoke all on function public.velura_personal_color(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.velura_personal_color(uuid,uuid,text,jsonb) to service_role;

-- Fix 3: Allow migration runner (postgres role) to execute loyalty backfill
create or replace function public.velura_backfill_loyalty_history()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), current_user) not in ('service_role', 'postgres', 'supabase_admin')
     and current_user not in ('postgres', 'supabase_admin') then
    raise sqlstate 'PT403' using message = 'LOYALTY_SERVER_ONLY';
  end if;
  -- Backfill delivered orders that have no loyalty entry yet
  insert into public.loyalty_ledger(user_id, kind, milli_points, order_id, note)
  select o.user_id, 'order_earn',
         greatest(1, round((o.final_amount - coalesce(o.shipping_fee, 0)) * 50))::bigint,
         o.order_id, 'backfill'
  from public.orders o
  left join public.loyalty_ledger ll on ll.order_id=o.order_id and ll.kind='order_earn'
  where o.status='delivered' and o.payment_status='paid' and ll.ledger_id is null
    and not exists(select 1 from public.orders e where e.exchange_source_order_id=o.order_id)
  on conflict do nothing;
end $$;
