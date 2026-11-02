-- BA 3.1.10 AD_PRODUCT_06/18: CSV stock changes carry a system reason; AI image approvals are a distinct audit action.
-- Stock/threshold edits from the product form go through velura_bulk_adjust_stock (082) with a required reason.
begin;

create or replace function public.admin_import_product_csv(p_rows jsonb, p_ip_address text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare
  v_actor public.users%rowtype; r jsonb; p public.product%rowtype; v public.variant%rowtype;
  old_p public.product%rowtype; old_v public.variant%rowtype; result jsonb;
  results jsonb := '[]'::jsonb; created integer := 0; updated integer := 0;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or v_actor.is_active is not true
    or v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED'; end if;
  if jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 500 then raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) x group by upper(btrim(x->>'sku')) having count(*) > 1) then
    raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED';
  end if;
  -- Serialize imports; row locks/version checks still protect against all other editor/pricing workflows.
  perform pg_advisory_xact_lock(63015);
  for r in select value from jsonb_array_elements(p_rows) order by value->>'product_id', value->>'sku' loop
    if nullif(btrim(r->>'sku'), '') is null or length(btrim(r->>'name')) < 2
      or (r->>'base_price') is null or (r->>'base_price')::numeric < 0
      or (r->>'sale_price')::numeric < 0 or (r->>'stock_quantity')::integer < 0
      or (r->>'low_stock_threshold')::integer < 0 then
      raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED';
    end if;
    select * into v from public.variant where upper(btrim(sku)) = upper(btrim(r->>'sku')) for update;
    if v.variant_id is distinct from (r->>'variant_id')::uuid then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
    if v.variant_id is not null and v.version is distinct from (r->>'variant_version')::integer then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
    select * into p from public.product where product_id = coalesce(v.product_id, (r->>'product_id')::uuid) for update;
    if p.product_id is distinct from (r->>'product_id')::uuid then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
    if p.product_id is not null then
      if p.version is distinct from (r->>'expected_version')::integer then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
      if (r->>'base_price')::numeric is distinct from p.base_price or
        ((r->>'sale_price') is not null and (r->>'sale_price')::numeric is distinct from p.sale_price) then
        raise sqlstate 'PT422' using message = 'CSV_PRICE_CHANGE_FORBIDDEN';
      end if;
      if nullif(r->>'product_sku', '') is not null and upper(btrim(p.sku)) <> upper(btrim(r->>'product_sku')) then raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED'; end if;
      if v.variant_id is null and nullif(r->>'product_sku', '') is null and upper(btrim(p.sku)) <> upper(btrim(r->>'sku')) then raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED'; end if;
      if exists(select 1 from public.product where upper(btrim(sku)) = upper(btrim(r->>'sku')) and product_id <> p.product_id) then
        raise sqlstate 'PT422' using message = 'CSV_SKU_AMBIGUOUS';
      end if;
    elsif exists(select 1 from public.product where upper(btrim(sku)) = upper(btrim(r->>'sku'))) then
      raise sqlstate 'PT409' using message = 'SKU_DUPLICATE';
    end if;
    if nullif(r->>'image_url', '') is not null and (p.product_id is null or not (r->>'image_url' = any(p.images))) then
      raise sqlstate 'PT422' using message = 'CSV_IMAGE_REVIEW_REQUIRED';
    end if;
  end loop;
  for r in select value from jsonb_array_elements(p_rows) loop
    select * into p from public.product where product_id = (r->>'product_id')::uuid;
    if p.product_id is null then
      result := public.admin_create_product(
        p_sku => upper(btrim(r->>'sku')), p_name => r->>'name', p_slug => lower(r->>'sku'),
        p_description => r->>'description', p_category_id => (r->>'category_id')::uuid, p_brand => null,
        p_base_price => (r->>'base_price')::numeric, p_sale_price => coalesce((r->>'sale_price')::numeric, (r->>'base_price')::numeric),
        p_images => '{}'::text[], p_style_tags => '{}'::text[], p_color_tone => null, p_occasions => '{}'::text[], p_suitable_body_shapes => '{}'::text[],
        p_status => coalesce(r->>'status', 'hidden'), p_is_featured => coalesce((r->>'is_featured')::boolean, false), p_is_combo => false,
        p_collection => null, p_seo_title => null, p_seo_description => null, p_expected_version => 0, p_ip_address => p_ip_address,
        p_variants => jsonb_build_array(jsonb_build_object('sku', r->>'sku', 'color', coalesce(r->>'color', 'Mặc định'),
          'colorHex', r->>'color_hex', 'size', coalesce(r->>'size', 'F'), 'stockQuantity', coalesce((r->>'stock_quantity')::integer, 0),
          'lowStockThreshold', coalesce((r->>'low_stock_threshold')::integer, 5))));
      select * into p from public.product where product_id = (result->>'product_id')::uuid;
      select * into v from public.variant where product_id = p.product_id;
    else
      old_p := p;
      -- No existing price columns appear in this UPDATE, regardless of status or supplied/default CSV values.
      update public.product set name = r->>'name', category_id = (r->>'category_id')::uuid,
        description = coalesce(r->>'description', description), is_featured = coalesce((r->>'is_featured')::boolean, is_featured),
        version = version + 1, updated_at = now() where product_id = p.product_id returning * into p;
      perform public.velura_append_module_audit('products', v_actor.user_id, v_actor.admin_role::text, 'update', p.product_id, to_jsonb(old_p), to_jsonb(p), p_ip_address);
      select * into v from public.variant where variant_id = (r->>'variant_id')::uuid;
      if v.variant_id is null and nullif(r->>'product_sku', '') is not null then
        result := public.admin_create_variant(p.product_id, r->>'color', r->>'color_hex', r->>'size', null,
          coalesce((r->>'stock_quantity')::integer, 0), coalesce((r->>'low_stock_threshold')::integer, 5), p_ip_address, r->>'sku');
        select * into v from public.variant where variant_id = (result->>'variant_id')::uuid;
      elsif v.variant_id is not null and (r->>'color' is not null or r->>'size' is not null or r->>'color_hex' is not null
        or r->>'stock_quantity' is not null or r->>'low_stock_threshold' is not null) then
        old_v := v;
        if coalesce((r->>'stock_quantity')::integer, v.stock_quantity) < v.reserved_quantity then raise sqlstate 'PT422' using message = 'STOCK_UNDERFLOW'; end if;
        update public.variant set color = coalesce(r->>'color', color), size = coalesce(r->>'size', size),
          color_hex = coalesce(r->>'color_hex', color_hex), stock_quantity = coalesce((r->>'stock_quantity')::integer, stock_quantity),
          low_stock_threshold = coalesce((r->>'low_stock_threshold')::integer, low_stock_threshold), version = version + 1, updated_at = now()
        where variant_id = v.variant_id returning * into v;
        perform public.velura_append_module_audit('products', v_actor.user_id, v_actor.admin_role::text, 'update', v.variant_id, to_jsonb(old_v),
          case when old_v.stock_quantity is distinct from v.stock_quantity
            then to_jsonb(v) || jsonb_build_object('reason', coalesce(nullif(btrim(r->>'stock_reason'), ''), 'Nhập CSV'), 'source', 'csv_import')
            else to_jsonb(v) end, p_ip_address);
      end if;
      if r->>'status' is not null and r->>'status' <> p.status::text then
        perform public.admin_change_product_status(p.product_id, r->>'status', 'Cập nhật trạng thái qua CSV', p.version, p_ip_address);
      end if;
    end if;
    if r->>'operation' = 'created' then created := created + 1; else updated := updated + 1; end if;
    results := results || jsonb_build_array(jsonb_build_object('sku', r->>'sku', 'status', r->>'operation', 'product_id', p.product_id, 'variant_id', v.variant_id));
  end loop;
  return jsonb_build_object('created', created, 'updated', updated, 'failed', 0, 'total', jsonb_array_length(p_rows), 'results', results);
