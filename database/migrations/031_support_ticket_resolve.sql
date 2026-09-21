-- Migration: cho phép CSKH đánh dấu phiếu hỗ trợ đã giải quyết.
--
-- `SUPPORT_TICKET_STATUSES` có `resolved` và giao diện có nhãn "Đã giải quyết", nhưng
-- không đường ghi nào đặt được trạng thái đó: `admin_respond_ticket` đặt `processing`,
-- `admin_close_ticket` đặt `closed`. Hệ quả là một nhãn chết, và CSKH xử lý xong chỉ
-- còn cách đóng thẳng phiếu — mất luôn phần phân biệt giữa "đã giải quyết, chờ khách
-- xác nhận" và "đã đóng hẳn".
--
-- Hàm này viết theo đúng khuôn của `admin_close_ticket` ở 005: khoá dòng, kiểm phiên
-- bản lạc quan, ghi nhật ký cùng một cách. Khác hai điểm: đặt `resolved` thay vì
-- `closed`, và chặn đúng những bước chuyển mà máy trạng thái không cho.
--
-- Tầng ứng dụng cũng chốt lại bảng chuyển trạng thái này, nhưng chốt ở đây là lớp
-- không đi vòng được nếu sau này có đường ghi khác.

create or replace function public.admin_resolve_ticket(
  p_ticket_id uuid,
  p_expected_version integer default 0,
  p_admin_note text default '',
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.support_ticket%rowtype;
  v_after public.support_ticket%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or not v_actor.is_active
     or v_actor.admin_role::text not in ('super_admin', 'admin_operator_cskh_dt') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  select * into v_before from public.support_ticket where ticket_id = p_ticket_id for update;
  if v_before.ticket_id is null then raise sqlstate 'PT404' using message = 'TICKET_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  -- Chỉ phiếu đang xử lý mới kết luận được là đã giải quyết. Phiếu vừa mở chưa ai đụng
  -- tới, còn phiếu đã đóng thì không mở lại bằng đường này.
  if v_before.status::text <> 'processing' then
    raise sqlstate 'PT422' using message = 'INVALID_TRANSITION';
  end if;

  update public.support_ticket
  set status = 'resolved'::public.ticket_status,
      admin_reply = case when btrim(coalesce(p_admin_note, '')) = '' then admin_reply else btrim(p_admin_note) end,
      resolved_at = now(),
      version = version + 1,
      updated_at = now()
  where ticket_id = p_ticket_id and version = p_expected_version
  returning * into v_after;
  if v_after.ticket_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'support_tickets', v_actor.user_id, v_actor.admin_role::text, 'update', p_ticket_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

revoke all on function public.admin_resolve_ticket(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.admin_resolve_ticket(uuid, integer, text, text) to authenticated;
