-- Migration: cho phép sửa nội dung trình bày của chiến dịch, và chốt quyền cho các RPC khuyến mãi.
--
-- Hai việc trong cùng một lần đổi, vì cùng đụng đúng nhóm hàm A06:
--
-- 1. `admin_update_promotion` chưa nhận các trường mà 026 vừa thêm (mô tả, ảnh banner,
--    nhãn nổi bật, thứ tự, nổi bật) — tạo chiến dịch thì đặt được ảnh và mô tả, nhưng
--    sau đó không sửa lại được. Đáng chú ý: tham số `p_description` đã có sẵn trong chữ
--    ký từ 005 nhưng câu UPDATE không hề dùng tới, nên mô tả im lặng bị bỏ qua.
--    Lần này cũng mở luôn việc dời lịch chạy (start_date/end_date), vì bộ lịch ở 025
--    bật/tắt chiến dịch theo đúng hai mốc đó.
--
-- 2. Năm RPC ghi khuyến mãi/voucher đều `grant execute ... to authenticated` nhưng
--    không hàm nào kiểm tra vai trò người gọi — chúng chỉ đọc người gọi để ghi nhật ký.
--    Hiện tại chưa khai thác được vì hai SPA không giữ khoá Supabase, mọi lệnh ghi đều
--    đi qua API Node và ở đó `requirePricingAdmin` đã chặn. Nhưng chốt nằm ở tầng ứng
--    dụng chứ không ở dữ liệu: PostgREST chỉ cần lộ ra một lần là thành viên thường có
--    thể tự đổi ngân sách chiến dịch. Đặt lại chốt ngay trong hàm.
--
-- Quy ước sửa trường văn bản: bỏ trống tham số (null) = giữ nguyên; truyền chuỗi rỗng
-- = xoá về null. Không có quy ước này thì admin lỡ tải nhầm ảnh banner sẽ không bao giờ
-- gỡ được nó xuống.

-- Chữ ký cũ phải bỏ hẳn: `create or replace` với danh sách tham số khác chỉ tạo thêm
-- một bản nạp chồng, và PostgREST gọi bằng tham số có tên sẽ báo "function is not unique".
drop function if exists public.admin_update_promotion(uuid, integer, varchar, text, jsonb, numeric, text);

create or replace function public.admin_update_promotion(
  p_promo_id uuid,
  p_expected_version integer default 0,
  p_name varchar default null,
  p_description text default null,
  p_applicable_categories jsonb default null,
  p_budget_limit numeric default null,
  p_ip_address text default null,
  p_banner_image_url text default null,
  p_highlight_label varchar default null,
  p_display_order integer default null,
  p_is_featured boolean default null,
  p_start_date timestamptz default null,
  p_end_date timestamptz default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.promotion%rowtype;
  v_after public.promotion%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or not v_actor.is_active then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if v_actor.admin_role::text not in ('super_admin', 'admin_operator_gia_km') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  if p_highlight_label is not null and length(btrim(p_highlight_label)) > 60 then
    raise sqlstate 'PT422' using message = 'HIGHLIGHT_LABEL_TOO_LONG';
  end if;
  if p_display_order is not null and p_display_order < 0 then
    raise sqlstate 'PT422' using message = 'DISPLAY_ORDER_NEGATIVE';
  end if;
  if p_budget_limit is not null and p_budget_limit < 0 then
    raise sqlstate 'PT422' using message = 'BUDGET_LIMIT_NEGATIVE';
  end if;
  -- Ảnh banner đi thẳng vào thuộc tính src phía khách. Chỉ nhận đường dẫn http(s) hoặc
  -- đường dẫn nội bộ; chặn các lược đồ khác ngay tại biên dữ liệu.
  if p_banner_image_url is not null
     and btrim(p_banner_image_url) <> ''
     and btrim(p_banner_image_url) !~* '^(https?://|/)' then
    raise sqlstate 'PT422' using message = 'BANNER_URL_INVALID';
  end if;

  select * into v_before from public.promotion where promo_id = p_promo_id for update;
  if v_before.promo_id is null then raise sqlstate 'PT404' using message = 'PROMOTION_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  -- Ngân sách đã tiêu không rút lại được: hạ trần xuống dưới mức đã phát là tạo ra một
  -- chiến dịch vĩnh viễn vượt ngân sách, và bộ đếm ở 025 sẽ tạm dừng nó ngay lần dùng kế tiếp.
  if p_budget_limit is not null
     and p_budget_limit > 0
     and p_budget_limit < coalesce(v_before.total_discount_issued, 0) then
    raise sqlstate 'PT422' using message = 'BUDGET_BELOW_ISSUED';
  end if;

  if coalesce(p_end_date, v_before.end_date) <= coalesce(p_start_date, v_before.start_date) then
    raise sqlstate 'PT422' using message = 'END_DATE_BEFORE_START_DATE';
  end if;

  update public.promotion
  set promo_name = coalesce(btrim(p_name), promo_name),
      applicable_categories = coalesce(p_applicable_categories, applicable_categories),
      budget_limit = coalesce(p_budget_limit, budget_limit),
      start_date = coalesce(p_start_date, start_date),
      end_date = coalesce(p_end_date, end_date),
      display_order = coalesce(p_display_order, display_order),
      is_featured = coalesce(p_is_featured, is_featured),
      description = case
        when p_description is null then description
        when btrim(p_description) = '' then null
        else btrim(p_description)
      end,
      banner_image_url = case
        when p_banner_image_url is null then banner_image_url
        when btrim(p_banner_image_url) = '' then null
        else btrim(p_banner_image_url)
      end,
      highlight_label = case
        when p_highlight_label is null then highlight_label
        when btrim(p_highlight_label) = '' then null
        else btrim(p_highlight_label)
      end,
      version = version + 1,
      updated_at = now()
  where promo_id = p_promo_id and version = p_expected_version
  returning * into v_after;
  if v_after.promo_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'promotions', v_actor.user_id, v_actor.admin_role::text, 'update', p_promo_id,
    jsonb_build_object(
      'version', v_before.version, 'budget_limit', v_before.budget_limit,
      'start_date', v_before.start_date, 'end_date', v_before.end_date,
      'is_featured', v_before.is_featured, 'banner_image_url', v_before.banner_image_url
    ),
    jsonb_build_object(
      'version', v_after.version, 'budget_limit', v_after.budget_limit,
      'start_date', v_after.start_date, 'end_date', v_after.end_date,
      'is_featured', v_after.is_featured, 'banner_image_url', v_after.banner_image_url
    ),
    p_ip_address
  );

  return to_jsonb(v_after);
