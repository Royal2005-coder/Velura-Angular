-- Canonical, period-aware dashboard aggregation.
-- All business dates are interpreted in Vietnam time because the legacy
-- transactional columns are timestamp without time zone.

create or replace function public.get_admin_dashboard_summary(
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
with
params as (
  select
    (p_from at time zone 'Asia/Ho_Chi_Minh') as from_local,
    (p_to at time zone 'Asia/Ho_Chi_Minh') as to_local,
    ((p_from - (p_to - p_from)) at time zone 'Asia/Ho_Chi_Minh') as previous_from_local,
    (p_from at time zone 'Asia/Ho_Chi_Minh') as previous_to_local
),
current_orders as (
  select o.*
  from public.orders o, params p
  where o.created_at >= p.from_local and o.created_at < p.to_local
),
previous_orders as (
  select o.*
  from public.orders o, params p
  where o.created_at >= p.previous_from_local and o.created_at < p.previous_to_local
),
current_metrics as (
  select
    count(*)::integer as order_count,
    count(*) filter (where status::text not in ('cancelled', 'returned'))::integer as valid_order_count,
    coalesce(sum(total_amount) filter (where status::text not in ('cancelled', 'returned')), 0)::numeric as revenue,
    coalesce(avg(total_amount) filter (where status::text not in ('cancelled', 'returned')), 0)::numeric as aov,
    coalesce(
      100.0 * count(*) filter (where status::text in ('delivered', 'completed')) /
      nullif(count(*), 0),
      0
    )::numeric as completion_rate,
    count(*) filter (where (voucher_id is not null or discount_amount > 0) and status::text not in ('cancelled', 'returned'))::integer as promo_orders,
    coalesce(sum(discount_amount) filter (where status::text not in ('cancelled', 'returned')), 0)::numeric as total_discount,
    coalesce(sum(total_amount) filter (where (voucher_id is not null or discount_amount > 0) and status::text not in ('cancelled', 'returned')), 0)::numeric as promo_revenue,
    coalesce(avg(total_amount) filter (where (voucher_id is not null or discount_amount > 0) and status::text not in ('cancelled', 'returned')), 0)::numeric as promo_aov,
    coalesce(avg(total_amount) filter (where voucher_id is null and discount_amount = 0 and status::text not in ('cancelled', 'returned')), 0)::numeric as regular_aov
  from current_orders
),
previous_metrics as (
  select
    count(*)::integer as order_count,
    coalesce(sum(total_amount) filter (where status::text not in ('cancelled', 'returned')), 0)::numeric as revenue,
    coalesce(avg(total_amount) filter (where status::text not in ('cancelled', 'returned')), 0)::numeric as aov,
    coalesce(
      100.0 * count(*) filter (where status::text in ('delivered', 'completed')) /
      nullif(count(*), 0),
      0
    )::numeric as completion_rate,
    coalesce(sum(total_amount) filter (where (voucher_id is not null or discount_amount > 0) and status::text not in ('cancelled', 'returned')), 0)::numeric as promo_revenue
  from previous_orders
),
scoped_items as (
  select oi.*, o.created_at as order_created_at
  from public.order_item oi
  join current_orders o on o.order_id = oi.order_id
  where o.status::text not in ('cancelled', 'returned')
),
product_sales as (
  select
    pr.product_id,
    pr.sku,
    pr.name,
    pr.category_id,
    sum(si.quantity)::integer as qty,
    coalesce(sum(si.subtotal_item), 0)::numeric as revenue
  from scoped_items si
  join public.variant v on v.variant_id = si.variant_id
  join public.product pr on pr.product_id = v.product_id
  group by pr.product_id, pr.sku, pr.name, pr.category_id
),
product_stock as (
  select
    v.product_id,
    sum(v.stock_quantity)::integer as stock,
    sum(v.low_stock_threshold)::integer as threshold
  from public.variant v
  group by v.product_id
),
best_sellers as (
  select jsonb_agg(
    jsonb_build_object(
      'product_id', ranked.product_id,
      'sku', ranked.sku,
      'name', ranked.name,
      'qty', ranked.qty,
      'revenue', ranked.revenue,
      'stockQuantity', ranked.stock,
      'stockThreshold', ranked.threshold,
      'stockStatus', case
        when ranked.stock <= 0 then 'Hết hàng'
        when ranked.stock <= ranked.threshold then 'Sắp hết'
        else 'Còn hàng'
      end,
      'statusClass', case
        when ranked.stock <= 0 then 'danger'
        when ranked.stock <= ranked.threshold then 'warning'
        else 'success'
      end
    ) order by ranked.revenue desc
  ) as data
  from (
    select ps.*, coalesce(st.stock, 0) as stock, coalesce(st.threshold, 0) as threshold
    from product_sales ps
    left join product_stock st on st.product_id = ps.product_id
    order by ps.revenue desc
    limit 5
  ) ranked
),
category_totals as (
  select c.category_id, c.name, coalesce(sum(ps.revenue), 0)::numeric as revenue
  from product_sales ps
  join public.category c on c.category_id = ps.category_id
  group by c.category_id, c.name
),
category_contributions as (
  select jsonb_agg(
    jsonb_build_object(
      'name', ranked.name,
      'revenue', ranked.revenue,
      'pct', round(100.0 * ranked.revenue / nullif(ranked.total_revenue, 0), 1)
    ) order by ranked.revenue desc
  ) as data
  from (
    select ct.*, sum(ct.revenue) over () as total_revenue
    from category_totals ct
    order by ct.revenue desc
    limit 6
  ) ranked
),
campaign_attributed_orders as (
  select
    o.order_id,
    o.total_amount,
    coalesce(
      v.promo_id,
      (select si.applied_promo_id from scoped_items si where si.order_id = o.order_id and si.applied_promo_id is not null order by si.applied_promo_id::text limit 1)
    ) as promo_id
  from current_orders o
  left join public.voucher v on v.voucher_id = o.voucher_id
  where o.status::text not in ('cancelled', 'returned')
),
campaign_sales as (
  select
    p.promo_id,
    p.promo_name,
    coalesce(sum(ao.total_amount), 0)::numeric as revenue
  from campaign_attributed_orders ao
  join public.promotion p on p.promo_id = ao.promo_id
  group by p.promo_id, p.promo_name
),
best_campaign as (
  select promo_name, revenue
  from campaign_sales
  order by revenue desc, promo_name
  limit 1
),
voucher_usage as (
  select v.code, count(*)::integer as uses
  from current_orders o
  join public.voucher v on v.voucher_id = o.voucher_id
  where o.status::text not in ('cancelled', 'returned')
  group by v.voucher_id, v.code
  order by uses desc, v.code
  limit 1
),
budget_usage as (
  select
    p.promo_name,
    p.budget_limit,
    p.total_discount_issued,
    case when coalesce(p.budget_limit, 0) > 0
      then round(100.0 * p.total_discount_issued / p.budget_limit, 1)
      else 0 end as usage_pct
  from public.promotion p
  where p.is_active and coalesce(p.budget_limit, 0) > 0
  order by usage_pct desc, p.promo_name
  limit 1
),
new_customer_voucher as (
  select
    v.code,
    v.used_count,
    v.usage_limit_total,
    case when coalesce(v.usage_limit_total, 0) > 0
      then round(100.0 * v.used_count / v.usage_limit_total, 1)
      else null end as usage_pct
  from public.voucher v
  where v.applicable_user_group::text = 'new_user'
  order by v.used_count desc, v.code
  limit 1
),
operations as (
  select
    (select count(*)::integer from public.orders where status::text = 'pending') as pending_orders,
    (select count(distinct o.order_id)::integer
      from public.orders o
      join public.payment pay on pay.order_id = o.order_id
      where pay.payment_status::text in ('failed', 'discrepancy') or coalesce(pay.has_discrepancy, false)
    ) as payment_errors,
    (select count(*)::integer from public.return_exchange where status::text = 'pending') as open_returns,
    (select count(*)::integer
      from public.return_exchange
      where status::text = 'pending' and created_at <= (now() at time zone 'Asia/Ho_Chi_Minh') - interval '42 hours'
    ) as returns_due_soon,
    (select count(*)::integer from public.support_ticket where status::text not in ('resolved', 'closed')) as open_support_tickets,
    (select count(distinct product_id)::integer from public.variant where stock_quantity <= low_stock_threshold) as low_stock_products,
    (select count(*)::integer from public.review where status::text = 'pending') as pending_reviews,
    (select count(*)::integer from public.review where rating <= 2) as urgent_reviews
),
daily_series as (
  select generate_series(
    (select from_local::date from params),
    (select (to_local - interval '1 microsecond')::date from params),
    interval '1 day'
  )::date as business_date
),
daily_totals as (
  select
    ds.business_date,
    coalesce(sum(o.total_amount) filter (where o.status::text not in ('cancelled', 'returned')), 0)::numeric as revenue,
    count(o.order_id)::integer as order_count
  from daily_series ds
  left join current_orders o on o.created_at::date = ds.business_date
  group by ds.business_date
),
revenue_trend as (
  select jsonb_agg(
    jsonb_build_object(
      'date', to_char(business_date, 'YYYY-MM-DD'),
      'dateStr', to_char(business_date, 'DD/MM'),
      'revenue', revenue,
      'orderCount', order_count
    ) order by business_date
  ) as data
  from daily_totals
),
peak_day as (
  select
    business_date,
    revenue,
    lag(revenue) over (order by business_date) as previous_day_revenue
  from daily_totals
  order by revenue desc, business_date desc
  limit 1
),
recent_logs as (
  select jsonb_agg(
    jsonb_build_object(
      'audit_id', x.audit_id,
      'actor_id', x.actor_id,
      'actor_name', coalesce(u.full_name, 'Hệ thống'),
      'actor_role', x.actor_role,
      'action', x.action,
      'module', x.module,
      'target_id', x.target_id,
      'timestamp', x.timestamp
    ) order by x.timestamp desc
  ) as data
  from (
    select * from public.audit_log order by timestamp desc limit 8
  ) x
  left join public.users u on u.user_id = x.actor_id
)
select jsonb_build_object(
  'meta', jsonb_build_object(
    'generatedAt', now(),
    'timezone', 'Asia/Ho_Chi_Minh',
    'from', p_from,
    'toExclusive', p_to,
    'previousFrom', p_from - (p_to - p_from),
    'previousToExclusive', p_from,
    'source', 'Supabase PostgreSQL',
    'definitions', jsonb_build_object(
      'revenue', 'Tổng giá trị đơn không bị hủy/hoàn trong kỳ',
      'averageOrderValue', 'Doanh thu chia số đơn hợp lệ',
      'completionRate', 'Đơn đã giao hoặc hoàn tất chia tổng số đơn trong kỳ',
      'promotionRevenue', 'Doanh thu đơn hợp lệ có voucher hoặc giảm giá'
    )
  ),
  'operations', jsonb_build_object(
    'pendingOrders', op.pending_orders,
    'paymentErrors', op.payment_errors,
    'openReturns', op.open_returns,
    'returnsDueSoon', op.returns_due_soon,
    'openSupportTickets', op.open_support_tickets,
    'lowStockProducts', op.low_stock_products,
    'urgentReviews', op.urgent_reviews
  ),
  'business', jsonb_build_object(
    'orderCount', cm.order_count,
    'validOrderCount', cm.valid_order_count,
    'revenue', round(cm.revenue),
    'averageOrderValue', round(cm.aov),
    'completionRate', round(cm.completion_rate, 1),
    'promotionRevenue', round(cm.promo_revenue),
    'promotionRevenueShare', case when cm.revenue > 0 then round(100.0 * cm.promo_revenue / cm.revenue, 1) else 0 end,
    'pendingReviews', op.pending_reviews,
    'promoOrdersCount', cm.promo_orders,
    'totalDiscount', round(cm.total_discount),
    'mostUsedVoucher', coalesce(vu.code, 'Không có'),
    'bestCampaign', coalesce(bc.promo_name, 'Không có'),
    'bestCampaignRevenue', coalesce(round(bc.revenue), 0),
    'categoryContributions', coalesce(cc.data, '[]'::jsonb),
    'bestSellers', coalesce(bs.data, '[]'::jsonb),
    'revenueTrend', coalesce(rt.data, '[]'::jsonb),
    'comparisons', jsonb_build_object(
      'revenuePct', case when pm.revenue <> 0 then round(100.0 * (cm.revenue - pm.revenue) / abs(pm.revenue), 1) else null end,
      'orderCountPct', case when pm.order_count <> 0 then round(100.0 * (cm.order_count - pm.order_count)::numeric / pm.order_count, 1) else null end,
      'aovPct', case when pm.aov <> 0 then round(100.0 * (cm.aov - pm.aov) / abs(pm.aov), 1) else null end,
      'completionRatePoints', round(cm.completion_rate - pm.completion_rate, 1),
      'promotionRevenuePct', case when pm.promo_revenue <> 0 then round(100.0 * (cm.promo_revenue - pm.promo_revenue) / abs(pm.promo_revenue), 1) else null end
    ),
    'insights', jsonb_build_object(
      'peakDay', jsonb_build_object(
        'date', pd.business_date,
        'revenue', pd.revenue,
        'changePct', case when pd.previous_day_revenue > 0 then round(100.0 * (pd.revenue - pd.previous_day_revenue) / pd.previous_day_revenue, 1) else null end
      ),
      'promotionAovPct', case when cm.regular_aov > 0 then round(100.0 * (cm.promo_aov - cm.regular_aov) / cm.regular_aov, 1) else null end,
      'lowStockBestSellers', coalesce((select count(*) from product_sales ps join product_stock st on st.product_id = ps.product_id where st.stock <= st.threshold), 0),
      'budget', jsonb_build_object('campaign', bu.promo_name, 'usagePct', bu.usage_pct),
      'newCustomerVoucher', jsonb_build_object('code', ncv.code, 'usagePct', ncv.usage_pct)
    )
  ),
  'recentLogs', coalesce(rl.data, '[]'::jsonb)
)
from current_metrics cm
cross join previous_metrics pm
cross join operations op
left join best_campaign bc on true
left join voucher_usage vu on true
left join budget_usage bu on true
left join new_customer_voucher ncv on true
left join category_contributions cc on true
left join best_sellers bs on true
left join revenue_trend rt on true
left join peak_day pd on true
left join recent_logs rl on true;
$function$;

revoke all on function public.get_admin_dashboard_summary(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.get_admin_dashboard_summary(timestamptz, timestamptz) to service_role;
