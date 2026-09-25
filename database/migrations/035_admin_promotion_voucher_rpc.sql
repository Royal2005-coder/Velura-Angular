-- Migration: Mọi thao tác tạo và sửa chiến dịch, mã giảm giá đi qua RPC có kiểm vai trò
--            và ghi nhật ký.
-- Target tables: public.promotion, public.voucher
--
-- Bối cảnh, đo trực tiếp trên production ngày 25/09/2026:
--
-- 1. `admin_create_promotion` và `admin_create_voucher` là SECURITY DEFINER, cấp EXECUTE
--    cho `authenticated`, nhưng KHÔNG kiểm vai trò người gọi. Bất kỳ ai cầm JWT
--    `authenticated` của Supabase — gồm mọi tài khoản admin khác vai trò, và khách đăng
--    nhập qua Supabase Auth — đều tự tạo được chiến dịch và mã giảm giá áp cho mọi khách.
--    KAN-53 mục 2 đã yêu cầu chốt quyền ở tầng RPC đúng vì lý do này.
-- 2. API không dùng hai RPC đó: `pricing-repository.ts` ghi thẳng bằng `insertRow` với
--    khoá service-role, nên bỏ qua RLS và không sinh dòng nhật ký nào (vi phạm BR-A4-08).
-- 3. `admin_create_promotion` không nhận 5 trường trình bày của migration 026.
-- 4. `admin_create_voucher` ghi cứng `applicable_user_group = 'all_users'`, bỏ qua đối
--    tượng mã mà migration 032 đã thêm.
-- 5. `admin_update_voucher` chỉ sửa được `is_active` và `name`.
-- 6. Trần `max_vouchers_allowed` được kiểm ở API theo kiểu đọc-rồi-ghi: hai admin bấm
--    cùng lúc vẫn phát được mã vượt trần. Nay khoá dòng chiến dịch khi đếm.
--
-- Chữ ký hàm thay đổi nên phải drop trước khi tạo lại: `create or replace` với danh sách
-- tham số khác chỉ tạo thêm một bản nạp chồng, và PostgREST gọi bằng tham số có tên sẽ
-- báo `function is not unique`.

-- ---------------------------------------------------------------------------
-- Chốt quyền dùng chung
-- ---------------------------------------------------------------------------
create or replace function public.velura_require_pricing_admin()
returns public.users language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or not coalesce(v_actor.is_active, false)
     or v_actor.admin_role::text not in ('super_admin', 'admin_operator_gia_km') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  return v_actor;
end; $$;

revoke all on function public.velura_require_pricing_admin() from public, anon, authenticated;

-- Kiểm mọi phần tử của một mảng danh mục đều tồn tại. Mảng rỗng hoặc null là hợp lệ.
create or replace function public.velura_assert_categories_exist(p_categories jsonb)
returns void language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_missing integer;
begin
  if p_categories is null or jsonb_typeof(p_categories) <> 'array' or jsonb_array_length(p_categories) = 0 then
    if p_categories is not null and jsonb_typeof(p_categories) <> 'array' then
      raise sqlstate 'PT422' using message = 'CATEGORIES_MUST_BE_ARRAY';
    end if;
    return;
  end if;
  select count(*) into v_missing
    from jsonb_array_elements_text(p_categories) as c(id)
   where not exists (select 1 from public.category where category_id::text = c.id);
  if v_missing > 0 then
    raise sqlstate 'PT422' using message = 'CATEGORY_NOT_FOUND';
  end if;
end; $$;

