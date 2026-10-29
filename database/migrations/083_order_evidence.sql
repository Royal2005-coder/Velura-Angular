-- 083_order_evidence.sql
--
-- Bằng chứng tải lên theo từng công đoạn của đơn hàng (đóng gói, bàn giao, giao hàng,
-- xử lý sự cố). Tệp nằm trong bucket private; API trả signed URL 15 phút.

create table if not exists public.order_evidence (
  evidence_id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(order_id) on delete cascade,
  stage text not null,
  kind text not null default 'image',
  storage_bucket text not null,
  storage_path text not null,
  mime_type text not null,
  note text,
  uploaded_by uuid references public.users(user_id),
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_evidence_stage_check') then
    alter table public.order_evidence
      add constraint order_evidence_stage_check
      check (stage in ('pending', 'confirmed', 'processing', 'shipping', 'delivered', 'cancelled', 'delivery_failed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_evidence_kind_check') then
    alter table public.order_evidence
      add constraint order_evidence_kind_check
      check (kind in ('image', 'video'));
  end if;
end $$;

create index if not exists order_evidence_order_stage_idx
  on public.order_evidence (order_id, stage, created_at desc);

alter table public.order_evidence enable row level security;
revoke all on public.order_evidence from public, anon, authenticated;
grant all on public.order_evidence to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'order-evidence-private', 'order-evidence-private', false, 52428800,
  array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

comment on table public.order_evidence is
  'Ảnh/video bằng chứng theo công đoạn đơn hàng; đọc qua signed URL từ API admin.';

notify pgrst, 'reload schema';
