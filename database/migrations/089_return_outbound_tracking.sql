-- KAN-106: exchange shipments must never reuse the inbound return code or another AWB.
-- The API/UI may omit a carrier AWB; the database then issues a unique EXC-prefixed code and
-- writes it onto the linked replacement order before the outbound shipment is inserted.
begin;

create or replace function public.velura_ensure_outbound_tracking()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare candidate text;
begin
  if new.direction<>'outbound' then return new; end if;
  if new.tracking_code is null or btrim(new.tracking_code)=''
     or exists(select 1 from public.return_shipment s where s.carrier=new.carrier
       and s.tracking_code=new.tracking_code and s.shipment_id<>new.shipment_id)
     or new.tracking_code=(select tracking_return_code from public.return_exchange where return_id=new.return_id) then
    loop
      candidate:='EXC'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,16));
      exit when not exists(select 1 from public.return_shipment s
        where s.carrier=new.carrier and s.tracking_code=candidate);
    end loop;
    new.tracking_code:=candidate;
  end if;
  if new.order_id is not null then
    update public.orders set carrier=new.carrier,tracking_code=new.tracking_code,updated_at=now()
      where order_id=new.order_id;
  end if;
  return new;
end; $$;
drop trigger if exists return_shipment_outbound_tracking on public.return_shipment;
create trigger return_shipment_outbound_tracking before insert or update of tracking_code,carrier
  on public.return_shipment for each row execute function public.velura_ensure_outbound_tracking();

notify pgrst,'reload schema';
commit;