end; $$;

-- Ba hàm ghi còn lại: giữ nguyên toàn bộ phần thân đã có ở 005c, chỉ thêm chốt quyền.
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
  update public.promotion set is_active = true, version = version + 1, updated_at = now()
  where promo_id = p_promo_id and version = p_expected_version returning * into v_after;
  if v_after.promo_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
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
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or not v_actor.is_active
     or v_actor.admin_role::text not in ('super_admin', 'admin_operator_gia_km') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  select * into v_before from public.promotion where promo_id = p_promo_id for update;
  if v_before.promo_id is null then raise sqlstate 'PT404' using message = 'PROMOTION_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if not v_before.is_active then raise sqlstate 'PT422' using message = 'NOT_ACTIVE'; end if;
  update public.promotion set is_active = false, version = version + 1, updated_at = now()
  where promo_id = p_promo_id and version = p_expected_version returning * into v_after;
  if v_after.promo_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  perform public.velura_append_module_audit('promotions', v_actor.user_id, v_actor.admin_role::text, 'update', p_promo_id,
    jsonb_build_object('is_active', v_before.is_active, 'version', v_before.version),
    jsonb_build_object('is_active', v_after.is_active, 'version', v_after.version), p_ip_address);
  return to_jsonb(v_after);
end; $$;

create or replace function public.admin_update_voucher(
  p_voucher_id uuid, p_expected_version integer default 0, p_is_active boolean default null,
  p_name varchar default null, p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare v_actor public.users%rowtype; v_before public.voucher%rowtype; v_after public.voucher%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or not v_actor.is_active
     or v_actor.admin_role::text not in ('super_admin', 'admin_operator_gia_km') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  select * into v_before from public.voucher where voucher_id = p_voucher_id for update;
  if v_before.voucher_id is null then raise sqlstate 'PT404' using message = 'VOUCHER_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  update public.voucher set is_active = coalesce(p_is_active, is_active), name = coalesce(btrim(p_name), name),
    version = version + 1, updated_at = now()
  where voucher_id = p_voucher_id and version = p_expected_version returning * into v_after;
  if v_after.voucher_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  perform public.velura_append_module_audit('vouchers', v_actor.user_id, v_actor.admin_role::text, 'update', p_voucher_id,
    jsonb_build_object('version', v_before.version, 'is_active', v_before.is_active),
    jsonb_build_object('version', v_after.version, 'is_active', v_after.is_active), p_ip_address);
  return to_jsonb(v_after);
end; $$;

revoke all on function public.admin_update_promotion(uuid, integer, varchar, text, jsonb, numeric, text, text, varchar, integer, boolean, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_update_promotion(uuid, integer, varchar, text, jsonb, numeric, text, text, varchar, integer, boolean, timestamptz, timestamptz) to authenticated;