exception when others then
  if sqlstate in ('PT422', 'PT409', '23505', '23514', '23503', '22P02', '22003') then
    raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED',
      detail = jsonb_build_object('errors', jsonb_build_array(jsonb_build_object(
        'row', coalesce((r->>'row')::integer, 0),
        'field', case when sqlerrm = 'CSV_PRICE_CHANGE_FORBIDDEN' then 'base_price' else 'csv' end,
        'message', case when sqlerrm = 'CSV_PRICE_CHANGE_FORBIDDEN'
          then 'Giá hiện có đã thay đổi; CSV không được đổi giá. Tải lại bản xem trước.'
          else 'Dữ liệu catalog đã đổi hoặc dòng CSV không hợp lệ; chưa ghi dòng nào. Tải lại bản xem trước.' end,
        'code', sqlerrm)))::text;
  end if;
  raise;
end; $$;
revoke all on function public.admin_import_product_csv(jsonb, text) from public, anon;
grant execute on function public.admin_import_product_csv(jsonb, text) to authenticated;

create or replace function public.velura_stage_image_approval(
  p_approval_id uuid, p_actor_id uuid, p_product_id uuid, p_expected_version integer,
  p_job_id uuid, p_selection text, p_asset_url text, p_source_revision text, p_image_revision text,
  p_processing_version text, p_quality_gate jsonb, p_expires_at timestamptz, p_ip_address text
) returns uuid language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare
  v_actor public.users%rowtype;
  v_version integer;
