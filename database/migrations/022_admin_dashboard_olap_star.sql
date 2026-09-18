-- Analytics star schema for the admin business dashboard.
-- Operational KPIs stay on OLTP; economic KPIs are queried from Dim/Fact.

create schema if not exists analytics;

create table if not exists analytics.dim_date (
  date_key integer primary key,
  full_date date not null unique,
  year integer not null,
  month integer not null,
  day integer not null,
  iso_week integer not null,
  day_name text not null,
  is_weekend boolean not null
);

create table if not exists analytics.dim_product (
  product_key uuid primary key,
  sku text,
  product_name text not null,
  category_id uuid,
  category_name text
);

create table if not exists analytics.dim_customer (
  customer_key uuid primary key,
  full_name text,
  email text,
  created_at timestamp
);

create table if not exists analytics.dim_channel (
  channel_key text primary key,
  payment_method text not null,
  ai_source text not null default 'none'
);

create table if not exists analytics.dim_status (
  status_key text primary key,
  status_name text not null
);

create table if not exists analytics.fact_order (
  order_id uuid primary key,
  date_key integer not null references analytics.dim_date (date_key),
  customer_key uuid not null references analytics.dim_customer (customer_key),
  channel_key text not null references analytics.dim_channel (channel_key),
  status_key text not null references analytics.dim_status (status_key),
  is_promo boolean not null,
  is_valid boolean not null,
  is_completed boolean not null,
  item_count integer not null,
  discount_amount numeric not null,
  shipping_fee numeric not null,
  revenue numeric not null,
  created_at timestamp not null
);

create table if not exists analytics.fact_order_item (
  item_id uuid primary key,
  order_id uuid not null references analytics.fact_order (order_id),
  date_key integer not null references analytics.dim_date (date_key),
  product_key uuid not null references analytics.dim_product (product_key),
  customer_key uuid not null,
  quantity integer not null,
  unit_price numeric not null,
  revenue numeric not null,
  is_valid boolean not null
);

create table if not exists analytics.etl_watermark (
  pipeline_name text primary key,
  refreshed_at timestamptz not null,
  order_count integer not null default 0
);

create index if not exists ix_fact_order_date on analytics.fact_order (date_key);
create index if not exists ix_fact_order_status on analytics.fact_order (status_key, is_valid);
create index if not exists ix_fact_order_item_product_date on analytics.fact_order_item (product_key, date_key);

revoke all on schema analytics from public;
grant usage on schema analytics to service_role;
grant all on all tables in schema analytics to service_role;
alter default privileges in schema analytics grant all on tables to service_role;

