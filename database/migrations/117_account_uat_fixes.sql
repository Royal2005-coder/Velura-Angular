-- Migration 117: account UAT fixes (TC_ACC_07/09/14/15).
--
-- 1) Lý do toàn dấu câu ("! ! ! ..." 11 token) đang được tính là 11 từ, nên lọt qua quy tắc
--    "nhiều hơn 10 từ". Chỉ token có chữ/số mới là từ.
-- 2) Mở khóa chỉ reset `failed_login_count` trong khi luồng đăng nhập dùng `login_fail_count`,
--    nên sau khi admin mở khóa, một lần gõ sai vẫn kích hoạt khóa 15 phút ngay.
-- 3) Yêu cầu nâng quyền bị từ chối phải báo cho QUẢN TRỊ VIÊN YÊU CẦU (kèm lý do, tiếng Việt),
--    và lý do phải có trong audit của hành động reject.
-- 4) Yêu cầu hết hạn do job bảo trì cũng phải để lại audit (AD_ACCOUNT_15).

create or replace function public.velura_reason_word_count(p_value text)
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(count(*)::integer, 0)
  from regexp_split_to_table(btrim(coalesce(p_value, '')), E'\\s+') as token
  where regexp_replace(token, '[[:punct:][:space:]]', '', 'g') <> ''
$$;