begin
  select * into v_actor from public.users where user_id = p_actor_id;
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or v_actor.is_active is not true
    or v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if p_product_id is null then
    if p_expected_version is distinct from 0 then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  else
    select version into v_version from public.product where product_id = p_product_id for share;
    if v_version is null then raise sqlstate 'PT404' using message = 'PRODUCT_NOT_FOUND'; end if;
    if v_version is distinct from p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  end if;
  if p_quality_gate->'valid' is distinct from 'true'::jsonb
    or jsonb_typeof(p_quality_gate#>'{metrics,brightness}') is distinct from 'number'
    or jsonb_typeof(p_quality_gate#>'{metrics,sharpness}') is distinct from 'number'
    or jsonb_typeof(p_quality_gate#>'{metrics,background_score}') is distinct from 'number'
    or p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '24 hours 1 minute'
    or p_asset_url is null
    or p_asset_url !~ ('^https?://[^/]+/storage/v1/object/public/product-images/ai-reviewed/' || p_approval_id::text || '\.(png|jpg|webp)$') then
    raise sqlstate 'PT422' using message = 'INVALID_IMAGE_EVIDENCE';
  end if;
  insert into public.product_image_approval(
    approval_id, reviewer_id, product_id, expected_version, job_id, selection, asset_url,
    source_revision, image_revision, processing_version, quality_gate, expires_at, ip_address
  ) values (
    p_approval_id, p_actor_id, p_product_id, p_expected_version, p_job_id, p_selection, p_asset_url,
    lower(p_source_revision), lower(p_image_revision), p_processing_version, p_quality_gate, p_expires_at, p_ip_address
  );
  perform public.velura_append_module_audit('products', v_actor.user_id, v_actor.admin_role::text,
    'update', p_approval_id, null, jsonb_build_object('image_approval', 'staged', 'job_id', p_job_id,
      'product_id', p_product_id, 'expected_version', p_expected_version, 'selection', p_selection,
      'source_revision', p_source_revision, 'processing_version', p_processing_version,
      'ai_image_action', 'AI_IMAGE_APPLY', 'image_revision', lower(p_image_revision)), p_ip_address);
  return p_approval_id;
end;
$$;
revoke all on function public.velura_stage_image_approval(uuid,uuid,uuid,integer,uuid,text,text,text,text,text,jsonb,timestamptz,text) from public, anon, authenticated;
grant execute on function public.velura_stage_image_approval(uuid,uuid,uuid,integer,uuid,text,text,text,text,text,jsonb,timestamptz,text) to service_role;

create or replace function public.admin_list_product_audit_logs(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_product text default null,
  p_action_type text default null,
  p_user text default null,
  p_target_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  audit_id uuid,
  actor_id uuid,
  actor_role text,
  action text,
  module text,
  target_id uuid,
  old_value jsonb,
  new_value jsonb,
  ip_address text,
  "timestamp" timestamptz,
  action_type text,
  actor_name text,
  actor_email text,
  product_id uuid,
  product_sku text,
  product_name text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_type text := nullif(upper(btrim(p_action_type)), '');
  v_product text := nullif(btrim(p_product), '');
  v_user text := nullif(btrim(p_user), '');
  v_product_pattern text;
  v_user_pattern text;
begin
  if not public.velura_is_active_admin() then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if v_type is not null and v_type not in ('CREATE', 'UPDATE', 'UPDATE_STATUS', 'UPDATE_STOCK', 'AI_IMAGE_APPLY') then
    raise sqlstate 'PT422' using message = 'INVALID_AUDIT_ACTION';
  end if;
  if v_product is not null then
    v_product_pattern := '%' || replace(replace(replace(v_product, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  end if;
  if v_user is not null then
    v_user_pattern := '%' || replace(replace(replace(v_user, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  end if;

  return query
  with classified as (
    select
      a.audit_id as c_audit_id,
      a.actor_id as c_actor_id,
      a.actor_role::text as c_actor_role,
      a.action::text as c_action,
      a.module::text as c_module,
      a.target_id as c_target_id,
      a.old_value as c_old_value,
      a.new_value as c_new_value,
      a.ip_address::text as c_ip_address,
      a."timestamp"::timestamptz as c_ts,
      case
        when a.action::text = 'create' then 'CREATE'
        when (a.new_value->>'image_approval') is not null and (a.new_value->>'selection') is not null then 'AI_IMAGE_APPLY'
        when (a.old_value->>'status') is not null and (a.new_value->>'status') is not null
          and (a.old_value->>'status') is distinct from (a.new_value->>'status') then 'UPDATE_STATUS'
        when (a.old_value->>'stock_quantity') is not null and (a.new_value->>'stock_quantity') is not null
          and (a.old_value->>'stock_quantity') is distinct from (a.new_value->>'stock_quantity') then 'UPDATE_STOCK'
        else upper(a.action::text)
      end as c_type
    from public.audit_log a
    where a.module::text = 'products'
      and (p_target_id is null or a.target_id = p_target_id)
      and (p_from is null or a."timestamp"::timestamptz >= p_from)
      and (p_to is null or a."timestamp"::timestamptz <= p_to)
  ),
  enriched as (
    select
      c.*,
      u.full_name::text as e_actor_name,
      u.email::text as e_actor_email,
      coalesce(p.product_id, pv.product_id) as e_product_id,
      coalesce(p.sku, pv.sku)::text as e_product_sku,
      coalesce(p.name, pv.name)::text as e_product_name
    from classified c
    left join public.users u on u.user_id = c.c_actor_id
    left join public.product p on p.product_id = c.c_target_id
    left join public.variant v on v.variant_id = c.c_target_id
    left join public.product pv on pv.product_id = v.product_id
  )
  select
    e.c_audit_id, e.c_actor_id, e.c_actor_role, e.c_action, e.c_module, e.c_target_id,
    e.c_old_value, e.c_new_value, e.c_ip_address, e.c_ts, e.c_type,
    e.e_actor_name, e.e_actor_email, e.e_product_id, e.e_product_sku, e.e_product_name,
    count(*) over ()
  from enriched e
  where (v_type is null or e.c_type = v_type)
    and (v_product_pattern is null
      or e.e_product_name ilike v_product_pattern
      or e.e_product_sku ilike v_product_pattern
      or (e.c_new_value->>'name') ilike v_product_pattern
      or (e.c_old_value->>'name') ilike v_product_pattern)
    and (v_user_pattern is null
      or e.e_actor_name ilike v_user_pattern
      or e.e_actor_email ilike v_user_pattern
      or e.c_actor_id::text = v_user)
  order by e.c_ts desc, e.c_audit_id
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.admin_list_product_audit_logs(timestamptz, timestamptz, text, text, text, uuid, integer, integer) from public, anon;
grant execute on function public.admin_list_product_audit_logs(timestamptz, timestamptz, text, text, text, uuid, integer, integer) to authenticated;

commit;
