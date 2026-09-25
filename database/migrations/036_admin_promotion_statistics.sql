-- Migration: Thống kê khuyến mãi đọc từ đơn hàng thật
-- Target tables: public.orders, public.voucher, public.promotion (chỉ đọc)
--
-- Tab Thống kê trước đây đếm dòng `promotion` và `voucher`, cắt ở 500 dòng, và coi mọi
-- chiến dịch `is_active = false` là "tạm dừng" — gộp cả chiến dịch đã hết hạn, chưa tới
-- ngày và cạn ngân sách vào một số. Không con số nào nói mã giảm giá đã mang lại bao
-- nhiêu đơn hay bao nhiêu doanh thu.
--
-- Vai trò giá và khuyến mãi (`admin_operator_gia_km`) không đọc được `orders` qua RLS,
-- và cũng không nên: bảng đó có tên, số điện thoại, địa chỉ của khách. Hàm này trả về
-- con số tổng hợp, không trả về dòng đơn nào, nên cấp cho vai trò đó là đủ an toàn.
--
-- Đơn được tính: chưa huỷ. Đơn có mã mà lượt mã đã được trả lại (`voucher_released_at`,
-- migration 034) cũng không tính, vì ưu đãi đó thực tế không được dùng — ví dụ đơn
-- Stripe bỏ ngang.

create or replace function public.admin_promotion_statistics(
  p_from timestamp with time zone default null,
  p_to timestamp with time zone default null
) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_result jsonb;
begin
  perform public.velura_require_pricing_admin();
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

notify pgrst, 'reload schema';
