-- Personal Color is a confirmed field on the existing Style Profile; analyses are expiring work records.
alter table public.style_profile add column if not exists style_profile_version bigint not null default 0;
alter table public.style_profile add column if not exists personal_color jsonb;
alter table public.style_profile add constraint style_profile_personal_color_confirmed check (
  personal_color is null or (personal_color->>'status' = 'CONFIRMED' and personal_color ? 'analysis_id' and personal_color ? 'policy_version')
);

create or replace function public.velura_style_profile_version()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op='INSERT' then new.style_profile_version:=0;
  else new.style_profile_version:=old.style_profile_version+1;
  end if;
  if new.personal_color is not null and (tg_op='INSERT' or new.personal_color is distinct from old.personal_color) and coalesce(auth.role(),'')<>'service_role' then
    raise exception 'PERSONAL_COLOR_CONFIRM_REQUIRED';
  end if;
  return new;
end $$;
create trigger style_profile_version_before_write before insert or update on public.style_profile
for each row execute function public.velura_style_profile_version();

create table public.personal_color_analysis (
  id uuid primary key,
  user_id uuid not null references public.users(user_id) on delete cascade,
  profile_version bigint not null check(profile_version>=0),
  policy_version text not null,
  status text not null check(status in ('RUNNING','SUCCESS','LOW_CONFIDENCE','VALIDATION_FAILED','FAILED','TIMEOUT','CANCELLED','CONFIRMED')),
  result jsonb,
  error text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index personal_color_analysis_owner_expiry on public.personal_color_analysis(user_id,expires_at);
alter table public.personal_color_analysis enable row level security;
revoke all on public.personal_color_analysis from anon,authenticated;

create or replace function public.velura_personal_color(p_actor uuid,p_auth_actor uuid,p_action text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_profile public.style_profile%rowtype;
  v_analysis public.personal_color_analysis%rowtype;
  v_input jsonb;
  v_color jsonb;
  v_status text;
begin
  -- Only the API service may mutate inference records; bind its verified auth identity to the DB business actor.
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if not exists(select 1 from public.users where user_id=p_actor and auth_user_id=p_auth_actor and is_active=true) then raise exception 'ACTOR_MISMATCH'; end if;
  delete from public.personal_color_analysis where user_id=p_actor and expires_at<now()-interval '1 hour';
  select * into v_profile from public.style_profile where user_id=p_actor for update;
  if not found then raise exception 'STYLE_PROFILE_REQUIRED'; end if;
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
      update public.style_profile set personal_color=v_color,updated_at=now() where user_id=p_actor returning * into v_profile;
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
