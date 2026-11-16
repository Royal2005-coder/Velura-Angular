-- KAN-106: production runs the legacy loyalty model, whose orders table never had the point columns
-- that 073/084/087 read. Add them as inert zeros so return maths works; spending stays disabled.
begin;

alter table public.orders
  add column if not exists points_used integer not null default 0 check (points_used >= 0),
  add column if not exists points_discount numeric(12,0) not null default 0 check (points_discount >= 0);

notify pgrst, 'reload schema';

commit;