revoke all on function public.velura_assert_categories_exist(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tạo chiến dịch
-- ---------------------------------------------------------------------------
drop function if exists public.admin_create_promotion(
  character varying, timestamp with time zone, timestamp with time zone, text, text, jsonb, numeric, integer, text
);

create function public.admin_create_promotion(
  p_name character varying,
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone,
  p_promo_type text default 'product_discount',
  p_description text default null,
  p_applicable_categories jsonb default null,
  p_budget_limit numeric default 0,
  p_max_vouchers_allowed integer default 0,
  p_banner_image_url text default null,
  p_highlight_label character varying default null,
  p_display_order integer default 0,
  p_is_featured boolean default false,
  p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_new public.promotion%rowtype;
  v_promo_type public.promotion.promo_type%type;
begin
  v_actor := public.velura_require_pricing_admin();

  if p_name is null or length(btrim(p_name)) < 8 then
    raise sqlstate 'PT422' using message = 'NAME_MIN_8_CHARS';
  end if;
  if p_start_date is null or p_end_date is null then
    raise sqlstate 'PT422' using message = 'DATES_REQUIRED';
  end if;
  if p_start_date >= p_end_date then
    raise sqlstate 'PT422' using message = 'END_DATE_BEFORE_START_DATE';
  end if;
  if coalesce(p_budget_limit, 0) < 0 then
    raise sqlstate 'PT422' using message = 'BUDGET_LIMIT_NEGATIVE';
  end if;
  if coalesce(p_max_vouchers_allowed, 0) < 0 then
    raise sqlstate 'PT422' using message = 'MAX_VOUCHERS_NEGATIVE';
  end if;
  if coalesce(p_display_order, 0) < 0 then
    raise sqlstate 'PT422' using message = 'DISPLAY_ORDER_NEGATIVE';
  end if;
  if p_highlight_label is not null and length(p_highlight_label) > 60 then
    raise sqlstate 'PT422' using message = 'HIGHLIGHT_LABEL_TOO_LONG';
  end if;
  if p_banner_image_url is not null and p_banner_image_url <> ''
     and p_banner_image_url !~ '^(https?://|/)' then
    raise sqlstate 'PT422' using message = 'BANNER_URL_INVALID';
  end if;
  perform public.velura_assert_categories_exist(p_applicable_categories);

  select x.promo_type into v_promo_type
  from jsonb_populate_record(null::public.promotion, jsonb_build_object('promo_type', p_promo_type)) x;

  -- Chiến dịch tạo mới luôn ở trạng thái tắt: lưu nhầm thì không có gì lên sóng.
  insert into public.promotion (
    promo_id, promo_name, promo_type, applicable_categories,
    start_date, end_date, is_active, budget_limit,
    max_vouchers_allowed, total_discount_issued, created_by, version,
    description, banner_image_url, highlight_label, display_order, is_featured
  ) values (
    gen_random_uuid(), btrim(p_name), v_promo_type, p_applicable_categories,
    p_start_date, p_end_date, false, coalesce(p_budget_limit, 0),
    coalesce(p_max_vouchers_allowed, 0), 0, v_actor.user_id, 1,
    nullif(btrim(coalesce(p_description, '')), ''),
    nullif(btrim(coalesce(p_banner_image_url, '')), ''),
    nullif(btrim(coalesce(p_highlight_label, '')), ''),
    coalesce(p_display_order, 0),
    coalesce(p_is_featured, false)
  ) returning * into v_new;

  perform public.velura_append_module_audit(
    'promotions', v_actor.user_id, v_actor.admin_role::text, 'create', v_new.promo_id,
    null, to_jsonb(v_new), p_ip_address
  );

  return to_jsonb(v_new);
end; $$;

-- ---------------------------------------------------------------------------
-- Tạo mã giảm giá
-- ---------------------------------------------------------------------------
drop function if exists public.admin_create_voucher(
  character varying, character varying, text, numeric, timestamp with time zone, timestamp with time zone,
  uuid, numeric, numeric, integer, integer, jsonb, text
);

create function public.admin_create_voucher(
  p_code character varying,
  p_name character varying,
  p_discount_type text,
  p_discount_value numeric,
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone,
  p_promo_id uuid default null,
  p_max_discount_amount numeric default null,
  p_min_order_value numeric default 0,
  p_usage_limit_total integer default null,
  p_usage_limit_per_user integer default 1,
  p_applicable_categories jsonb default null,
  p_applicable_user_group text default 'all_users',
  p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_new public.voucher%rowtype;
  v_promotion public.promotion%rowtype;
  v_disc_type public.voucher.discount_type%type;
  v_group public.voucher.applicable_user_group%type;
  v_issued integer;
begin
  v_actor := public.velura_require_pricing_admin();

  if p_code is null or length(btrim(p_code)) = 0 then
    raise sqlstate 'PT422' using message = 'CODE_REQUIRED';
  end if;
  -- Engine so mã không phân biệt hoa thường khi khách gõ tay, nên trùng cũng phải xét
  -- không phân biệt hoa thường.
  if exists (select 1 from public.voucher where upper(code) = upper(btrim(p_code))) then
    raise sqlstate 'PT409' using message = 'VOUCHER_CODE_EXISTS';
  end if;
  if p_start_date is null or p_end_date is null then
    raise sqlstate 'PT422' using message = 'DATES_REQUIRED';
  end if;
  if p_start_date >= p_end_date then
    raise sqlstate 'PT422' using message = 'END_DATE_BEFORE_START_DATE';
  end if;

  select x.discount_type into v_disc_type
  from jsonb_populate_record(null::public.voucher, jsonb_build_object('discount_type', p_discount_type)) x;
  select x.applicable_user_group into v_group
  from jsonb_populate_record(null::public.voucher, jsonb_build_object('applicable_user_group', coalesce(p_applicable_user_group, 'all_users'))) x;

  if v_disc_type::text <> 'free_shipping' and coalesce(p_discount_value, 0) <= 0 then
    raise sqlstate 'PT422' using message = 'DISCOUNT_VALUE_REQUIRED';
  end if;
  if v_disc_type::text = 'percentage' and p_discount_value > 100 then
    raise sqlstate 'PT422' using message = 'PERCENTAGE_OVER_100';
  end if;
  if coalesce(p_min_order_value, 0) < 0 or coalesce(p_max_discount_amount, 0) < 0 then
    raise sqlstate 'PT422' using message = 'AMOUNT_NEGATIVE';
  end if;
  if coalesce(p_usage_limit_per_user, 1) < 1 or (p_usage_limit_total is not null and p_usage_limit_total < 1) then
    raise sqlstate 'PT422' using message = 'USAGE_LIMIT_INVALID';
  end if;
  perform public.velura_assert_categories_exist(p_applicable_categories);

  if p_promo_id is not null then
    -- Khoá dòng chiến dịch khi đếm, để hai admin bấm cùng lúc không cùng vượt trần.
    select * into v_promotion from public.promotion where promo_id = p_promo_id for update;
    if v_promotion.promo_id is null then
      raise sqlstate 'PT404' using message = 'PROMOTION_NOT_FOUND';
    end if;
    if coalesce(v_promotion.max_vouchers_allowed, 0) > 0 then
      select count(*) into v_issued from public.voucher where promo_id = p_promo_id;
      if v_issued >= v_promotion.max_vouchers_allowed then
        raise sqlstate 'PT422' using message = 'VOUCHER_LIMIT_REACHED';
      end if;
    end if;
  end if;

  insert into public.voucher (
    voucher_id, promo_id, code, name, discount_type, discount_value,
    max_discount_amount, min_order_value, usage_limit_total, usage_limit_per_user,
    used_count, applicable_categories, applicable_user_group,
    start_date, end_date, is_active, created_by, version
  ) values (
    gen_random_uuid(), p_promo_id, upper(btrim(p_code)), btrim(coalesce(p_name, p_code)), v_disc_type,
    coalesce(p_discount_value, 0),
    p_max_discount_amount, coalesce(p_min_order_value, 0), p_usage_limit_total, coalesce(p_usage_limit_per_user, 1),
    0, p_applicable_categories, v_group,
    p_start_date, p_end_date, true, v_actor.user_id, 1
  ) returning * into v_new;

  perform public.velura_append_module_audit(
    'vouchers', v_actor.user_id, v_actor.admin_role::text, 'create', v_new.voucher_id,
    null, to_jsonb(v_new), p_ip_address
  );

  return to_jsonb(v_new);
end; $$;

-- ---------------------------------------------------------------------------
-- Sửa mã giảm giá
-- ---------------------------------------------------------------------------
-- Quy ước giữ như migration 027: tham số null là giữ nguyên. Với trường văn bản, chuỗi
-- rỗng là xoá. Ba trường số có nghĩa "không giới hạn" khi null nên có cờ xoá riêng, vì
-- null đã mang nghĩa "giữ nguyên".
drop function if exists public.admin_update_voucher(uuid, integer, boolean, character varying, text);

create function public.admin_update_voucher(
  p_voucher_id uuid,
  p_expected_version integer default 0,
  p_is_active boolean default null,
  p_name character varying default null,
  p_discount_type text default null,
  p_discount_value numeric default null,
  p_max_discount_amount numeric default null,
  p_clear_max_discount boolean default false,
  p_min_order_value numeric default null,
  p_usage_limit_total integer default null,
  p_clear_usage_limit_total boolean default false,
  p_usage_limit_per_user integer default null,
  p_applicable_user_group text default null,
  p_applicable_categories jsonb default null,
  p_start_date timestamp with time zone default null,
  p_end_date timestamp with time zone default null,
  p_promo_id uuid default null,
  p_clear_promo boolean default false,
  p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.voucher%rowtype;
  v_after public.voucher%rowtype;
  v_promotion public.promotion%rowtype;
  v_disc_type public.voucher.discount_type%type;
  v_group public.voucher.applicable_user_group%type;
  v_target_promo uuid;
  v_start timestamp with time zone;
  v_end timestamp with time zone;
  v_issued integer;
begin
  v_actor := public.velura_require_pricing_admin();

  select * into v_before from public.voucher where voucher_id = p_voucher_id for update;
  if v_before.voucher_id is null then raise sqlstate 'PT404' using message = 'VOUCHER_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  v_disc_type := v_before.discount_type;
  if p_discount_type is not null then
    select x.discount_type into v_disc_type
    from jsonb_populate_record(null::public.voucher, jsonb_build_object('discount_type', p_discount_type)) x;
  end if;
  v_group := v_before.applicable_user_group;
  if p_applicable_user_group is not null then
    select x.applicable_user_group into v_group
    from jsonb_populate_record(null::public.voucher, jsonb_build_object('applicable_user_group', p_applicable_user_group)) x;
  end if;

  if v_disc_type::text <> 'free_shipping' and coalesce(p_discount_value, v_before.discount_value, 0) <= 0 then
    raise sqlstate 'PT422' using message = 'DISCOUNT_VALUE_REQUIRED';
  end if;
  if v_disc_type::text = 'percentage' and coalesce(p_discount_value, v_before.discount_value) > 100 then
    raise sqlstate 'PT422' using message = 'PERCENTAGE_OVER_100';
  end if;
  if coalesce(p_min_order_value, 0) < 0 or coalesce(p_max_discount_amount, 0) < 0 then
    raise sqlstate 'PT422' using message = 'AMOUNT_NEGATIVE';
  end if;
  if (p_usage_limit_per_user is not null and p_usage_limit_per_user < 1)
     or (p_usage_limit_total is not null and p_usage_limit_total < 1) then
    raise sqlstate 'PT422' using message = 'USAGE_LIMIT_INVALID';
  end if;
  -- Không hạ tổng lượt xuống dưới số lượt khách đã dùng: mã sẽ hết lượt âm.
  if p_usage_limit_total is not null and p_usage_limit_total < coalesce(v_before.used_count, 0) then
    raise sqlstate 'PT422' using message = 'USAGE_LIMIT_BELOW_USED';
  end if;

  v_start := coalesce(p_start_date, v_before.start_date);
  v_end := coalesce(p_end_date, v_before.end_date);
  if v_start is not null and v_end is not null and v_start >= v_end then
    raise sqlstate 'PT422' using message = 'END_DATE_BEFORE_START_DATE';
  end if;
  if p_applicable_categories is not null then
    perform public.velura_assert_categories_exist(p_applicable_categories);
  end if;

  v_target_promo := case when p_clear_promo then null else coalesce(p_promo_id, v_before.promo_id) end;
  if v_target_promo is not null and v_target_promo is distinct from v_before.promo_id then
    select * into v_promotion from public.promotion where promo_id = v_target_promo for update;
    if v_promotion.promo_id is null then
      raise sqlstate 'PT404' using message = 'PROMOTION_NOT_FOUND';
    end if;
    if coalesce(v_promotion.max_vouchers_allowed, 0) > 0 then
      select count(*) into v_issued from public.voucher where promo_id = v_target_promo;
      if v_issued >= v_promotion.max_vouchers_allowed then
        raise sqlstate 'PT422' using message = 'VOUCHER_LIMIT_REACHED';
      end if;
    end if;
  end if;

  update public.voucher set
    is_active = coalesce(p_is_active, is_active),
    name = coalesce(nullif(btrim(p_name), ''), name),
    discount_type = v_disc_type,
    discount_value = coalesce(p_discount_value, discount_value),
    max_discount_amount = case when p_clear_max_discount then null else coalesce(p_max_discount_amount, max_discount_amount) end,
    min_order_value = coalesce(p_min_order_value, min_order_value),
    usage_limit_total = case when p_clear_usage_limit_total then null else coalesce(p_usage_limit_total, usage_limit_total) end,
    usage_limit_per_user = coalesce(p_usage_limit_per_user, usage_limit_per_user),
    applicable_user_group = v_group,
    applicable_categories = case
      when p_applicable_categories is null then applicable_categories
      when jsonb_typeof(p_applicable_categories) = 'array' and jsonb_array_length(p_applicable_categories) = 0 then null
      else p_applicable_categories end,
    start_date = coalesce(p_start_date, start_date),
    end_date = coalesce(p_end_date, end_date),
    promo_id = v_target_promo,
    version = version + 1,
    updated_at = now()
  where voucher_id = p_voucher_id and version = p_expected_version
  returning * into v_after;
  if v_after.voucher_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit('vouchers', v_actor.user_id, v_actor.admin_role::text, 'update', p_voucher_id,
    to_jsonb(v_before), to_jsonb(v_after), p_ip_address);
  return to_jsonb(v_after);
end; $$;

-- ---------------------------------------------------------------------------
-- Quyền
-- ---------------------------------------------------------------------------
-- Giữ EXECUTE cho `authenticated` vì API gọi bằng JWT của admin để hàm biết ai đang làm
-- (`velura_current_user_id`). Chốt quyền thật nằm trong hàm ở `velura_require_pricing_admin`.
revoke all on function public.admin_create_promotion(
  character varying, timestamp with time zone, timestamp with time zone, text, text, jsonb, numeric, integer,
  text, character varying, integer, boolean, text
) from public, anon;
grant execute on function public.admin_create_promotion(
  character varying, timestamp with time zone, timestamp with time zone, text, text, jsonb, numeric, integer,
  text, character varying, integer, boolean, text
) to authenticated, service_role;

revoke all on function public.admin_create_voucher(
  character varying, character varying, text, numeric, timestamp with time zone, timestamp with time zone,
  uuid, numeric, numeric, integer, integer, jsonb, text, text
) from public, anon;
grant execute on function public.admin_create_voucher(
  character varying, character varying, text, numeric, timestamp with time zone, timestamp with time zone,
  uuid, numeric, numeric, integer, integer, jsonb, text, text
) to authenticated, service_role;

revoke all on function public.admin_update_voucher(
  uuid, integer, boolean, character varying, text, numeric, numeric, boolean, numeric, integer, boolean,
  integer, text, jsonb, timestamp with time zone, timestamp with time zone, uuid, boolean, text
) from public, anon;
grant execute on function public.admin_update_voucher(
  uuid, integer, boolean, character varying, text, numeric, numeric, boolean, numeric, integer, boolean,
  integer, text, jsonb, timestamp with time zone, timestamp with time zone, uuid, boolean, text
) to authenticated, service_role;

-- PostgREST giữ bộ nhớ đệm chữ ký hàm; hàm vừa drop/create phải nạp lại mới gọi được.
notify pgrst, 'reload schema';
