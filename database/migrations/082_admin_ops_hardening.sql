-- 082_admin_ops_hardening.sql
--
-- 1. Audit evidence: RPC cũ ghi cứng actor_role/IP. Trigger dưới đây lấy role thật
--    từ users và IP khách do API chuyển qua header x-velura-client-ip, không cần
--    đổi chữ ký RPC.
-- 2. Bucket bằng chứng đổi trả cũ còn public; đóng lại để ảnh/video khách chỉ đọc
--    được qua signed URL.
-- 3. Điều chỉnh tồn kho hàng loạt chạy trong một transaction, khoá từng biến thể,
--    kiểm expectedVersion và audit cả thay đổi ngưỡng cảnh báo.

-- ---------------------------------------------------------------------------
-- 1. Audit actor/IP
-- ---------------------------------------------------------------------------
create or replace function public.velura_normalize_audit_actor()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_ip text;
  v_headers jsonb;
begin
  if new.actor_id is not null then
    select u.admin_role::text into v_role
    from public.users u
    where u.user_id = new.actor_id
      and u.role::text = 'admin';
    if v_role is not null then
      new.actor_role := v_role::public.admin_role_type;
    end if;
  end if;

  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;
  v_ip := nullif(btrim(coalesce(v_headers->>'x-velura-client-ip', '')), '');
  if v_ip is not null then
    new.ip_address := left(v_ip, 45);
  end if;

  return new;
end;
$$;

drop trigger if exists velura_normalize_audit_actor on public.audit_log;
create trigger velura_normalize_audit_actor
  before insert on public.audit_log
  for each row execute function public.velura_normalize_audit_actor();

create or replace function public.velura_normalize_order_event_actor()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
begin
  if new.actor_id is not null and new.actor_type::text = 'manual' then
    select u.admin_role::text into v_role
    from public.users u
    where u.user_id = new.actor_id
      and u.role::text = 'admin';
    if v_role is not null then
      new.actor_role := v_role;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists velura_normalize_order_event_actor on public.order_event;
create trigger velura_normalize_order_event_actor
  before insert on public.order_event
  for each row execute function public.velura_normalize_order_event_actor();

-- ---------------------------------------------------------------------------
-- 2. Bucket bằng chứng cũ: private, chỉ signed URL
-- ---------------------------------------------------------------------------
update storage.buckets
set public = false
where id = 'return-evidence';

-- ---------------------------------------------------------------------------
-- 3. Trạng thái giá là cột sinh để server lọc/phân trang đúng
-- ---------------------------------------------------------------------------
alter table public.product
  add column if not exists price_state text generated always as (
    case
      when sale_price is null then 'missing_sale'
      when sale_price > base_price then 'invalid'
      when sale_price < base_price then 'discounted'
      else 'standard'
    end
  ) stored;

create index if not exists product_price_state_idx on public.product (price_state);

-- ---------------------------------------------------------------------------
-- 4. Điều chỉnh tồn kho hàng loạt trong một transaction
-- ---------------------------------------------------------------------------

create or replace function public.velura_bulk_adjust_stock(
  p_product_id uuid,
  p_updates jsonb,
  p_reason text,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_update jsonb;
  v_variant_id uuid;
  v_delta integer;
  v_threshold integer;
  v_expected integer;
  v_before public.variant%rowtype;
  v_after public.variant%rowtype;
  v_count integer := 0;
begin
  select * into v_actor
  from public.users
  where user_id = public.velura_current_user_id();

  if v_actor.user_id is null
     or v_actor.role::text <> 'admin'
     or not v_actor.is_active then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  if p_updates is null or jsonb_typeof(p_updates) <> 'array' or jsonb_array_length(p_updates) = 0 then
    raise sqlstate 'PT422' using message = 'STOCK_UPDATES_REQUIRED';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'STOCK_REASON_REQUIRED';
  end if;

  for v_update in select * from jsonb_array_elements(p_updates) loop
    v_variant_id := nullif(v_update->>'variantId', '')::uuid;
    v_delta := coalesce(nullif(v_update->>'delta', '')::integer, 0);
    v_threshold := case
      when v_update ? 'lowStockThreshold' and nullif(v_update->>'lowStockThreshold', '') is not null
        then (v_update->>'lowStockThreshold')::integer
      else null
    end;
    v_expected := nullif(v_update->>'expectedVersion', '')::integer;

    if v_variant_id is null then
      raise sqlstate 'PT422' using message = 'VARIANT_REQUIRED';
    end if;
    if v_expected is null or v_expected < 1 then
      raise sqlstate 'PT422' using message = 'VERSION_REQUIRED';
    end if;
    if v_threshold is not null and (v_threshold < 0) then
      raise sqlstate 'PT422' using message = 'LOW_STOCK_THRESHOLD_INVALID';
    end if;
    if v_delta = 0 and v_threshold is null then
      continue;
    end if;

    if v_delta <> 0 then
      -- RPC cũ khoá dòng, kiểm version, ghi stock + audit rồi tăng version.
      perform public.admin_update_stock(
        p_product_id, v_variant_id, v_delta, btrim(p_reason), v_expected, p_ip_address
      );
      if v_threshold is not null then
        select * into v_before from public.variant
        where variant_id = v_variant_id and product_id = p_product_id
        for update;
        update public.variant
        set low_stock_threshold = v_threshold,
            version = version + 1,
            updated_at = now()
        where variant_id = v_variant_id
        returning * into v_after;
        perform public.velura_append_module_audit(
          'products', v_actor.user_id, v_actor.admin_role::text, 'update', v_after.variant_id,
          to_jsonb(v_before),
          to_jsonb(v_after) || jsonb_build_object('reason', btrim(p_reason)),
          p_ip_address
        );
      end if;
    else
      select * into v_before from public.variant
      where variant_id = v_variant_id and product_id = p_product_id
      for update;
      if v_before.variant_id is null then
        raise sqlstate 'PT404' using message = 'PRODUCT_NOT_FOUND';
      end if;
      if v_before.version <> v_expected then
        raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
      end if;
      update public.variant
      set low_stock_threshold = v_threshold,
          version = version + 1,
          updated_at = now()
      where variant_id = v_variant_id
      returning * into v_after;
      perform public.velura_append_module_audit(
        'products', v_actor.user_id, v_actor.admin_role::text, 'update', v_after.variant_id,
        to_jsonb(v_before),
        to_jsonb(v_after) || jsonb_build_object('reason', btrim(p_reason)),
        p_ip_address
      );
    end if;

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('success', true, 'count', v_count);
end;
$$;

revoke all on function public.velura_bulk_adjust_stock(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.velura_bulk_adjust_stock(uuid, jsonb, text, text) to authenticated;

notify pgrst, 'reload schema';
