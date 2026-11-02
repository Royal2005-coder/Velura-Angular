-- Migration 103: Khuyến mãi theo BA 3.1.14 (AD_PROMO_03, AD_STATS_01/02, AD_VOUCHER_03)
-- Target: public.admin_create_voucher, public.admin_promotion_statistics (chỉ đọc),
--         public.admin_log_voucher_bulk_failure
--
-- 1. Quyền đọc riêng (`velura_require_pricing_reader`): super_admin, admin_operator_gia_km
--    và admin_viewer (trưởng kinh doanh) xem được thống kê. Quyền ghi vẫn chỉ qua
--    `velura_require_pricing_admin` nên viewer không tạo/sửa được gì.
-- 2. `admin_create_voucher` suy trần số mã từ ngân sách chiến dịch chia trần giảm tối đa
--    của mã (làm tròn xuống), kiểm khi đang khoá dòng chiến dịch (như migration 035).
-- 3. RPC ghi nhật ký khi sinh mã hàng loạt thất bại giữa chừng (giữ các mã đã tạo).

create or replace function public.velura_require_pricing_reader()
returns public.users language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or not coalesce(v_actor.is_active, false)
     or v_actor.admin_role::text not in ('super_admin', 'admin_operator_gia_km', 'admin_viewer') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  return v_actor;
end; $$;

revoke all on function public.velura_require_pricing_reader() from public, anon, authenticated;

create or replace function public.admin_promotion_statistics(
  p_from timestamp with time zone default null,
  p_to timestamp with time zone default null
) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_result jsonb;
begin
  perform public.velura_require_pricing_reader();
  if p_from is not null and p_to is not null and p_from >= p_to then
    raise sqlstate 'PT422' using message = 'END_DATE_BEFORE_START_DATE';
  end if;

  with s as (
    -- Mã đã được trả lượt thì coi như đơn không dùng mã. Tiền giảm chỉ tính trên đơn có
    -- mã: dữ liệu cũ có đơn mang `discount_amount` mà không gắn mã nào (đo ngày 25/09:
    -- khoảng 9 triệu), đó không phải tiền khuyến mãi phát qua mã.
    select o.order_id,
           coalesce(o.total_amount, 0) as total_amount,
           case when o.voucher_released_at is null then o.voucher_id end as voucher_id,
           case when o.voucher_released_at is null and o.voucher_id is not null
                then coalesce(o.discount_amount, 0) else 0 end as discount_amount,
           case when o.voucher_released_at is null then v.promo_id end as promo_id,
           case when o.voucher_released_at is null then v.code end as code
      from public.orders o
      left join public.voucher v on v.voucher_id = o.voucher_id
     where o.status::text <> 'cancelled'
       and (p_from is null or o.created_at >= p_from)
       and (p_to is null or o.created_at < p_to)
  ),
  overall as (
    select jsonb_build_object(
      'orders', count(*),
      'voucher_orders', count(voucher_id),
      'revenue_with_voucher', coalesce(sum(total_amount) filter (where voucher_id is not null), 0),
      'revenue_without_voucher', coalesce(sum(total_amount) filter (where voucher_id is null), 0),
      'discount_total', coalesce(sum(discount_amount), 0),
      'aov_with_voucher', coalesce(round(avg(total_amount) filter (where voucher_id is not null)), 0),
      'aov_without_voucher', coalesce(round(avg(total_amount) filter (where voucher_id is null)), 0)
    ) as data from s
  ),
  -- Mọi chiến dịch đều có dòng, kể cả chiến dịch chưa có đơn nào: bảng so sánh phải cho
  -- thấy chiến dịch không hiệu quả chứ không giấu nó đi. Mã đứng riêng gom một dòng.
  campaign_rows as (
    select jsonb_build_object(
      'promo_id', p.promo_id,
      'promo_name', p.promo_name,
      'start_date', p.start_date,
      'end_date', p.end_date,
      'is_active', p.is_active,
      'paused_at', p.paused_at,
      'budget_limit', coalesce(p.budget_limit, 0),
      'total_discount_issued', coalesce(p.total_discount_issued, 0),
      'vouchers', (select count(*) from public.voucher vv where vv.promo_id = p.promo_id),
      'orders', count(s.order_id),
      'revenue', coalesce(sum(s.total_amount), 0),
      'discount', coalesce(sum(s.discount_amount), 0)
    ) as data
    from public.promotion p
    left join s on s.promo_id = p.promo_id
    group by p.promo_id
    union all
    select jsonb_build_object(
      'promo_id', null,
      'promo_name', null,
      'vouchers', (select count(*) from public.voucher vv where vv.promo_id is null),
      'orders', count(s.order_id),
      'revenue', coalesce(sum(s.total_amount), 0),
      'discount', coalesce(sum(s.discount_amount), 0)
    )
    from s
    where s.voucher_id is not null and s.promo_id is null
  ),
  top_rows as (
    select jsonb_build_object(
      'voucher_id', voucher_id,
      'code', max(code),
      'orders', count(*),
      'discount', sum(discount_amount),
      'revenue', sum(total_amount)
    ) as data, count(*) as n, sum(discount_amount) as d
    from s
    where voucher_id is not null
    group by voucher_id
    order by count(*) desc, sum(discount_amount) desc
    limit 10
  ),
  voucher_counts as (
    select jsonb_build_object(
      'total', count(*),
      'active', count(*) filter (where is_active and now() >= start_date and now() < end_date),
      'scheduled', count(*) filter (where is_active and now() < start_date),
      'expired', count(*) filter (where now() >= end_date),
      'disabled', count(*) filter (where not is_active and now() < end_date),
      'total_used', coalesce(sum(used_count), 0),
      'total_limit', coalesce(sum(usage_limit_total), 0),
      'unlimited', count(*) filter (where usage_limit_total is null)
    ) as data from public.voucher
  )
  select jsonb_build_object(
    'overall', (select data from overall),
    'campaigns', coalesce((select jsonb_agg(data order by (data->>'revenue')::numeric desc, data->>'promo_name') from campaign_rows), '[]'::jsonb),
    'top_vouchers', coalesce((select jsonb_agg(data order by n desc, d desc) from top_rows), '[]'::jsonb),
    'vouchers', (select data from voucher_counts)
  ) into v_result;

  return v_result;
