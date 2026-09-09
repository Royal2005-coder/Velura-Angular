begin;

create or replace function public.velura_has_admin_role(p_roles text[])
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
      and u.admin_role::text = any(p_roles)
  )
$$;

revoke all on function public.velura_has_admin_role(text[]) from public, anon;
grant execute on function public.velura_has_admin_role(text[]) to authenticated;

alter table public.category enable row level security;
alter table public.product enable row level security;
alter table public.variant enable row level security;
alter table public.review enable row level security;
alter table public.return_exchange enable row level security;
alter table public.return_item enable row level security;
alter table public.support_ticket enable row level security;
alter table public.promotion enable row level security;
alter table public.voucher enable row level security;
alter table public.promotion_product enable row level security;
alter table public.price_history enable row level security;

drop policy if exists category_catalog_select on public.category;
create policy category_catalog_select on public.category for select to anon, authenticated using (true);

drop policy if exists product_catalog_select on public.product;
drop policy if exists product_public_select on public.product;
drop policy if exists product_admin_select on public.product;
create policy product_public_select on public.product for select to anon using (status = 'on_sale');
create policy product_admin_select on public.product for select to authenticated
using (status = 'on_sale' or (select public.velura_has_admin_role(array['super_admin','admin_operator_sanpham','admin_operator_gia_km'])));

drop policy if exists variant_catalog_select on public.variant;
drop policy if exists variant_public_select on public.variant;
drop policy if exists variant_admin_select on public.variant;
create policy variant_public_select on public.variant for select to anon
using (exists (select 1 from public.product p where p.product_id = variant.product_id and p.status = 'on_sale'));
create policy variant_admin_select on public.variant for select to authenticated
using (exists (
  select 1 from public.product p where p.product_id = variant.product_id
  and (p.status = 'on_sale' or (select public.velura_has_admin_role(array['super_admin','admin_operator_sanpham','admin_operator_gia_km'])))
));

drop policy if exists review_owner_or_admin_select on public.review;
create policy review_owner_or_admin_select on public.review for select to authenticated
using (user_id = (select public.velura_current_user_id()) or (select public.velura_has_admin_role(array['super_admin','admin_operator_danhgia_review'])));
drop policy if exists review_owner_insert on public.review;
create policy review_owner_insert on public.review for insert to authenticated
with check (
  user_id = (select public.velura_current_user_id())
  and exists (
    select 1 from public.orders o join public.order_item oi on oi.order_id = o.order_id
    join public.variant v on v.variant_id = oi.variant_id
    where o.order_id = review.order_id and o.user_id = (select public.velura_current_user_id())
      and v.product_id = review.product_id and o.status::text in ('delivered','completed')
  )
);

drop policy if exists return_owner_or_admin_select on public.return_exchange;
create policy return_owner_or_admin_select on public.return_exchange for select to authenticated
using (user_id = (select public.velura_current_user_id()) or (select public.velura_has_admin_role(array['super_admin','admin_operator_cskh_dt','admin_operator_donhang'])));
drop policy if exists return_owner_insert on public.return_exchange;
create policy return_owner_insert on public.return_exchange for insert to authenticated
with check (
  user_id = (select public.velura_current_user_id()) and status::text = 'pending'
  and exists (select 1 from public.orders o where o.order_id = return_exchange.order_id
    and o.user_id = (select public.velura_current_user_id()) and o.status::text in ('delivered','completed'))
);

drop policy if exists return_item_owner_or_admin_select on public.return_item;
create policy return_item_owner_or_admin_select on public.return_item for select to authenticated
using (exists (
  select 1 from public.return_exchange r where r.return_id = return_item.return_id
  and (r.user_id = (select public.velura_current_user_id()) or (select public.velura_has_admin_role(array['super_admin','admin_operator_cskh_dt','admin_operator_donhang'])))
));
drop policy if exists return_item_owner_insert on public.return_item;
create policy return_item_owner_insert on public.return_item for insert to authenticated
with check (exists (
  select 1 from public.return_exchange r join public.order_item oi on oi.item_id = return_item.order_item_id and oi.order_id = r.order_id
  where r.return_id = return_item.return_id and r.user_id = (select public.velura_current_user_id())
    and return_item.quantity > 0 and return_item.quantity <= oi.quantity
));

drop policy if exists support_ticket_owner_or_admin_select on public.support_ticket;
create policy support_ticket_owner_or_admin_select on public.support_ticket for select to authenticated
using (user_id = (select public.velura_current_user_id()) or (select public.velura_has_admin_role(array['super_admin','admin_operator_cskh_dt'])));
drop policy if exists support_ticket_owner_insert on public.support_ticket;
create policy support_ticket_owner_insert on public.support_ticket for insert to authenticated
with check (user_id = (select public.velura_current_user_id()) and status::text = 'open');

