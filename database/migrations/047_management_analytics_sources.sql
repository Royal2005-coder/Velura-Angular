-- KAN-58: reproducible business evidence at an explicit grain, without destructive refreshes.
-- Existing timestamps without a zone are UTC source values; calendar buckets use Vietnam time.
-- Only the trusted API service can refresh/read the private star. No customer PII is exported.
begin;

-- Self-contained bootstrap: some deployed projects never applied historical migration 022.
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



create or replace function analytics.source_instant(p_value timestamp)
returns timestamptz language sql immutable strict security invoker set search_path = ''
as $$ select p_value at time zone 'UTC' $$;
create or replace function analytics.source_instant(p_value timestamptz)
returns timestamptz language sql immutable strict security invoker set search_path = ''
as $$ select p_value $$;

alter table analytics.dim_customer add column if not exists tier text;
alter table analytics.fact_order alter column customer_key drop not null;
alter table analytics.fact_order add column if not exists ordered_at timestamptz;
alter table analytics.fact_order add column if not exists delivered_at timestamptz;
alter table analytics.fact_order add column if not exists state_entered_at timestamptz;
alter table analytics.fact_order add column if not exists is_guest boolean not null default false;
alter table analytics.fact_order add column if not exists is_replacement boolean not null default false;
alter table analytics.fact_order add column if not exists source_deleted boolean not null default false;
alter table analytics.fact_order_item alter column customer_key drop not null;
alter table analytics.fact_order_item add column if not exists net_revenue numeric;

create table if not exists analytics.dim_promotion (
  promotion_key uuid primary key, name text not null, promotion_type text,
  starts_at timestamptz, ends_at timestamptz
);
create table if not exists analytics.fact_voucher_redemption (
  order_id uuid primary key references analytics.fact_order(order_id),
  voucher_id uuid not null, voucher_code text, promotion_key uuid references analytics.dim_promotion(promotion_key),
  discount_amount numeric not null, associated_order_value numeric not null,
  is_valid boolean not null
);
-- A requested return line is not a received unit. Both facts remain independently inspectable.
create table if not exists analytics.fact_return_item (
  return_item_id uuid primary key, return_id uuid not null,
  order_item_id uuid not null references analytics.fact_order_item(item_id),
  quantity integer not null, return_status text not null, reason text,
  requested_at timestamptz not null, is_active boolean not null, received_quantity integer not null
);
create table if not exists analytics.fact_review (
  review_id uuid primary key, order_id uuid not null references analytics.fact_order(order_id),
  product_key uuid not null references analytics.dim_product(product_key),
  rating integer not null, submitted_at timestamptz not null, status text not null
);
create table if not exists analytics.fact_support_ticket (
  ticket_id uuid primary key, customer_key uuid, status text not null,
  csat_score integer, created_at timestamptz not null, resolved_at timestamptz
);
create table if not exists analytics.fact_refund (
  refund_id uuid primary key, return_id uuid not null, order_id uuid not null references analytics.fact_order(order_id),
  amount numeric not null, status text not null, requested_at timestamptz not null, updated_at timestamptz not null
);
-- Historical list price is unavailable: an applied promotion proves association, not discount uplift.
create table if not exists analytics.fact_promotion_item (
  item_id uuid primary key references analytics.fact_order_item(item_id),
  promotion_key uuid not null references analytics.dim_promotion(promotion_key),
  quantity integer not null, associated_net_item_value numeric not null, is_valid boolean not null
);
create index if not exists ix_management_order_time on analytics.fact_order(ordered_at);
create index if not exists ix_management_customer_time on analytics.fact_order(customer_key, ordered_at) where is_completed and not is_guest;
create index if not exists ix_management_return_line on analytics.fact_return_item(order_item_id, is_active);
create index if not exists ix_management_review_order on analytics.fact_review(order_id, product_key);

create or replace function public.refresh_analytics_star(p_max_age interval default interval '5 minutes')
returns jsonb language plpgsql security invoker set search_path = '' as $etl$
declare
  v_last timestamptz;
  v_refreshed timestamptz;
  v_orders integer;
