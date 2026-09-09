-- Migration 012: Create chat_session and chat_message tables for AI customer support chatbot
-- Required for ChatHistories & ChatMessages persistence with RLS support

begin;

-- Create chat_session table
create table if not exists public.chat_session (
  session_id      uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete set null,
  guest_id        uuid, -- for anonymous guests to preserve session history in localStorage
  title           text not null,
  is_active       boolean not null default true,
  assigned_to     uuid references auth.users(id) on delete set null, -- CSKH staff who is chatting
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.chat_session is 'Stores the chat sessions of customer support chatbot.';

-- Create chat_message table
create table if not exists public.chat_message (
  message_id      uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.chat_session(session_id) on delete cascade,
  sender          text not null check (sender in ('user', 'bot', 'agent')),
  text            text not null,
  metadata        jsonb not null default '{}'::jsonb, -- e.g. { "product_ids": [...] }
  created_at      timestamptz not null default now()
);

comment on table public.chat_message is 'Stores the chat messages of customer support chatbot.';

-- Indexes
create index if not exists idx_chat_session_user on public.chat_session(user_id);
create index if not exists idx_chat_session_guest on public.chat_session(guest_id);
create index if not exists idx_chat_message_session on public.chat_message(session_id);

-- Enable RLS
alter table public.chat_session enable row level security;
alter table public.chat_message enable row level security;

-- Policies for chat_session
drop policy if exists chat_session_select_policy on public.chat_session;
create policy chat_session_select_policy on public.chat_session
  for select to anon, authenticated
  using (
    user_id = public.velura_current_user_id() 
    or guest_id is not null
    or (select public.velura_has_admin_role(array['super_admin', 'admin_operator_cskh_dt']))
  );

drop policy if exists chat_session_insert_policy on public.chat_session;
create policy chat_session_insert_policy on public.chat_session
  for insert to anon, authenticated
  with check (
    user_id = public.velura_current_user_id() 
    or user_id is null
    or (select public.velura_has_admin_role(array['super_admin', 'admin_operator_cskh_dt']))
  );

drop policy if exists chat_session_update_policy on public.chat_session;
create policy chat_session_update_policy on public.chat_session
  for update to anon, authenticated
  using (
    user_id = public.velura_current_user_id() 
    or guest_id is not null
    or (select public.velura_has_admin_role(array['super_admin', 'admin_operator_cskh_dt']))
  );

drop policy if exists chat_session_delete_policy on public.chat_session;
create policy chat_session_delete_policy on public.chat_session
  for delete to anon, authenticated
  using (
    user_id = public.velura_current_user_id() 
    or guest_id is not null
    or (select public.velura_has_admin_role(array['super_admin', 'admin_operator_cskh_dt']))
  );

-- Policies for chat_message
drop policy if exists chat_message_select_policy on public.chat_message;
create policy chat_message_select_policy on public.chat_message
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.chat_session s
      where s.session_id = chat_message.session_id
    )
  );

drop policy if exists chat_message_insert_policy on public.chat_message;
create policy chat_message_insert_policy on public.chat_message
  for insert to anon, authenticated
  with check (
    exists (
      select 1 from public.chat_session s
      where s.session_id = chat_message.session_id
    )
  );

-- Grants
grant select, insert, update, delete on public.chat_session to anon, authenticated;
grant select, insert, update on public.chat_message to anon, authenticated;

commit;
