-- KAN-110: `approval_admin_request.action_note` is the approver's decision note.
--
-- Why: the production table was created before 001 and only has `admin_note`, so the CREATE TABLE IF NOT
-- EXISTS in 001 never added `action_note`. `velura_expire_admin_requests`, `velura_decide_admin_request` and
-- `account-repository.ts` all read/write `action_note`; the missing column made the 10-day expiry job and the
-- pending-request list fail with 42703. Add it and carry over the legacy note; keep `admin_note` untouched.
begin;

alter table public.approval_admin_request add column if not exists action_note text;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'approval_admin_request' and column_name = 'admin_note') then
    update public.approval_admin_request
       set action_note = admin_note
     where action_note is null and admin_note is not null;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