drop policy if exists promotion_public_or_admin_select on public.promotion;
drop policy if exists promotion_public_select on public.promotion;
drop policy if exists promotion_admin_select on public.promotion;
create policy promotion_public_select on public.promotion for select to anon
using (is_active and start_date <= now() and end_date >= now());
create policy promotion_admin_select on public.promotion for select to authenticated
using ((is_active and start_date <= now() and end_date >= now()) or (select public.velura_has_admin_role(array['super_admin','admin_operator_gia_km'])));

drop policy if exists voucher_public_or_admin_select on public.voucher;
drop policy if exists voucher_public_select on public.voucher;
drop policy if exists voucher_admin_select on public.voucher;
create policy voucher_public_select on public.voucher for select to anon
using (is_active and start_date <= now() and end_date >= now() and (usage_limit_total is null or used_count < usage_limit_total));
create policy voucher_admin_select on public.voucher for select to authenticated
using ((is_active and start_date <= now() and end_date >= now() and (usage_limit_total is null or used_count < usage_limit_total))
  or (select public.velura_has_admin_role(array['super_admin','admin_operator_gia_km'])));

drop policy if exists promotion_product_public_or_admin_select on public.promotion_product;
drop policy if exists promotion_product_public_select on public.promotion_product;
drop policy if exists promotion_product_admin_select on public.promotion_product;
create policy promotion_product_public_select on public.promotion_product for select to anon
using (exists (select 1 from public.promotion p where p.promo_id = promotion_product.promo_id
  and p.is_active and p.start_date <= now() and p.end_date >= now()));
create policy promotion_product_admin_select on public.promotion_product for select to authenticated
using (exists (select 1 from public.promotion p where p.promo_id = promotion_product.promo_id
  and ((p.is_active and p.start_date <= now() and p.end_date >= now()) or (select public.velura_has_admin_role(array['super_admin','admin_operator_gia_km'])))));

drop policy if exists price_history_admin_select on public.price_history;
create policy price_history_admin_select on public.price_history for select to authenticated
using ((select public.velura_has_admin_role(array['super_admin','admin_operator_gia_km'])));

revoke all on public.category, public.product, public.variant from anon, authenticated;
grant select on public.category, public.product, public.variant to anon, authenticated;
revoke all on public.review, public.return_exchange, public.return_item, public.support_ticket from anon, authenticated;
grant select, insert on public.review, public.return_exchange, public.return_item, public.support_ticket to authenticated;
revoke all on public.promotion, public.voucher, public.promotion_product, public.price_history from anon, authenticated;
grant select on public.promotion, public.voucher, public.promotion_product to anon, authenticated;
grant select on public.price_history to authenticated;

create index if not exists idx_review_user_order on public.review(user_id, order_id);
create index if not exists idx_return_user_order on public.return_exchange(user_id, order_id);
create index if not exists idx_support_ticket_user_status on public.support_ticket(user_id, status);
create index if not exists idx_promotion_active_dates on public.promotion(is_active, start_date, end_date);
create index if not exists idx_voucher_active_dates on public.voucher(is_active, start_date, end_date);

do $$
declare v_function record;
begin
  for v_function in
    select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and (p.proname like 'admin_%' or p.proname like 'velura_%')
  loop
    execute format('revoke execute on function %s from public, anon', v_function.signature);
  end loop;
end $$;

revoke execute on function public.admin_lock_user(uuid,text,text,integer,uuid,timestamptz,text) from authenticated;
revoke execute on function public.admin_unlock_user(uuid,text,integer,uuid,text) from authenticated;
revoke execute on function public.admin_change_user_role(uuid,text,text,integer,uuid,text) from authenticated;
revoke execute on function public.admin_create_product(text,text,text,uuid,text,numeric,numeric,text[],text[],text,text[],text[],text,boolean,boolean,text,text,text,integer,text) from authenticated;
revoke execute on function public.admin_update_product(uuid,text,text,uuid,text,numeric,numeric,text[],text[],text,text[],text[],text,boolean,text,text,text,integer,text) from authenticated;

revoke execute on function public.velura_append_audit(uuid,text,text,uuid,jsonb,jsonb,text) from authenticated;
revoke execute on function public.velura_append_module_audit(text,uuid,text,text,uuid,jsonb,jsonb,text) from authenticated;
revoke execute on function public.velura_claim_email_outbox(integer) from authenticated;
revoke execute on function public.velura_complete_email_outbox(uuid,boolean,text) from authenticated;
revoke execute on function public.velura_enqueue_account_email(text,text,text,text,uuid) from authenticated;
revoke execute on function public.velura_enqueue_order_email(text,text,text,text,uuid,jsonb) from authenticated;
revoke execute on function public.velura_expire_admin_requests() from authenticated;
revoke execute on function public.velura_handle_new_auth_user() from authenticated;
revoke execute on function public.velura_safe_user(public.users) from authenticated;
revoke execute on function public.velura_sanitize_search(text) from authenticated;
revoke execute on function public.velura_touch_updated_at() from authenticated;

grant execute on function public.velura_claim_email_outbox(integer) to service_role;
grant execute on function public.velura_complete_email_outbox(uuid,boolean,text) to service_role;
grant execute on function public.velura_expire_admin_requests() to service_role;

commit;
