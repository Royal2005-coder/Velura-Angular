begin;

create or replace function public.velura_is_order_reader()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from public.users u
    where u.user_id = public.velura_current_user_id()
      and u.role::text = 'admin'
      and u.is_active
      and u.admin_role::text in (
        'super_admin', 'admin_operator_donhang', 'admin_operator_cskh_dt'
      )
  )
$$;

revoke all on function public.velura_is_order_reader() from public, anon;
grant execute on function public.velura_is_order_reader() to authenticated;

commit;