end; $$;

revoke all on function public.admin_promotion_statistics(timestamp with time zone, timestamp with time zone)
  from public, anon;
grant execute on function public.admin_promotion_statistics(timestamp with time zone, timestamp with time zone)
  to authenticated, service_role;

create or replace function public.admin_create_voucher(
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
  v_cap numeric;
  v_budget_max integer;
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
    -- AD_PROMO_03: số mã tối đa suy ra từ ngân sách chia trần giảm tối đa của một mã
    -- (làm tròn xuống). Mã phần trăm không có trần thì không quy đổi được nên bị chặn.
    if coalesce(v_promotion.budget_limit, 0) > 0 or coalesce(v_promotion.max_vouchers_allowed, 0) > 0 then
      select count(*) into v_issued from public.voucher where promo_id = p_promo_id;
    end if;
    if coalesce(v_promotion.max_vouchers_allowed, 0) > 0 and v_issued >= v_promotion.max_vouchers_allowed then
      raise sqlstate 'PT422' using message = 'VOUCHER_LIMIT_REACHED';
    end if;
    if coalesce(v_promotion.budget_limit, 0) > 0 then
      v_cap := case v_disc_type::text
        when 'fixed_amount' then
          case when coalesce(p_max_discount_amount, 0) > 0
               then least(p_discount_value, p_max_discount_amount) else p_discount_value end
        when 'percentage' then nullif(p_max_discount_amount, 0)
        -- Phí vận chuyển nhanh 50.000đ là mức giảm tối đa của mã miễn phí ship không đặt trần.
        else coalesce(nullif(p_max_discount_amount, 0), 50000)
      end;
      if v_cap is null or v_cap <= 0 then
        raise sqlstate 'PT422' using message = 'VOUCHER_CAP_REQUIRED';
      end if;
      v_budget_max := floor(v_promotion.budget_limit / v_cap);
      if v_issued >= v_budget_max then
        raise sqlstate 'PT422' using message = 'VOUCHER_BUDGET_REACHED';
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

create or replace function public.admin_log_voucher_bulk_failure(
  p_promo_id uuid,
  p_prefix text,
  p_requested integer,
  p_created integer,
  p_last_code text,
  p_reason text,
  p_ip_address text default null
) returns void language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
begin
  v_actor := public.velura_require_pricing_admin();
  -- audit_action chỉ có create/update; sự kiện thất bại nằm trong new_value.
  perform public.velura_append_module_audit(
    'vouchers', v_actor.user_id, v_actor.admin_role::text, 'create', p_promo_id,
    null,
    jsonb_build_object('event', 'bulk_generate_failed', 'prefix', p_prefix, 'requested', p_requested,
                       'created', p_created, 'last_code', p_last_code, 'reason', p_reason),
    p_ip_address
  );
end; $$;

revoke all on function public.admin_log_voucher_bulk_failure(uuid, text, integer, integer, text, text, text) from public, anon;
grant execute on function public.admin_log_voucher_bulk_failure(uuid, text, integer, integer, text, text, text)
  to authenticated, service_role;

notify pgrst, 'reload schema';
