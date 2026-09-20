-- Migration: tách "tài khoản bị khoá" khỏi "tài khoản chưa xác minh OTP".
--
-- Bảng `users` dùng chung một cờ `is_active` cho hai tình huống hoàn toàn khác nhau:
--
--   * Đăng ký xong nhưng chưa nhập OTP  → `is_active = false`, `lock_type = null`
--     (xem `apps/api/src/user/auth.ts`, nhánh signup ghi thẳng `is_active: false`).
--   * Bị admin khoá                      → `is_active = false`, `lock_type` có giá trị.
--
-- Hai RPC khoá/mở khoá ở 001 chỉ đọc `is_active`, nên:
--
-- 1. **Lỗ xác thực.** `admin_unlock_user` chạy được trên một tài khoản mới đăng ký còn
--    dở OTP và đặt `is_active = true`. Người đó vào thẳng hệ thống mà chưa bao giờ
--    chứng minh sở hữu email/số điện thoại. Super admin không cố ý bỏ qua xác thực —
--    họ chỉ thấy tài khoản nằm trong tab "Bị khoá" và bấm mở khoá.
-- 2. **Không khoá được kẻ spam.** Cũng vì lẫn lộn đó, `admin_lock_user` từ chối với
--    `ACCOUNT_ALREADY_LOCKED` khi gặp tài khoản chưa xác minh — đúng nhóm tài khoản
--    hay cần chặn nhất.
--
-- Chuẩn lại: điều kiện khoá/mở khoá đọc `lock_type`, không đọc `is_active`. Mở khoá một
-- tài khoản chưa xác minh giờ báo `ACCOUNT_NOT_LOCKED` để admin biết phải xử lý bằng
-- luồng xác minh chứ không phải luồng khoá.

create or replace function public.admin_lock_user(
  p_target_user_id uuid,
  p_lock_type text,
  p_reason text,
  p_expected_version integer,
  p_locked_until timestamptz default null,
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
  v_active_super_admins integer;
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

  if p_lock_type not in ('temporary', 'permanent') then
    raise sqlstate 'PT422' using message = 'INVALID_LOCK_TYPE';
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
  -- Đã khoá thật sự thì mới là "đã khoá". Tài khoản chưa xác minh vẫn khoá được.
  if v_before.lock_type is not null then
    raise sqlstate 'PT409' using message = 'ACCOUNT_ALREADY_LOCKED';
  end if;

  if v_before.role::text = 'admin' and v_before.admin_role::text = 'super_admin' then
    select count(*) into v_active_super_admins
    from public.users
    where role::text = 'admin'
      and admin_role::text = 'super_admin'
      and is_active;
    if v_active_super_admins <= 1 then
      raise sqlstate 'PT409' using message = 'LAST_SUPER_ADMIN';
    end if;
  end if;

  update public.users
  set is_active = false,
      lock_type = p_lock_type,
      lock_reason = btrim(p_reason),
      unlock_reason = null,
      locked_by = v_actor.user_id,
      locked_at = now(),
      locked_until = case when p_lock_type = 'temporary' then p_locked_until else null end,
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
    'lock',
    v_after.user_id,
    public.velura_safe_user(v_before),
    public.velura_safe_user(v_after),
    p_ip_address
  );
  perform public.velura_enqueue_account_email(
    v_after.email,
    'account_locked',
    'Tai khoan Velura da bi khoa',
    format('Tai khoan cua ban da bi khoa. Ly do: %s', btrim(p_reason)),
    v_after.user_id
  );

  return public.velura_safe_user(v_after);
end;
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
  -- Không có `lock_type` nghĩa là tài khoản không bị khoá, chỉ đang chờ xác minh OTP.
  -- Mở khoá ở đây sẽ kích hoạt tài khoản mà bỏ qua bước xác thực danh tính.
  if v_before.lock_type is null then
    raise sqlstate 'PT409' using message = 'ACCOUNT_NOT_LOCKED';
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
    'Tai khoan Velura da duoc mo khoa',
    format('Tai khoan cua ban da duoc mo khoa. Ly do: %s', btrim(p_reason)),
    v_after.user_id
  );

  return public.velura_safe_user(v_after);
end;
$$;
