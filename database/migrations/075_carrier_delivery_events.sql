-- KAN-106: ledger of inbound carrier delivery events (webhook evidence + replay protection).
-- Requires 037 (orders, order_event) and 038 (order action rules). Writes stay service-role only:
-- the admin reads the trail through order_event, never from this table.
begin;

create table if not exists public.carrier_delivery_event (
  event_id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  order_id uuid references public.orders(order_id) on delete set null,
  order_code text not null,
  tracking_code text not null,
  status text not null,
  action text,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  applied boolean not null default false,
  detail text,
  payload jsonb not null default '{}'::jsonb,
  check (provider ~ '^[a-z0-9][a-z0-9-]{1,23}$'),
  check (provider_event_id ~ '^[A-Za-z0-9._:-]{4,120}$'),
  check (tracking_code ~ '^[A-Za-z0-9-]{6,60}$'),
  check (status in ('delivered', 'failed_retrying', 'failed_returned'))
);

-- One carrier event must apply once, whatever retries the provider sends after a timeout.
create unique index if not exists carrier_delivery_event_provider_key
  on public.carrier_delivery_event (provider, provider_event_id);
create index if not exists carrier_delivery_event_order_idx
  on public.carrier_delivery_event (order_id, occurred_at desc);

alter table public.carrier_delivery_event enable row level security;
revoke all on public.carrier_delivery_event from public, anon, authenticated;
grant select, insert, update on public.carrier_delivery_event to service_role;

comment on table public.carrier_delivery_event is
  'Bằng chứng webhook vận tải: mỗi sự kiện nhà vận chuyển gửi tới một dòng, khoá (provider, provider_event_id) chặn áp dụng lặp.';
comment on column public.carrier_delivery_event.applied is
  'false khi sự kiện mới được ghi mà đơn hàng chưa chuyển; true sau khi velura_order_service_action chạy xong.';

commit;