begin
  -- Serialize writers without making interactive dashboard readers wait on another refresh.
  if not pg_try_advisory_xact_lock(hashtextextended('velura.analytics.star', 0)) then
    select refreshed_at into v_last from analytics.etl_watermark where pipeline_name = 'star';
    return jsonb_build_object('skipped', true, 'busy', true, 'refreshedAt', v_last);
  end if;
  select refreshed_at into v_last from analytics.etl_watermark where pipeline_name = 'star';
  if v_last is not null and v_last > clock_timestamp() - greatest(p_max_age, interval '0 seconds') then
    return jsonb_build_object('skipped', true, 'refreshedAt', v_last);
  end if;

  insert into analytics.dim_date(date_key, full_date, year, month, day, iso_week, day_name, is_weekend)
  select to_char(d, 'YYYYMMDD')::integer, d::date, extract(year from d)::integer,
    extract(month from d)::integer, extract(day from d)::integer, extract(week from d)::integer,
    trim(to_char(d, 'FMDay')), extract(isodow from d) >= 6
  from generate_series(
    least(date '2020-01-01', (select min((analytics.source_instant(created_at) at time zone 'Asia/Ho_Chi_Minh')::date) from public.orders)),
    greatest(current_date + 366, (select max((analytics.source_instant(created_at) at time zone 'Asia/Ho_Chi_Minh')::date) from public.orders)),
    interval '1 day') d
  on conflict (date_key) do nothing;

  insert into analytics.dim_status(status_key, status_name)
  select distinct status::text, status::text from public.orders on conflict (status_key) do nothing;
  insert into analytics.dim_channel(channel_key, payment_method, ai_source)
  select distinct coalesce(payment_method::text, 'unknown') || '|' || coalesce(ai_source::text, 'none'),
    coalesce(payment_method::text, 'unknown'), coalesce(ai_source::text, 'none')
  from public.orders on conflict (channel_key) do nothing;

  -- Source each customer once, irrespective of how many orders they have placed.
  insert into analytics.dim_customer(customer_key, full_name, email, created_at, tier)
  select u.user_id, u.full_name, u.email, u.created_at, u.tier from public.users u
  where exists (select 1 from public.orders o where o.user_id = u.user_id)
  on conflict (customer_key) do update set full_name = excluded.full_name,
    email = excluded.email, created_at = excluded.created_at, tier = excluded.tier;
  insert into analytics.dim_product(product_key, sku, product_name, category_id, category_name)
  select p.product_id, p.sku, p.name, p.category_id, c.name
  from public.product p left join public.category c on c.category_id = p.category_id
  on conflict (product_key) do update set sku = excluded.sku, product_name = excluded.product_name,
    category_id = excluded.category_id, category_name = excluded.category_name;
  insert into analytics.dim_promotion(promotion_key, name, promotion_type, starts_at, ends_at)
  select promo_id, promo_name, promo_type::text, analytics.source_instant(start_date), analytics.source_instant(end_date)
  from public.promotion
  on conflict (promotion_key) do update set name = excluded.name, promotion_type = excluded.promotion_type,
    starts_at = excluded.starts_at, ends_at = excluded.ends_at;

  insert into analytics.fact_order(order_id, date_key, customer_key, channel_key, status_key,
    is_promo, is_valid, is_completed, item_count, discount_amount, shipping_fee, revenue,
    created_at, ordered_at, delivered_at, state_entered_at, is_guest, is_replacement, source_deleted)
  select o.order_id, to_char(analytics.source_instant(o.created_at) at time zone 'Asia/Ho_Chi_Minh', 'YYYYMMDD')::integer,
    o.user_id, coalesce(o.payment_method::text, 'unknown') || '|' || coalesce(o.ai_source::text, 'none'), o.status::text,
    o.voucher_id is not null or o.discount_amount > 0,
    o.status::text not in ('cancelled', 'returned') and not exists(select 1 from public.return_exchange r where r.exchange_order_id = o.order_id),
    o.delivered_at is not null or o.status::text in ('delivered', 'completed'),
    (select count(*)::integer from public.order_item i where i.order_id = o.order_id),
    coalesce(o.discount_amount, 0), coalesce(o.shipping_fee, 0), coalesce(o.total_amount, 0),
    analytics.source_instant(o.created_at) at time zone 'Asia/Ho_Chi_Minh', analytics.source_instant(o.created_at),
    analytics.source_instant(o.delivered_at),
    coalesce((select max(analytics.source_instant(h.changed_at)) from public.order_status_history h
      where h.order_id = o.order_id and h.new_status::text = o.status::text),
      case when o.status::text = 'pending' then analytics.source_instant(o.created_at) end),
    coalesce(o.is_guest, false), exists(select 1 from public.return_exchange r where r.exchange_order_id = o.order_id), false
  from public.orders o
  on conflict (order_id) do update set date_key = excluded.date_key, customer_key = excluded.customer_key,
    channel_key = excluded.channel_key, status_key = excluded.status_key, is_promo = excluded.is_promo,
    is_valid = excluded.is_valid, is_completed = excluded.is_completed, item_count = excluded.item_count,
    discount_amount = excluded.discount_amount, shipping_fee = excluded.shipping_fee, revenue = excluded.revenue,
    created_at = excluded.created_at, ordered_at = excluded.ordered_at, delivered_at = excluded.delivered_at,
    state_entered_at = excluded.state_entered_at, is_guest = excluded.is_guest,
    is_replacement = excluded.is_replacement, source_deleted = false;
  -- Retain a historical snapshot for deleted objects, but exclude them from active reporting.
  update analytics.fact_order f set source_deleted = true, is_valid = false
  where not source_deleted and not exists(select 1 from public.orders o where o.order_id = f.order_id);

  insert into analytics.fact_order_item(item_id, order_id, date_key, product_key, customer_key,
    quantity, unit_price, revenue, is_valid, net_revenue)
  select i.item_id, i.order_id, f.date_key, v.product_id, f.customer_key, i.quantity, i.unit_price,
    i.subtotal_item, f.is_valid,
    greatest(0, i.subtotal_item - case when sum(i.subtotal_item) over(partition by i.order_id) > 0
      then least(case when voucher.discount_type::text = 'free_shipping' then 0 else f.discount_amount end,
        sum(i.subtotal_item) over(partition by i.order_id)) * i.subtotal_item / sum(i.subtotal_item) over(partition by i.order_id)
      else 0 end)
  from public.order_item i join analytics.fact_order f on f.order_id = i.order_id
  join public.orders o on o.order_id=i.order_id left join public.voucher voucher on voucher.voucher_id=o.voucher_id
  join public.variant v on v.variant_id = i.variant_id
  on conflict (item_id) do update set order_id = excluded.order_id, date_key = excluded.date_key,
    product_key = excluded.product_key, customer_key = excluded.customer_key,
    quantity = excluded.quantity, unit_price = excluded.unit_price,
    revenue = excluded.revenue, is_valid = excluded.is_valid, net_revenue = excluded.net_revenue;
  update analytics.fact_order_item i set is_valid = false where is_valid and not exists(select 1 from public.order_item s where s.item_id = i.item_id);

  insert into analytics.fact_voucher_redemption(order_id, voucher_id, voucher_code, promotion_key,
    discount_amount, associated_order_value, is_valid)
  select o.order_id, o.voucher_id, v.code, v.promo_id, o.discount_amount, f.revenue, f.is_valid
  from public.orders o join analytics.fact_order f on f.order_id = o.order_id
  join public.voucher v on v.voucher_id = o.voucher_id
  on conflict (order_id) do update set voucher_id = excluded.voucher_id, voucher_code = excluded.voucher_code,
    promotion_key = excluded.promotion_key, discount_amount = excluded.discount_amount,
    associated_order_value = excluded.associated_order_value, is_valid = excluded.is_valid;
  update analytics.fact_voucher_redemption v set is_valid = false
  where is_valid and not exists(select 1 from public.orders o where o.order_id = v.order_id and o.voucher_id = v.voucher_id and o.status::text <> 'cancelled');
  insert into analytics.fact_promotion_item(item_id,promotion_key,quantity,associated_net_item_value,is_valid)
  select i.item_id,i.applied_promo_id,f.quantity,f.net_revenue,f.is_valid
  from public.order_item i join analytics.fact_order_item f on f.item_id=i.item_id
  where i.applied_promo_id is not null
  on conflict(item_id) do update set promotion_key=excluded.promotion_key,quantity=excluded.quantity,
    associated_net_item_value=excluded.associated_net_item_value,is_valid=excluded.is_valid;
  update analytics.fact_promotion_item f set is_valid=false where is_valid and not exists(
    select 1 from public.order_item i where i.item_id=f.item_id and i.applied_promo_id=f.promotion_key);

  insert into analytics.fact_return_item(return_item_id, return_id, order_item_id, quantity,
    return_status, reason, requested_at, is_active, received_quantity)
  select i.return_item_id, i.return_id, i.order_item_id, i.quantity, r.status::text,
    coalesce(to_jsonb(r)->>'reason', r.description), analytics.source_instant(r.created_at), r.status::text <> 'CANCELLED',
    case when r.condition_check_result::text = 'qa_pass' and r.status::text in
      ('RECEIVED', 'REFUND_PROCESSING', 'REFUNDED', 'EXCHANGE_PREPARING', 'EXCHANGE_SHIPPING', 'COMPLETED') then i.quantity else 0 end
  from public.return_item i join public.return_exchange r on r.return_id = i.return_id
  join analytics.fact_order_item oi on oi.item_id = i.order_item_id
  on conflict (return_item_id) do update set quantity = excluded.quantity, return_status = excluded.return_status,
    reason = excluded.reason, is_active = excluded.is_active, received_quantity = excluded.received_quantity;
  update analytics.fact_return_item f set is_active = false, received_quantity = 0
  where is_active and not exists(select 1 from public.return_item i where i.return_item_id = f.return_item_id);

  insert into analytics.fact_review(review_id, order_id, product_key, rating, submitted_at, status)
  select r.review_id, r.order_id, r.product_id, r.rating, analytics.source_instant(r.submitted_at), r.status::text
  from public.review r join analytics.fact_order f on f.order_id = r.order_id
  on conflict (review_id) do update set rating = excluded.rating, status = excluded.status;
  delete from analytics.fact_review f where not exists(select 1 from public.review r where r.review_id = f.review_id);
  insert into analytics.fact_support_ticket(ticket_id, customer_key, status, csat_score, created_at, resolved_at)
  select ticket_id, user_id, status::text, csat_score, analytics.source_instant(created_at), analytics.source_instant(resolved_at)
  from public.support_ticket
  on conflict (ticket_id) do update set status = excluded.status, csat_score = excluded.csat_score, resolved_at = excluded.resolved_at;
  delete from analytics.fact_support_ticket f where not exists(select 1 from public.support_ticket t where t.ticket_id = f.ticket_id);
  insert into analytics.fact_refund(refund_id,return_id,order_id,amount,status,requested_at,updated_at)
  select f.refund_id,f.return_id,r.order_id,f.amount,f.status,f.created_at,f.updated_at
  from public.payment_refund f join public.return_exchange r on r.return_id=f.return_id
  on conflict(refund_id) do update set amount=excluded.amount,status=excluded.status,updated_at=excluded.updated_at;

  v_refreshed := clock_timestamp();
  select count(*) into v_orders from analytics.fact_order where not source_deleted;
  insert into analytics.etl_watermark(pipeline_name, refreshed_at, order_count) values('star', v_refreshed, v_orders)
  on conflict(pipeline_name) do update set refreshed_at = excluded.refreshed_at, order_count = excluded.order_count;
  return jsonb_build_object('skipped', false, 'refreshedAt', v_refreshed, 'orderCount', v_orders, 'version', 2);