create or replace function public.refresh_analytics_star(
  p_max_age interval default interval '5 minutes'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  last_at timestamptz;
  loaded_orders integer := 0;
begin
  select w.refreshed_at
    into last_at
  from analytics.etl_watermark w
  where w.pipeline_name = 'star';

  if last_at is not null and last_at > clock_timestamp() - p_max_age then
    return jsonb_build_object(
      'skipped', true,
      'refreshedAt', last_at
    );
  end if;

  insert into analytics.dim_date (
    date_key, full_date, year, month, day, iso_week, day_name, is_weekend
  )
  select
    to_char(d::date, 'YYYYMMDD')::integer,
    d::date,
    extract(year from d)::integer,
    extract(month from d)::integer,
    extract(day from d)::integer,
    extract(week from d)::integer,
    trim(to_char(d, 'FMDay')),
    extract(isodow from d) >= 6
  from generate_series(date '2020-01-01', date '2035-12-31', interval '1 day') as d
  on conflict (date_key) do nothing;

  insert into analytics.dim_status (status_key, status_name)
  select distinct o.status::text, o.status::text
  from public.orders o
  on conflict (status_key) do nothing;

  insert into analytics.dim_channel (channel_key, payment_method, ai_source)
  select distinct
    coalesce(o.payment_method::text, 'unknown') || '|' || coalesce(o.ai_source::text, 'none'),
    coalesce(o.payment_method::text, 'unknown'),
    coalesce(o.ai_source::text, 'none')
  from public.orders o
  on conflict (channel_key) do nothing;

  insert into analytics.dim_product (product_key, sku, product_name, category_id, category_name)
  select
    pr.product_id,
    pr.sku,
    pr.name,
    pr.category_id,
    c.name
  from public.product pr
  left join public.category c on c.category_id = pr.category_id
  on conflict (product_key) do update
    set sku = excluded.sku,
        product_name = excluded.product_name,
        category_id = excluded.category_id,
        category_name = excluded.category_name;

  insert into analytics.dim_customer (customer_key, full_name, email, created_at)
  select
    o.user_id,
    coalesce(u.full_name, 'Unknown'),
    u.email,
    u.created_at
  from public.orders o
  left join public.users u on u.user_id = o.user_id
  on conflict (customer_key) do update
    set full_name = excluded.full_name,
        email = excluded.email,
        created_at = excluded.created_at;

  truncate analytics.fact_order_item, analytics.fact_order;

  insert into analytics.fact_order (
    order_id, date_key, customer_key, channel_key, status_key,
    is_promo, is_valid, is_completed, item_count, discount_amount,
    shipping_fee, revenue, created_at
  )
  select
    o.order_id,
    to_char(o.created_at::date, 'YYYYMMDD')::integer,
    o.user_id,
    coalesce(o.payment_method::text, 'unknown') || '|' || coalesce(o.ai_source::text, 'none'),
    o.status::text,
    (o.voucher_id is not null or o.discount_amount > 0),
    o.status::text not in ('cancelled', 'returned'),
    o.status::text in ('delivered', 'completed'),
    coalesce((select count(*)::integer from public.order_item oi where oi.order_id = o.order_id), 0),
    coalesce(o.discount_amount, 0),
    coalesce(o.shipping_fee, 0),
    coalesce(o.total_amount, 0),
    o.created_at
  from public.orders o
  join analytics.dim_date dd on dd.date_key = to_char(o.created_at::date, 'YYYYMMDD')::integer
  join analytics.dim_customer dc on dc.customer_key = o.user_id
  join analytics.dim_channel ch
    on ch.channel_key = coalesce(o.payment_method::text, 'unknown') || '|' || coalesce(o.ai_source::text, 'none')
  join analytics.dim_status st on st.status_key = o.status::text;

  get diagnostics loaded_orders = row_count;

  insert into analytics.fact_order_item (
    item_id, order_id, date_key, product_key, customer_key,
    quantity, unit_price, revenue, is_valid
  )
  select
    oi.item_id,
    oi.order_id,
    f.date_key,
    v.product_id,
    f.customer_key,
    oi.quantity,
    oi.unit_price,
    coalesce(oi.subtotal_item, 0),
    f.is_valid
  from public.order_item oi
  join analytics.fact_order f on f.order_id = oi.order_id
  join public.variant v on v.variant_id = oi.variant_id
  join analytics.dim_product dp on dp.product_key = v.product_id;

  insert into analytics.etl_watermark (pipeline_name, refreshed_at, order_count)
  values ('star', clock_timestamp(), loaded_orders)
  on conflict (pipeline_name) do update
    set refreshed_at = excluded.refreshed_at,
        order_count = excluded.order_count;

  return jsonb_build_object(
    'skipped', false,
    'refreshedAt', clock_timestamp(),
    'orderCount', loaded_orders
  );
end;
$function$;

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
  where f.date_key >= par.from_key
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
  where f.date_key >= par.previous_from_key
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
    coalesce(sum(si.revenue) filter (where si.is_valid), 0)::numeric as revenue
  from scoped_items si
  join analytics.dim_product p on p.product_key = si.product_key
  group by p.product_key, p.sku, p.product_name, p.category_id
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

revoke all on function public.refresh_analytics_star(interval) from public, anon, authenticated;
grant execute on function public.refresh_analytics_star(interval) to service_role;
revoke all on function public.get_admin_olap_summary(timestamptz, timestamptz, uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_admin_olap_summary(timestamptz, timestamptz, uuid, uuid) to service_role;
