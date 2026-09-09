begin;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  type varchar(50) not null, -- 'order_status', 'review_moderation', 'promotion', 'system', etc.
  title varchar(255) not null,
  content text not null,
  link varchar(255),
  is_read boolean default false not null,
  created_at timestamptz default now() not null
);

create index if not exists idx_notifications_user_id on public.notifications(user_id);
create index if not exists idx_notifications_created_at on public.notifications(created_at desc);

-- Enable RLS
alter table public.notifications enable row level security;

-- Allow users to manage their own notifications
create policy "Users can manage their own notifications"
  on public.notifications
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Grant permissions to REST / postgREST API
grant all on public.notifications to postgres, service_role, authenticated, anon;

commit;
