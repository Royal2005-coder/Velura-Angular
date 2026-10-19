-- KAN-105: production runs the legacy loyalty_account/loyalty_ledger model (see 061, 073), not the 050 tables.
-- The voucher API still filters member-only reward vouchers by voucher.reward_member_id, which production lacks.
-- Add only that column; the 050 tables are intentionally NOT created because they conflict with the legacy model.
begin;
alter table public.voucher add column if not exists reward_member_id uuid references public.users(user_id);
create index if not exists voucher_reward_member_idx on public.voucher(reward_member_id) where reward_member_id is not null;
commit;
