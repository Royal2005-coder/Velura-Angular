-- Migration 011: Update combo_item RLS policies to use canonical velura_has_admin_role helper
-- Required by UC-A06 (Pricing & Promotions) — combo management role checks

begin;

-- Enable RLS (just in case)
alter table public.combo_item enable row level security;

-- Drop old policies
drop policy if exists combo_item_select_admin on public.combo_item;
drop policy if exists combo_item_select_public on public.combo_item;
drop policy if exists combo_item_select_all on public.combo_item;
drop policy if exists combo_item_insert_admin on public.combo_item;
drop policy if exists combo_item_update_admin on public.combo_item;
drop policy if exists combo_item_delete_admin on public.combo_item;

-- 1. Select policy: allow public read of combo compositions (anon and authenticated users)
create policy combo_item_select_all on public.combo_item
  for select to anon, authenticated
  using (true);

-- 2. Insert policy: only authorized admins (super_admin, admin_operator_sanpham, admin_operator_gia_km)
create policy combo_item_insert_admin on public.combo_item
  for insert to authenticated
  with check ((select public.velura_has_admin_role(array['super_admin', 'admin_operator_sanpham', 'admin_operator_gia_km'])));

-- 3. Update policy: only authorized admins
create policy combo_item_update_admin on public.combo_item
  for update to authenticated
  using ((select public.velura_has_admin_role(array['super_admin', 'admin_operator_sanpham', 'admin_operator_gia_km'])));

-- 4. Delete policy: only authorized admins
create policy combo_item_delete_admin on public.combo_item
  for delete to authenticated
  using ((select public.velura_has_admin_role(array['super_admin', 'admin_operator_sanpham', 'admin_operator_gia_km'])));

-- Explicitly grant permissions to anon and authenticated roles
grant select on public.combo_item to anon;
grant select, insert, update, delete on public.combo_item to authenticated;

commit;
