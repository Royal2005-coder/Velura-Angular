-- Migration 010: Create combo_item table for Combo/Bundle management
-- Required by UC-A06 (Pricing & Promotions) — combo composition tracking

begin;

-- ═══════════════════════════════════════════════════════════
-- 1. Create combo_item table
-- ═══════════════════════════════════════════════════════════

create table if not exists public.combo_item (
  combo_item_id   uuid primary key default gen_random_uuid(),
  combo_product_id uuid not null references public.product(product_id) on delete cascade,
  component_product_id uuid not null references public.product(product_id) on delete restrict,
  component_variant_id uuid references public.variant(variant_id) on delete set null,
  quantity        integer not null default 1 check (quantity > 0),
  created_at      timestamptz not null default now()
);

comment on table public.combo_item is 'Stores the composition of combo/bundle products — which component products make up a combo.';
comment on column public.combo_item.combo_product_id is 'The parent combo product (product.is_combo = true)';
comment on column public.combo_item.component_product_id is 'The child component product included in the combo';
comment on column public.combo_item.component_variant_id is 'Optional: specific variant of the component product';
comment on column public.combo_item.quantity is 'How many units of this component are in the combo';

-- Indexes for efficient lookups
create index if not exists idx_combo_item_combo on public.combo_item(combo_product_id);
create index if not exists idx_combo_item_component on public.combo_item(component_product_id);

-- Prevent duplicate components within same combo (same product+variant pair)
create unique index if not exists idx_combo_item_unique_component
  on public.combo_item(combo_product_id, component_product_id, coalesce(component_variant_id, '00000000-0000-0000-0000-000000000000'));

-- ═══════════════════════════════════════════════════════════
-- 2. Enable RLS — admin-only access via JWT
-- ═══════════════════════════════════════════════════════════

alter table public.combo_item enable row level security;

-- Read policy: allow select for everyone (required to render public product compositions)
drop policy if exists combo_item_select_admin on public.combo_item;
drop policy if exists combo_item_select_public on public.combo_item;
create policy combo_item_select_all on public.combo_item
  for select to anon, authenticated
  using (true);

-- Insert policy: product admins can add combo items
drop policy if exists combo_item_insert_admin on public.combo_item;
create policy combo_item_insert_admin on public.combo_item
  for insert to authenticated
  with check ((select public.velura_has_admin_role(array['super_admin', 'admin_operator_sanpham', 'admin_operator_gia_km'])));

-- Update policy: product admins can update combo items
drop policy if exists combo_item_update_admin on public.combo_item;
create policy combo_item_update_admin on public.combo_item
  for update to authenticated
  using ((select public.velura_has_admin_role(array['super_admin', 'admin_operator_sanpham', 'admin_operator_gia_km'])));

-- Delete policy: product admins can remove combo items
drop policy if exists combo_item_delete_admin on public.combo_item;
create policy combo_item_delete_admin on public.combo_item
  for delete to authenticated
  using ((select public.velura_has_admin_role(array['super_admin', 'admin_operator_sanpham', 'admin_operator_gia_km'])));

commit;
