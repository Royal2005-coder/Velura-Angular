-- Migration: trả lại ý nghĩa thật cho thao tác "tạm dừng chiến dịch".
--
-- Ba lỗi cùng một gốc, nên sửa chung một lần:
--
-- 1. Bộ lịch ở 025 (`velura_sync_promotion_schedule`, chạy 5 phút/lần) bật lại *mọi*
--    chiến dịch đang tắt mà còn trong hạn và còn ngân sách. Nó không phân biệt được
--    "tắt vì chưa tới ngày" với "tắt vì admin vừa bấm Tạm dừng", vì bảng `promotion`
--    chỉ có mỗi cờ `is_active`. Hệ quả: admin bấm Tạm dừng, năm phút sau chiến dịch tự
--    chạy lại — và bộ lịch bật lại luôn cả voucher con. Nút Tạm dừng trên UI thực tế
--    không có tác dụng.
--
-- 2. Migration 015 từng cho `admin_pause_promotion` tắt kèm voucher con. 027 định nghĩa
--    lại chính hàm đó để chốt quyền RBAC nhưng chép thiếu đoạn cascade, nên từ 027 trở
--    đi tạm dừng chiến dịch không còn tắt voucher của nó nữa.
--
-- 3. Cộng dồn hai lỗi trên với việc `voucher-engine.ts` chỉ xét voucher chứ không xét
--    chiến dịch cha: voucher của một chiến dịch đã tạm dừng vẫn giảm giá được ở checkout.
--    Đây là thất thoát tiền thật, không phải lỗi hiển thị. Chốt ở tầng dữ liệu tại đây;
--    tầng ứng dụng chốt thêm một lớp nữa trong engine.
--
-- Cách phân biệt: thêm `paused_at` / `paused_by`. `paused_at is not null` = người thật
-- đã tắt tay, bộ lịch không được phép bật lại. Bật lại bằng `admin_activate_promotion`
-- sẽ xoá dấu này. Giữ nguyên chữ ký ba tham số của cả hai RPC để không phải đụng tới
-- grant và tầng repository trong cùng một lần đổi.

alter table public.promotion
  add column if not exists paused_at timestamptz,
  add column if not exists paused_by uuid references public.users(user_id);

comment on column public.promotion.paused_at is
  'Thời điểm admin tạm dừng thủ công. Khác null thì bộ lịch không được tự bật lại.';
comment on column public.promotion.paused_by is
  'Admin đã bấm tạm dừng. Xoá khi chiến dịch được kích hoạt lại.';

-- Bộ lịch: giữ nguyên nhánh tắt (hết hạn/chưa tới ngày thì tắt), chỉ thêm điều kiện
-- `paused_at is null` vào nhánh bật, cho cả chiến dịch lẫn voucher con.
create or replace function public.velura_sync_promotion_schedule()
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_activated integer := 0; v_deactivated integer := 0;
begin
  -- Hết hạn hoặc chưa tới ngày mà đang bật thì tắt.
  with stopped as (
    update public.promotion
       set is_active = false, version = coalesce(version, 1) + 1, updated_at = now()
     where is_active = true
       and (now() > end_date or now() < start_date)
    returning promo_id
  )
  select count(*) into v_deactivated from stopped;

  update public.voucher v
     set is_active = false, version = coalesce(v.version, 1) + 1, updated_at = now()
    from public.promotion p
   where v.promo_id = p.promo_id and p.is_active = false and v.is_active = true;

  -- Đã tới ngày, còn ngân sách, đang tắt *và không phải do người tắt* thì bật.
  with started as (
    update public.promotion
       set is_active = true, version = coalesce(version, 1) + 1, updated_at = now()
     where is_active = false
       and paused_at is null
       and now() between start_date and end_date
       and (coalesce(budget_limit, 0) = 0 or coalesce(total_discount_issued, 0) < budget_limit)
    returning promo_id
  )
  select count(*) into v_activated from started;

  update public.voucher v
     set is_active = true, version = coalesce(v.version, 1) + 1, updated_at = now()
    from public.promotion p
   where v.promo_id = p.promo_id and p.is_active = true and v.is_active = false
     and p.paused_at is null
     and now() between v.start_date and v.end_date;

  return jsonb_build_object(
    'activated', v_activated,
    'deactivated', v_deactivated,
    'ran_at', now()
  );
