-- 081_admin_erp_logic_fixes.sql
--
-- Ba lỗi nghiệp vụ được audit xác nhận:
--   1. CMS từ chối mọi lần lưu giữ nguyên trạng thái (draft→draft, ...), nên không
--      thể sửa nội dung một bài đã công bố mà không đổi trạng thái.
--   2. Review chỉ duyệt được từ pending; nút "Mở ẩn" (rejected→approved) luôn 422,
--      và p_action_note bị ghi thẳng vào admin_reply công khai (null xoá reply cũ).
--   3. admin_unlock_user bật is_active cho cả tài khoản chưa từng bị khoá
--      (lock_type null, chưa xác thực OTP), cho phép đăng nhập bỏ qua OTP.

-- ---------------------------------------------------------------------------
-- 1. CMS: giữ nguyên trạng thái là thao tác hợp lệ
-- ---------------------------------------------------------------------------
create or replace function public.velura_blog_transition_allowed(p_from text, p_to text)
returns boolean
language sql
stable
as $$
  select case
    when p_from = p_to then true
    when p_from = 'draft' then p_to in ('published', 'archived')
    when p_from = 'published' then p_to in ('draft', 'archived')
    when p_from = 'archived' then p_to = 'draft'
    else false
  end;
$$;

revoke all on function public.velura_blog_transition_allowed(text, text) from public, anon;
grant execute on function public.velura_blog_transition_allowed(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Review: duyệt lại bài đã ẩn, không biến ghi chú nội bộ thành reply công khai
-- ---------------------------------------------------------------------------
create or replace function public.admin_approve_review(
  p_review_id uuid,
  p_expected_version integer default 0,
  p_action_note text default null,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.review%rowtype;
  v_after public.review%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  select * into v_before from public.review where review_id = p_review_id for update;
  if v_before.review_id is null then raise sqlstate 'PT404' using message = 'REVIEW_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text not in ('pending', 'rejected') then
    raise sqlstate 'PT422' using message = 'REVIEW_CANNOT_APPROVE';
  end if;

  update public.review
  set status = 'approved'::review_status,
      -- Chỉ thay reply công khai khi người vận hành thực sự nhập nội dung mới.
      admin_reply = coalesce(nullif(btrim(coalesce(p_action_note, '')), ''), admin_reply),
      rejection_reason = null,
      moderated_by = v_actor.user_id,
      moderated_at = now(),
      is_flagged_urgent = false,
      version = version + 1,
      updated_at = now()
  where review_id = p_review_id and version = p_expected_version
  returning * into v_after;
  if v_after.review_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'reviews', v_actor.user_id, v_actor.admin_role::text, 'update', p_review_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Unlock chỉ áp dụng cho tài khoản đang bị khoá
-- ---------------------------------------------------------------------------
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
  -- Bật is_active cho nó sẽ bỏ qua bước xác minh đăng ký.
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