create or replace function public.admin_unlock_user(
  p_target_user_id uuid,
  p_reason text,
  p_expected_version integer,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.users%rowtype;
  v_after public.users%rowtype;
begin
  select * into v_actor
  from public.users
  where user_id = public.velura_current_user_id();

  if v_actor.user_id is null
     or v_actor.role::text <> 'admin'
     or v_actor.admin_role::text <> 'super_admin'
     or not v_actor.is_active then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if public.velura_reason_word_count(p_reason) <= 10 then
    raise sqlstate 'PT422' using message = 'REASON_MIN_11_WORDS';
  end if;

  select * into v_before
  from public.users
  where user_id = p_target_user_id
  for update;

  if v_before.user_id is null then
    raise sqlstate 'PT404' using message = 'ACCOUNT_NOT_FOUND';
  end if;
  if v_before.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;
  if v_before.is_active then
    raise sqlstate 'PT409' using message = 'ACCOUNT_ALREADY_ACTIVE';
  end if;
  -- lock_type null nghĩa là tài khoản chưa từng bị khoá, thường là chưa xác thực OTP.
  if v_before.lock_type is null then
    raise sqlstate 'PT422' using message = 'ACCOUNT_NOT_LOCKED';
  end if;

  update public.users
  set is_active = true,
      lock_type = null,
      unlock_reason = btrim(p_reason),
      lock_reason = null,
      locked_by = null,
      locked_at = null,
      locked_until = null,
      failed_login_count = 0,
      -- auth-lockout.ts đếm `login_fail_count`; không reset cả hai thì mở khóa không có tác dụng.
      login_fail_count = 0,
      version = version + 1,
      updated_at = now()
  where user_id = p_target_user_id
    and version = p_expected_version
  returning * into v_after;

  if v_after.user_id is null then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;

  perform public.velura_append_audit(
    v_actor.user_id,
    v_actor.admin_role::text,
    'unlock',
    v_after.user_id,
    public.velura_safe_user(v_before),
    public.velura_safe_user(v_after),
    p_ip_address
  );
  perform public.velura_enqueue_account_email(
    v_after.email,
    'account_unlocked',
    'Tài khoản Velura đã được mở khóa',
    format('Tài khoản của bạn đã được mở khóa. Lý do: %s', btrim(p_reason)),
    v_after.user_id
  );

  return public.velura_safe_user(v_after);
end;
$$;

create or replace function public.admin_review_role_request(
  p_request_id uuid,
  p_decision text,
  p_action_note text,
  p_expected_version integer,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_request public.approval_admin_request%rowtype;
  v_target public.users%rowtype;
  v_requester public.users%rowtype;
  v_after public.users%rowtype;
  v_typed public.users%rowtype;
  v_note text := nullif(btrim(coalesce(p_action_note, '')), '');
begin
  select * into v_actor
  from public.users
  where user_id = public.velura_current_user_id();

  if v_actor.user_id is null
     or v_actor.role::text <> 'admin'
     or v_actor.admin_role::text <> 'super_admin'
     or not v_actor.is_active then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if p_decision not in ('approve', 'reject') then
    raise sqlstate 'PT422' using message = 'INVALID_APPROVAL_DECISION';
  end if;
  if p_decision = 'reject' and public.velura_reason_word_count(p_action_note) <= 10 then
    raise sqlstate 'PT422' using message = 'REJECTION_REASON_MIN_11_WORDS';
  end if;

  select * into v_request
  from public.approval_admin_request
  where request_id = p_request_id
  for update;

  if v_request.request_id is null then
    raise sqlstate 'PT404' using message = 'APPROVAL_NOT_FOUND';
  end if;
  if v_request.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;
  if v_request.status::text <> 'pending' then
    raise sqlstate 'PT409' using message = 'APPROVAL_ALREADY_RESOLVED';
  end if;
  if v_actor.user_id in (v_request.requester_id, v_request.target_user_id) then
    raise sqlstate 'PT409' using message = 'APPROVAL_SEPARATION_REQUIRED';
  end if;

  select * into v_target
  from public.users
  where user_id = v_request.target_user_id
  for update;

  if v_target.user_id is null then
    raise sqlstate 'PT404' using message = 'ACCOUNT_NOT_FOUND';
  end if;

  select * into v_requester
  from public.users
  where user_id = v_request.requester_id;

  if now() >= v_request.expires_at then
    update public.approval_admin_request
    set status = 'expired',
        approver_id = v_actor.user_id,
        action_note = 'Expired automatically after 10 days',
        resolved_at = now(),
        version = version + 1
    where request_id = v_request.request_id;

    perform public.velura_append_audit(
      v_actor.user_id,
      v_actor.admin_role::text,
      'update',
      v_target.user_id,
      jsonb_build_object('approval_request', to_jsonb(v_request)),
      jsonb_build_object('status', 'expired'),
      p_ip_address
    );
    return jsonb_build_object('kind', 'expired', 'request_id', v_request.request_id);
  end if;

  if p_decision = 'approve' then
    select * into v_typed
    from jsonb_populate_record(
      null::public.users,
      jsonb_build_object('role', 'admin', 'admin_role', v_request.requested_role)
    );

    update public.users
    set role = v_typed.role,
        admin_role = v_typed.admin_role,
        version = version + 1,
        updated_at = now()
    where user_id = v_target.user_id
      and version = v_target.version
    returning * into v_after;

    if v_after.user_id is null then
      raise sqlstate 'PT409' using message = 'TARGET_VERSION_CONFLICT';
    end if;
  else
    v_after := v_target;
  end if;

  update public.approval_admin_request
  set status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
      approver_id = v_actor.user_id,
      action_note = v_note,
      resolved_at = now(),
      version = version + 1
  where request_id = v_request.request_id;

  perform public.velura_append_audit(
    v_actor.user_id,
    v_actor.admin_role::text,
    p_decision,
    v_target.user_id,
    public.velura_safe_user(v_target),
    jsonb_build_object(
      'account', public.velura_safe_user(v_after),
      'approval_request_id', v_request.request_id,
      'decision', p_decision,
      'reason', v_note
    ),
    p_ip_address
  );

  if p_decision = 'approve' then
    perform public.velura_enqueue_account_email(
      v_target.email,
      'super_admin_approved',
      'Yêu cầu nâng quyền đã được duyệt',
      'Tài khoản của bạn đã được nâng lên Super Admin.',
      v_target.user_id
    );
  end if;
  -- BA 3.1.9.1 / AD_ACCOUNT_14: kết quả (và lý do từ chối) phải đến QUẢN TRỊ VIÊN YÊU CẦU.
  perform public.velura_enqueue_account_email(
    v_requester.email,
    case when p_decision = 'approve' then 'super_admin_approved' else 'super_admin_rejected' end,
    case when p_decision = 'approve' then 'Yêu cầu nâng quyền đã được duyệt' else 'Yêu cầu nâng quyền bị từ chối' end,
    case
      when p_decision = 'approve'
        then format('Yêu cầu nâng quyền cho %s đã được duyệt.', coalesce(v_target.email, v_target.full_name))
      else format('Yêu cầu nâng quyền super admin bị từ chối. Lý do: %s', coalesce(v_note, ''))
    end,
    v_request.requester_id
  );

  return jsonb_build_object(
    'kind', p_decision,
    'request_id', v_request.request_id,
    'account', public.velura_safe_user(v_after)
  );
end;
$$;

create or replace function public.velura_expire_admin_requests()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.approval_admin_request%rowtype;
  v_target public.users%rowtype;
  v_requester public.users%rowtype;
  v_expired integer := 0;
begin
  for v_request in
    select *
    from public.approval_admin_request
    where status::text = 'pending'
      and expires_at <= now()
    for update skip locked
  loop
    update public.approval_admin_request
    set status = 'expired',
        action_note = coalesce(action_note, 'Expired automatically after 10 days'),
        resolved_at = now(),
        version = version + 1
    where request_id = v_request.request_id
      and status::text = 'pending';

    if found then
      select * into v_target
      from public.users
      where user_id = v_request.target_user_id;

      select * into v_requester
      from public.users
      where user_id = v_request.requester_id;

      if v_target.user_id is not null then
        perform public.velura_enqueue_account_email(
          v_target.email,
          'super_admin_request_expired',
          'Yêu cầu nâng quyền đã hết hạn',
          'Yêu cầu nâng quyền super admin đã hết hạn sau 10 ngày. Vai trò tài khoản không thay đổi.',
          v_target.user_id
        );
        -- AD_ACCOUNT_15: job bảo trì cũng là một xử lý yêu cầu nên phải có audit.
        -- Không có actor hệ thống trong enum, nên requester (người tạo yêu cầu) là actor,
        -- và new_value ghi rõ lý do hết hạn.
        if v_requester.user_id is not null then
          perform public.velura_append_audit(
            v_requester.user_id,
            coalesce(v_requester.admin_role::text, 'super_admin'),
            'update',
            v_target.user_id,
            jsonb_build_object('approval_request', to_jsonb(v_request)),
            jsonb_build_object(
              'approval_request_id', v_request.request_id,
              'status', 'expired',
              'reason', 'expired_after_10_days'
            ),
            null
          );
        end if;
      end if;
      v_expired := v_expired + 1;
    end if;
  end loop;
  return v_expired;
end;
$$;

-- 5) Chặn đặt đơn bằng mã của chiến dịch vừa bị Pause. Guard nằm trên bảng orders nên áp cho
--    cả RPC checkout lẫn đường ghi dự phòng, không phụ thuộc việc is_active của voucher đã
--    kịp cascade hay chưa (TC_PROMO_26).
create or replace function public.velura_guard_paused_promotion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_promo public.promotion%rowtype;
begin
  if new.voucher_id is null then
    return new;
  end if;
  select p.* into v_promo
  from public.voucher v
  join public.promotion p on p.promo_id = v.promo_id
  where v.voucher_id = new.voucher_id;
  if v_promo.promo_id is not null and (v_promo.paused_at is not null or not v_promo.is_active) then
    raise sqlstate 'PT409' using message = 'PROMOTION_PAUSED';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_orders_guard_paused_promotion on public.orders;
create trigger trg_orders_guard_paused_promotion
before insert on public.orders
for each row execute function public.velura_guard_paused_promotion();
