-- KAN-112: production orders never had points_earned_milli; 073/080/086 read it through v_order,
-- so velura_adjust_loyalty_for_return raised 42703 and aborted every refund completion.
-- Idempotent. Inert zero = nothing earned, so no clawback is computed for legacy orders.
begin;

alter table public.orders
  add column if not exists points_earned_milli bigint not null default 0 check (points_earned_milli >= 0);

notify pgrst, 'reload schema';

commit;
