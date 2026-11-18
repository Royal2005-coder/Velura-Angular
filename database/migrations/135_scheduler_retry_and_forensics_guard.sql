-- Migration 135: Smart Blog Scheduler failed_retry Recovery Transition & Broadcast Outbox Deduplication Index
begin;

-- 1. Allow 'published' -> 'failed_retry' when downstream newsletter outbox enqueue encounters transient errors
--    so velura_publish_scheduled_blogs retries up to publish_attempts = 3 without double-blasting already-queued recipients.
create or replace function public.velura_blog_transition_allowed(p_from text, p_to text)
returns boolean
language sql
stable
as $$
  select case
    when p_from = p_to then true
    when p_from = 'draft' then p_to in ('ai_reviewed', 'scheduled', 'published', 'archived')
    when p_from = 'ai_reviewed' then p_to in ('draft', 'scheduled', 'published', 'archived')
    when p_from = 'scheduled' then p_to in ('draft', 'ai_reviewed', 'published', 'failed_retry', 'archived')
    when p_from = 'failed_retry' then p_to in ('draft', 'scheduled', 'published', 'archived')
    when p_from = 'published' then p_to in ('draft', 'failed_retry', 'archived')
    when p_from = 'archived' then p_to = 'draft'
    else false
  end;
$$;

-- 2. Add lookup index on email_outbox for fast per-blog broadcast deduplication during retry cycles
do $$
begin
  if exists (
    select 1
    from pg_class t
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'email_outbox'
  ) then
    execute 'create index if not exists idx_email_outbox_blog_broadcast_dedup
      on public.email_outbox ((metadata->>''blog_id''), lower(recipient))
      where template_code = ''newsletter_blog_broadcast''';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
