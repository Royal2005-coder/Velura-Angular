-- Migration: Deactivate/activate vouchers linked to a promotion campaign when the campaign is paused/activated
-- Target Table: public.voucher

create or replace function public.admin_activate_promotion(
  p_promo_id uuid, p_expected_version integer, p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare v_actor public.users%rowtype; v_before public.promotion%rowtype; v_after public.promotion%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  select * into v_before from public.promotion where promo_id = p_promo_id for update;
  if v_before.promo_id is null then raise sqlstate 'PT404' using message = 'PROMOTION_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.is_active then raise sqlstate 'PT422' using message = 'ALREADY_ACTIVE'; end if;
  if now() < v_before.start_date or now() > v_before.end_date then raise sqlstate 'PT422' using message = 'OUTSIDE_DATE_RANGE'; end if;
  update public.promotion set is_active = true, version = version + 1, updated_at = now()
  where promo_id = p_promo_id and version = p_expected_version returning * into v_after;
  if v_after.promo_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  
  -- Also activate all vouchers linked to this campaign
  update public.voucher set is_active = true, version = version + 1, updated_at = now()
  where promo_id = p_promo_id;
  
  perform public.velura_append_module_audit('promotions', v_actor.user_id, v_actor.admin_role::text, 'update', p_promo_id,
    jsonb_build_object('is_active', v_before.is_active, 'version', v_before.version),
    jsonb_build_object('is_active', v_after.is_active, 'version', v_after.version), p_ip_address);
  return to_jsonb(v_after);
end; $$;

create or replace function public.admin_pause_promotion(
  p_promo_id uuid, p_expected_version integer, p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare v_actor public.users%rowtype; v_before public.promotion%rowtype; v_after public.promotion%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  select * into v_before from public.promotion where promo_id = p_promo_id for update;
  if v_before.promo_id is null then raise sqlstate 'PT404' using message = 'PROMOTION_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if not v_before.is_active then raise sqlstate 'PT422' using message = 'NOT_ACTIVE'; end if;
  update public.promotion set is_active = false, version = version + 1, updated_at = now()
  where promo_id = p_promo_id and version = p_expected_version returning * into v_after;
  if v_after.promo_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  
  -- Also deactivate all vouchers linked to this campaign
  update public.voucher set is_active = false, version = version + 1, updated_at = now()
  where promo_id = p_promo_id;
  
  perform public.velura_append_module_audit('promotions', v_actor.user_id, v_actor.admin_role::text, 'update', p_promo_id,
    jsonb_build_object('is_active', v_before.is_active, 'version', v_before.version),
    jsonb_build_object('is_active', v_after.is_active, 'version', v_after.version), p_ip_address);
  return to_jsonb(v_after);
end; $$;