end;
$etl$;

-- Force one complete migration to v2 even if the v1 watermark is still fresh.
delete from analytics.etl_watermark where pipeline_name = 'star';

-- Denominators are original delivered-order cohorts, never unrelated returns created in the period.
-- Lifetime value below is observed order value, not predicted LTV or margin. Costs have no source.
create or replace function public.get_admin_management_facts(
  p_from timestamptz, p_to timestamptz, p_category_id uuid default null, p_product_id uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $facts$
with selected as (
  select f.* from analytics.fact_order f
  where not f.source_deleted and not f.is_replacement and f.ordered_at >= p_from and f.ordered_at < p_to
    and (p_category_id is null and p_product_id is null or exists (
      select 1 from analytics.fact_order_item i join analytics.dim_product d on d.product_key=i.product_key
      where i.order_id=f.order_id and (p_category_id is null or d.category_id=p_category_id)
        and (p_product_id is null or d.product_key=p_product_id)))
), delivered_lines as (
  select i.*, d.product_name,d.sku,d.category_id,d.category_name from analytics.fact_order_item i
  join selected f on f.order_id=i.order_id and f.is_completed and f.status_key <> 'cancelled'
  join analytics.dim_product d on d.product_key=i.product_key
  where (p_category_id is null or d.category_id=p_category_id)
    and (p_product_id is null or d.product_key=p_product_id)
), return_totals as (
  select r.order_item_id,sum(r.quantity) requested_units,sum(r.received_quantity) received_units
  from analytics.fact_return_item r where r.is_active group by r.order_item_id
), sku as (
  select i.product_key,i.product_name,i.sku,i.category_id,i.category_name,
    sum(i.quantity) delivered_units,sum(coalesce(r.requested_units,0)) requested_units,
    sum(coalesce(r.received_units,0)) received_units,sum(i.net_revenue) net_item_value
  from delivered_lines i left join return_totals r on r.order_item_id=i.item_id
  group by i.product_key,i.product_name,i.sku,i.category_id,i.category_name
), ratings as (
  select r.product_key,count(*) rating_count,count(*) filter(where r.rating<=2) low_rating_count,avg(r.rating) average_rating
  from analytics.fact_review r join selected f on f.order_id=r.order_id
  where r.status not in ('rejected','hidden') group by r.product_key
), sku_metrics as (
  select s.*,coalesce(r.rating_count,0) rating_count,coalesce(r.low_rating_count,0) low_rating_count,
    round(r.average_rating,2) average_rating,
    round(100.0*s.requested_units/nullif(s.delivered_units,0),2) requested_rate_pct,
    round(100.0*s.received_units/nullif(s.delivered_units,0),2) received_rate_pct
  from sku s left join ratings r on r.product_key=s.product_key
), categories as (
  select category_id,category_name,sum(delivered_units) delivered_units,sum(requested_units) requested_units,
    sum(received_units) received_units,round(100.0*sum(requested_units)/nullif(sum(delivered_units),0),2) requested_rate_pct,
    round(100.0*sum(received_units)/nullif(sum(delivered_units),0),2) received_rate_pct
  from sku group by category_id,category_name
), reasons as (
  select coalesce(nullif(r.reason,''),'not_recorded') reason,sum(r.quantity) requested_units
  from analytics.fact_return_item r join delivered_lines i on i.item_id=r.order_item_id
  where r.is_active group by coalesce(nullif(r.reason,''),'not_recorded')
), active as (
  select f.*,case when state_entered_at<=current_timestamp then extract(epoch from(current_timestamp-state_entered_at))/3600 end hours_in_state
  from analytics.fact_order f where not f.source_deleted and not f.is_replacement
    and f.status_key in ('pending','confirmed','preparing')
    and (p_category_id is null and p_product_id is null or exists (
      select 1 from analytics.fact_order_item i join analytics.dim_product d on d.product_key=i.product_key
      where i.order_id=f.order_id and (p_category_id is null or d.category_id=p_category_id)
        and (p_product_id is null or d.product_key=p_product_id)))
), sla as (
  select count(*) active_orders,count(hours_in_state) known_state_orders,
    count(*) filter(where hours_in_state>24) attention_orders_24h,
    round(avg(hours_in_state)::numeric,2) average_hours_in_state,
    round(100.0*count(*) filter(where hours_in_state>24)/nullif(count(hours_in_state),0),2) attention_rate_pct
  from active
), sla_status as (
  select status_key,count(*) active_orders,count(hours_in_state) known_state_orders,
    count(*) filter(where hours_in_state>24) attention_orders_24h from active group by status_key
), redemptions as (
  select v.* from analytics.fact_voucher_redemption v join selected f on f.order_id=v.order_id where v.is_valid and f.is_valid
), programs as (
  select v.promotion_key,p.name,count(*) redemptions,sum(v.discount_amount) discount_amount,
    sum(v.associated_order_value) associated_order_value
  from redemptions v left join analytics.dim_promotion p on p.promotion_key=v.promotion_key group by v.promotion_key,p.name
), discount_orders as (
  select f.order_id,case when f.discount_amount<=0 then 'none'
    when f.discount_amount/nullif(f.revenue-f.shipping_fee+f.discount_amount,0)>0.3 then 'over_30_percent'
    else 'up_to_30_percent' end bracket from selected f where f.is_valid and f.is_completed
), discount_reviews as (
  select d.bracket,count(distinct d.order_id) orders,
    count(distinct d.order_id) filter(where r.review_id is not null) reviewed_orders,count(r.review_id) review_count,
    round(avg(r.rating),2) average_rating,count(r.review_id) filter(where r.rating<=2) low_rating_count
  from discount_orders d left join analytics.fact_review r on r.order_id=d.order_id and r.status not in ('rejected','hidden')
  group by d.bracket
), historical_customers as (
  select f.customer_key,count(*) purchases,sum(f.revenue) observed_order_value
  from analytics.fact_order f where f.is_valid and f.is_completed and not f.is_guest and not f.is_replacement
    and not f.source_deleted and f.customer_key is not null and f.ordered_at<p_to group by f.customer_key
), current_customers as (
  select distinct f.customer_key from selected f where f.is_valid and f.is_completed and not f.is_guest and f.customer_key is not null
), retention as (
  select count(*) known_customers,count(*) filter(where h.purchases>=2) repeat_customers,
    round(100.0*count(*) filter(where h.purchases>=2)/nullif(count(*),0),2) repeat_purchase_rate_pct,
    round(avg(h.observed_order_value),2) observed_lifetime_order_value_avg
  from current_customers c join historical_customers h on h.customer_key=c.customer_key
), tier_revenue as (
  select coalesce(c.tier,'not_recorded') current_tier,count(distinct f.customer_key) customers,sum(f.revenue) order_value
  from selected f join analytics.dim_customer c on c.customer_key=f.customer_key
  where f.is_valid and f.is_completed and not f.is_guest group by coalesce(c.tier,'not_recorded')
), csat as (
  select count(*) tickets,count(csat_score) sample_count,round(avg(csat_score),2) average_score,
    count(*) filter(where status in ('resolved','closed') and csat_score is null) closed_without_score
  from analytics.fact_support_ticket where created_at>=p_from and created_at<p_to
), coverage as (
  select count(*) delivered_orders,count(*) filter(where exists(select 1 from analytics.fact_review r
    where r.order_id=f.order_id and r.status not in ('rejected','hidden'))) reviewed_orders
  from selected f where f.is_completed and f.status_key <> 'cancelled'
)
select jsonb_build_object(
  'source','analytics.star.v2','dataset','operational','snapshotAt',(select refreshed_at from analytics.etl_watermark where pipeline_name='star'),
  'cohortDefinition','Original delivered orders created in [from,to); returns of those lines as known at snapshot time.',
  'slaScope','All current pending/confirmed/preparing orders, including orders created before the selected period.',
  'csatScope','All support tickets created in the period; no order/category foreign key exists for a narrower join.',
  'sla', (select to_jsonb(sla) from sla) || jsonb_build_object('attentionThresholdHours',24,'contractualSlaAvailable',false,
    'byStatus',coalesce((select jsonb_agg(to_jsonb(s)) from sla_status s),'[]'::jsonb),
    'attentionOrderIds',coalesce((select jsonb_agg(order_id) from(select order_id from active where hours_in_state>24 order by hours_in_state desc limit 20)a),'[]'::jsonb)),
  'skuReturns',coalesce((select jsonb_agg(to_jsonb(s) order by s.delivered_units desc) from sku_metrics s),'[]'::jsonb),
  'categoryReturns',coalesce((select jsonb_agg(to_jsonb(c)) from categories c),'[]'::jsonb),
  'returnReasons',coalesce((select jsonb_agg(to_jsonb(r) order by r.requested_units desc) from reasons r),'[]'::jsonb),
  'refunds',jsonb_build_object('completedAmount',(select sum(r.amount) from analytics.fact_refund r join selected f on f.order_id=r.order_id where r.status='succeeded'),
    'pendingAmount',(select sum(r.amount) from analytics.fact_refund r join selected f on f.order_id=r.order_id where r.status in ('requested','pending')),
    'profitImpactAvailable',false),
  'promotion',jsonb_build_object('redemptions',(select count(*) from redemptions),'discountAmount',(select sum(discount_amount) from redemptions),
    'associatedOrderValue',(select sum(associated_order_value) from redemptions),'costAvailable',false,'roi',null,
    'programs',coalesce((select jsonb_agg(to_jsonb(p)) from programs p),'[]'::jsonb),
    'appliedProductPromotions',coalesce((select jsonb_agg(to_jsonb(p)) from (
      select i.promotion_key,d.name,sum(i.quantity) units,sum(i.associated_net_item_value) associated_net_item_value
      from analytics.fact_promotion_item i join analytics.fact_order_item oi on oi.item_id=i.item_id
      join selected f on f.order_id=oi.order_id join analytics.dim_promotion d on d.promotion_key=i.promotion_key
      where i.is_valid and (p_category_id is null or exists(select 1 from analytics.dim_product p where p.product_key=oi.product_key and p.category_id=p_category_id))
        and (p_product_id is null or oi.product_key=p_product_id)
      group by i.promotion_key,d.name)p),'[]'::jsonb),'historicalProductDiscountAvailable',false),
  'discountSatisfaction',coalesce((select jsonb_agg(to_jsonb(d)) from discount_reviews d),'[]'::jsonb),
  'discountCsatJoinAvailable',false,'retention',(select to_jsonb(r) from retention r) || jsonb_build_object('predictedLtvAvailable',false,
    'currentTierRevenues',coalesce((select jsonb_agg(to_jsonb(t)) from tier_revenue t),'[]'::jsonb)),
  'csat',(select to_jsonb(c) from csat c),'reviewCoverage',(select to_jsonb(c) from coverage c)
);
$facts$;
revoke all on function public.get_admin_management_facts(timestamptz,timestamptz,uuid,uuid) from public, anon, authenticated;
grant execute on function public.get_admin_management_facts(timestamptz,timestamptz,uuid,uuid) to service_role;

-- The compatible dashboard aggregate uses the same v2 facts and canonical operational queues.
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
    (select count(*)::integer from public.orders where status::text = 'pending') as pending_orders,
    (select count(distinct o.order_id)::integer
      from public.orders o
      join public.payment pay on pay.order_id = o.order_id
      where pay.payment_status::text in ('failed', 'discrepancy') or coalesce(pay.has_discrepancy, false)
    ) as payment_errors,
    (select count(*)::integer from public.return_exchange where status::text not in ('COMPLETED','CANCELLED')) as open_returns,
    (select count(*)::integer
      from public.return_exchange
      where status::text in ('REQUESTED','CONTACTING') and contact_due_at <= now()
    ) as returns_due_soon,
    (select count(*)::integer from public.support_ticket where status::text not in ('resolved', 'closed')) as open_support_tickets,
    (select count(distinct product_id)::integer from public.variant where stock_quantity-reserved_quantity <= low_stock_threshold) as low_stock_products,
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

do $security$
declare v_table text;
begin
  foreach v_table in array array['dim_date','dim_product','dim_customer','dim_channel','dim_status','dim_promotion',
    'fact_order','fact_order_item','fact_voucher_redemption','fact_return_item','fact_review','fact_support_ticket','fact_refund','fact_promotion_item','etl_watermark'] loop
    execute format('alter table analytics.%I enable row level security', v_table);
    execute format('revoke all on analytics.%I from public, anon, authenticated', v_table);
    execute format('grant select, insert, update, delete on analytics.%I to service_role', v_table);
    execute format('drop policy if exists analytics_service_access on analytics.%I', v_table);
    execute format('create policy analytics_service_access on analytics.%I for all to service_role using (true) with check (true)', v_table);
  end loop;
end;
$security$;
revoke all on schema analytics from public, anon, authenticated;
grant usage on schema analytics to service_role;
revoke all on function public.refresh_analytics_star(interval) from public, anon, authenticated;
grant execute on function public.refresh_analytics_star(interval) to service_role;
revoke all on function analytics.source_instant(timestamp), analytics.source_instant(timestamptz) from public, anon, authenticated;
grant execute on function analytics.source_instant(timestamp), analytics.source_instant(timestamptz) to service_role;
commit;
