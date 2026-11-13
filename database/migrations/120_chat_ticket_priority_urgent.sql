-- KAN-66: a restored dump kept the pre-escalation ticket_priority enum; 056/059 cast
-- 'urgent'::public.ticket_priority, and PostgreSQL evaluates that constant at plan time, so every
-- chat RPC fails with 22P02 even when no ticket row is updated.
begin;

alter type public.ticket_priority add value if not exists 'urgent';

commit;