end; $$;

-- Tạm dừng: ghi dấu người tắt + tắt kèm voucher con (khôi phục cascade của 015).
create or replace function public.admin_pause_promotion(
  p_promo_id uuid, p_expected_version integer, p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare v_actor public.users%rowtype; v_before public.promotion%rowtype; v_after public.promotion%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or not v_actor.is_active
     or v_actor.admin_role::text not in ('super_admin', 'admin_operator_gia_km') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  select * into v_before from public.promotion where promo_id = p_promo_id for update;
  if v_before.promo_id is null then raise sqlstate 'PT404' using message = 'PROMOTION_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if not v_before.is_active then raise sqlstate 'PT422' using message = 'NOT_ACTIVE'; end if;

  update public.promotion
     set is_active = false,
         paused_at = now(),
         paused_by = v_actor.user_id,
         version = version + 1,
         updated_at = now()
   where promo_id = p_promo_id and version = p_expected_version
  returning * into v_after;
  if v_after.promo_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  -- Tắt chiến dịch mà để voucher con sống thì khách vẫn giảm giá được ở checkout.
  update public.voucher
     set is_active = false, version = coalesce(version, 1) + 1, updated_at = now()
   where promo_id = p_promo_id and is_active = true;

  perform public.velura_append_module_audit('promotions', v_actor.user_id, v_actor.admin_role::text, 'update', p_promo_id,
    jsonb_build_object('is_active', v_before.is_active, 'version', v_before.version),
    jsonb_build_object('is_active', v_after.is_active, 'version', v_after.version,
                       'paused_at', v_after.paused_at, 'paused_by', v_after.paused_by), p_ip_address);
  return to_jsonb(v_after);
end; $$;

-- Kích hoạt lại: xoá dấu tạm dừng thủ công và bật lại voucher con còn trong hạn.
create or replace function public.admin_activate_promotion(
  p_promo_id uuid, p_expected_version integer, p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare v_actor public.users%rowtype; v_before public.promotion%rowtype; v_after public.promotion%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or not v_actor.is_active
     or v_actor.admin_role::text not in ('super_admin', 'admin_operator_gia_km') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  select * into v_before from public.promotion where promo_id = p_promo_id for update;
  if v_before.promo_id is null then raise sqlstate 'PT404' using message = 'PROMOTION_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.is_active then raise sqlstate 'PT422' using message = 'ALREADY_ACTIVE'; end if;
  if now() < v_before.start_date or now() > v_before.end_date then raise sqlstate 'PT422' using message = 'OUTSIDE_DATE_RANGE'; end if;
  -- Bật lại một chiến dịch đã tiêu hết ngân sách thì bộ đếm ở 025 sẽ tắt nó ngay lần
  -- dùng mã kế tiếp. Nói thẳng lý do còn hơn để admin bấm rồi tự tắt sau vài phút.
  if coalesce(v_before.budget_limit, 0) > 0
     and coalesce(v_before.total_discount_issued, 0) >= v_before.budget_limit then
    raise sqlstate 'PT422' using message = 'BUDGET_EXHAUSTED';
  end if;

  update public.promotion
     set is_active = true,
         paused_at = null,
         paused_by = null,
         version = version + 1,
         updated_at = now()
   where promo_id = p_promo_id and version = p_expected_version
  returning * into v_after;
  if v_after.promo_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  -- Đối xứng với nhánh tạm dừng: voucher con còn trong hạn của chính nó thì sống lại.
  update public.voucher
     set is_active = true, version = coalesce(version, 1) + 1, updated_at = now()
   where promo_id = p_promo_id and is_active = false
     and now() between start_date and end_date;

  perform public.velura_append_module_audit('promotions', v_actor.user_id, v_actor.admin_role::text, 'update', p_promo_id,
    jsonb_build_object('is_active', v_before.is_active, 'version', v_before.version,
                       'paused_at', v_before.paused_at),
    jsonb_build_object('is_active', v_after.is_active, 'version', v_after.version), p_ip_address);
  return to_jsonb(v_after);
end; $$;
