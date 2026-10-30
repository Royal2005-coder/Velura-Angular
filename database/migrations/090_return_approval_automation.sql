-- KAN-106: approval immediately means "waiting for carrier pickup"; the separate wait_return
-- admin action disappears. Existing approved parts migrate to the same state.
begin;

create or replace function public.velura_auto_wait_return()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if old.item_status='REQUESTED' and new.item_status='APPROVED' and new.decision_status='approved' then
    new.item_status:='WAITING_RETURN';
  end if;
  return new;
end; $$;
drop trigger if exists return_item_auto_wait_return on public.return_item;
create trigger return_item_auto_wait_return before update on public.return_item
  for each row execute function public.velura_auto_wait_return();

-- Audit every automatic transition after the item update so history remains explainable.
create or replace function public.velura_auto_wait_return_event()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if old.item_status='APPROVED' and new.item_status='WAITING_RETURN' then
    insert into public.return_event(return_id,return_item_id,old_status,new_status,actor_type,event_type,note)
    values(new.return_id,new.return_item_id,'APPROVED','WAITING_RETURN','system','status',
      'Tự động chuyển sang chờ ĐVVC lấy hàng sau khi duyệt');
  end if;
  return new;
end; $$;
drop trigger if exists return_item_auto_wait_return_event on public.return_item;
create trigger return_item_auto_wait_return_event after update on public.return_item
  for each row execute function public.velura_auto_wait_return_event();

do $$
declare r record;
begin
  for r in select return_item_id,return_id from public.return_item
    where item_status='APPROVED' and decision_status='approved' for update loop
    update public.return_item set item_status='WAITING_RETURN',version=version+1,updated_at=now()
      where return_item_id=r.return_item_id;
    perform public.velura_refresh_return_aggregate(r.return_id);
  end loop;
end $$;

notify pgrst,'reload schema';
commit;
