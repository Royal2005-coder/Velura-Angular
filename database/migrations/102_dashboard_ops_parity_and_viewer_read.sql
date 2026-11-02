-- 102: Dashboard operational KPIs count the same population as the screen they link to,
-- and Admin Viewer may read (never write) the drill-down workspaces (BA 3.1.13 tinh huong 4).
--  * pendingOrders    = Orders "Can xu ly" tab: status pending OR has an attention tag.
--  * openReturns      = Returns tab filtered status=REQUESTED (cho duyet).
--  * lowStockProducts = low-stock VARIANTS, same rule as admin_list_low_stock (stock <= threshold).
--  * urgentReviews    = Reviews "Can xu ly gap" tab: unprocessed (pending) AND (flagged urgent OR rating <= 2).
begin;

create or replace function public.get_admin_olap_summary(
  p_from timestamptz,
  p_to timestamptz,
  p_category_id uuid default null,
  p_product_id uuid default null
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
    (p_from at time zone 'Asia/Ho_Chi_Minh') as previous_to_local,
    to_char((p_from at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYYMMDD')::integer as from_key,
    to_char(((p_to at time zone 'Asia/Ho_Chi_Minh')::date - 1), 'YYYYMMDD')::integer as to_key,
    to_char(((p_from - (p_to - p_from)) at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYYMMDD')::integer as previous_from_key,
    to_char(((p_from at time zone 'Asia/Ho_Chi_Minh')::date - 1), 'YYYYMMDD')::integer as previous_to_key
),
scoped_items as (
  select i.*
  from analytics.fact_order_item i
  join analytics.dim_product p on p.product_key = i.product_key
  join params par on true
  where i.date_key >= par.from_key
    and i.date_key <= par.to_key
    and (p_product_id is null or i.product_key = p_product_id)
    and (p_category_id is null or p.category_id = p_category_id)
),
scoped_orders as (
  select f.*
  from analytics.fact_order f
  join params par on true
  where not f.source_deleted and not f.is_replacement and f.date_key >= par.from_key
    and f.date_key <= par.to_key
    and (
      p_product_id is null and p_category_id is null
      or exists (
        select 1 from scoped_items si where si.order_id = f.order_id
      )
    )
),
previous_items as (
  select i.*
  from analytics.fact_order_item i
  join analytics.dim_product p on p.product_key = i.product_key
  join params par on true
  where i.date_key >= par.previous_from_key
    and i.date_key <= par.previous_to_key
    and (p_product_id is null or i.product_key = p_product_id)
    and (p_category_id is null or p.category_id = p_category_id)
),
previous_orders as (
  select f.*
  from analytics.fact_order f
  join params par on true
  where not f.source_deleted and not f.is_replacement and f.date_key >= par.previous_from_key
    and f.date_key <= par.previous_to_key
    and (
      p_product_id is null and p_category_id is null
      or exists (
        select 1 from previous_items si where si.order_id = f.order_id
      )
    )
),
current_metrics as (
  select
    count(*)::integer as order_count,
    count(*) filter (where is_valid)::integer as valid_order_count,
    coalesce(sum(revenue) filter (where is_valid), 0)::numeric as revenue,
    coalesce(avg(revenue) filter (where is_valid), 0)::numeric as aov,
    coalesce(
      100.0 * count(*) filter (where is_completed) / nullif(count(*), 0),
      0
    )::numeric as completion_rate,
    count(*) filter (where is_promo and is_valid)::integer as promo_orders,
    coalesce(sum(discount_amount) filter (where is_valid), 0)::numeric as total_discount,
    coalesce(sum(revenue) filter (where is_promo and is_valid), 0)::numeric as promo_revenue,
    coalesce(avg(revenue) filter (where is_promo and is_valid), 0)::numeric as promo_aov,
    coalesce(avg(revenue) filter (where not is_promo and is_valid), 0)::numeric as regular_aov,
    count(distinct customer_key) filter (where is_valid)::integer as customer_count
  from scoped_orders
),
previous_metrics as (
  select
    count(*)::integer as order_count,
    coalesce(sum(revenue) filter (where is_valid), 0)::numeric as revenue,
    coalesce(avg(revenue) filter (where is_valid), 0)::numeric as aov,
    coalesce(
      100.0 * count(*) filter (where is_completed) / nullif(count(*), 0),
      0
    )::numeric as completion_rate,
    coalesce(sum(revenue) filter (where is_promo and is_valid), 0)::numeric as promo_revenue
  from previous_orders
),
product_sales as (
  select
    p.product_key as product_id,
    p.sku,
    p.product_name as name,
    p.category_id,
    sum(si.quantity) filter (where si.is_valid)::integer as qty,
    coalesce(sum(si.net_revenue) filter (where si.is_valid), 0)::numeric as revenue
  from scoped_items si
  join analytics.dim_product p on p.product_key = si.product_key
  group by p.product_key, p.sku, p.product_name, p.category_id
),
product_stock as (
  select
    v.product_id,
    sum(greatest(0,v.stock_quantity-v.reserved_quantity))::integer as stock,
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
      'sold', ranked.qty,
      'revenue', ranked.revenue,
      'stockQuantity', ranked.stock,
      'stockThreshold', ranked.threshold,
      'lowStock', ranked.stock <= ranked.threshold,
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
  select p.category_id, coalesce(p.category_name, 'Khác') as name, coalesce(sum(ps.revenue), 0)::numeric as revenue
  from product_sales ps
  join analytics.dim_product p on p.product_key = ps.product_id
  group by p.category_id, p.category_name
),
category_contributions as (
  select jsonb_agg(
    jsonb_build_object(
      'category_id', ranked.category_id,
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
    to_char(ds.business_date, 'YYYYMMDD')::integer as date_key,
    coalesce(sum(o.revenue) filter (where o.is_valid), 0)::numeric as revenue,
    count(o.order_id)::integer as order_count
  from daily_series ds
  left join scoped_orders o on o.date_key = to_char(ds.business_date, 'YYYYMMDD')::integer
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
operations as (
  select
    (select count(*)::integer
      from public.orders o
      where o.status::text = 'pending'
        or exists (select 1 from public.admin_order_tags t where t.order_id = o.order_id and t.tags <> '{}'::text[])
    ) as pending_orders,
    (select count(distinct o.order_id)::integer
      from public.orders o
      join public.payment pay on pay.order_id = o.order_id
      where pay.payment_status::text in ('failed', 'discrepancy') or coalesce(pay.has_discrepancy, false)
    ) as payment_errors,
    (select count(*)::integer from public.return_exchange where status::text = 'REQUESTED') as open_returns,
    (select count(*)::integer
      from public.return_exchange
      where status::text in ('REQUESTED','CONTACTING') and contact_due_at <= now()
    ) as returns_due_soon,
    (select count(*)::integer from public.support_ticket where status::text not in ('resolved', 'closed')) as open_support_tickets,
    (select count(*)::integer from public.variant where stock_quantity <= low_stock_threshold) as low_stock_products,
    (select count(*)::integer from public.review where status::text = 'pending') as pending_reviews,
    (select count(*)::integer from public.review where status::text = 'pending' and (is_flagged_urgent or rating <= 2)) as urgent_reviews
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
    'source', 'analytics.star',
    'definitions', jsonb_build_object(
      'revenue', 'Tổng giá trị đơn hợp lệ (không hủy/hoàn) trên fact_order',
      'averageOrderValue', 'Doanh thu chia số đơn hợp lệ',
      'completionRate', 'Đơn delivered/completed chia tổng số đơn trong kỳ',
      'customers', 'Số khách distinct trên fact_order.is_valid trong kỳ',
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
    'customers', cm.customer_count,
    'customerCount', cm.customer_count,
    'revenue', round(cm.revenue),
    'averageOrderValue', round(cm.aov),
    'completionRate', round(cm.completion_rate, 1),
    'promotionRevenue', round(cm.promo_revenue),
    'promotionRevenueShare', case when cm.revenue > 0 then round(100.0 * cm.promo_revenue / cm.revenue, 1) else 0 end,
    'pendingReviews', op.pending_reviews,
    'promoOrdersCount', cm.promo_orders,
    'totalDiscount', round(cm.total_discount),
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
      'lowStockBestSellers', coalesce((select count(*) from product_sales ps join product_stock st on st.product_id = ps.product_id where st.stock <= st.threshold), 0)
    )
  ),
  'recentLogs', coalesce(rl.data, '[]'::jsonb)
)
from current_metrics cm
cross join previous_metrics pm
cross join operations op
left join category_contributions cc on true
left join best_sellers bs on true
left join revenue_trend rt on true
left join peak_day pd on true
left join recent_logs rl on true;
$function$;

revoke all on function public.get_admin_olap_summary(timestamptz, timestamptz, uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_admin_olap_summary(timestamptz, timestamptz, uuid, uuid) to service_role;

-- Admin Viewer read access. SELECT policies/functions only: every mutation path keeps its own
-- operator check (API requirePermission + SECURITY DEFINER RPC role lists), so viewer stays read-only.
create or replace function public.velura_is_order_reader()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from public.users u
    where u.user_id = public.velura_current_user_id()
      and u.role::text = 'admin'
      and u.is_active
      and u.admin_role::text in (
        'super_admin', 'admin_operator_donhang', 'admin_operator_cskh_dt', 'admin_viewer'
      )
  )
$$;
revoke all on function public.velura_is_order_reader() from public, anon;
grant execute on function public.velura_is_order_reader() to authenticated;

drop policy if exists review_owner_or_admin_select on public.review;
create policy review_owner_or_admin_select on public.review for select to authenticated
using (user_id = (select public.velura_current_user_id()) or (select public.velura_has_admin_role(array['super_admin','admin_operator_danhgia_review','admin_viewer'])));

drop policy if exists return_owner_or_admin_select on public.return_exchange;
create policy return_owner_or_admin_select on public.return_exchange for select to authenticated
using (user_id = (select public.velura_current_user_id()) or (select public.velura_has_admin_role(array['super_admin','admin_operator_cskh_dt','admin_operator_donhang','admin_viewer'])));

drop policy if exists support_ticket_owner_or_admin_select on public.support_ticket;
create policy support_ticket_owner_or_admin_select on public.support_ticket for select to authenticated
using (user_id = (select public.velura_current_user_id()) or (select public.velura_has_admin_role(array['super_admin','admin_operator_cskh_dt','admin_viewer'])));

commit;
