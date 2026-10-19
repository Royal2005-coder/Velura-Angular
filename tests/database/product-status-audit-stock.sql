-- KAN-105 UAT 3.1.10 (AD_PRODUCT_14, Nhật ký sản phẩm, TH6 low stock).
-- Disposable/local database only, after migrations 062-066. Every mutation rolls back.
\set ON_ERROR_STOP on
begin;
insert into public.users(user_id,email,full_name,role,admin_role,is_active) values
('66000000-0000-4000-8000-000000000001','catalog-uat@example.invalid','Catalog UAT','admin','admin_operator_sanpham',true);
insert into public.category(category_id,name,slug) values
('66000000-0000-4000-8000-000000000010','Catalog UAT','catalog-uat-3110');
select set_config('request.jwt.claim.sub','66000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"66000000-0000-4000-8000-000000000001","role":"authenticated"}',true);

do $$
declare
  v_actor uuid := '66000000-0000-4000-8000-000000000001';
  v_approval uuid := '66000000-0000-4000-8000-000000000020';
  v_url text := 'https://storage.example/storage/v1/object/public/product-images/ai-reviewed/66000000-0000-4000-8000-000000000020.png';
  v_product jsonb;
  v_before_identity jsonb;
  v_variants jsonb;
  v_current_variants jsonb;
  v_id uuid;
  v_black uuid;
  v_version integer;
  v_status text;
  v_count integer;
  v_row record;
begin
  perform public.velura_stage_image_approval(v_approval,v_actor,null,0,'66000000-0000-4000-8000-000000000030',
    'original',v_url,repeat('a',64),repeat('a',64),'cpu-quality-v2',
    '{"valid":true,"metrics":{"brightness":120,"sharpness":40,"background_score":0.8}}',now()+interval '1 hour','127.0.0.1');
  v_product := public.admin_create_product('VL-UAT19','Áo Premium Cotton 100%','catalog-uat-premium-cotton',null,
    '66000000-0000-4000-8000-000000000010',null,250000,250000,array[v_url],'{}',null,'{}','{}',
    'on_sale',false,false,null,null,null,0,'127.0.0.1','{}',
    '[{"sku":"VL-UAT19-DEN","color":"Đen","size":"M","stockQuantity":50,"lowStockThreshold":5},
      {"sku":"VL-UAT19-TRANG","color":"Trắng","size":"M","stockQuantity":30,"lowStockThreshold":5}]');
  v_id := (v_product->>'product_id')::uuid;
  v_version := (v_product->>'version')::integer;
  v_before_identity := v_product - array['status','version','updated_at'];
  select jsonb_agg(to_jsonb(v) order by v.variant_id) into v_variants from public.variant v where product_id=v_id;
  select variant_id into v_black from public.variant where product_id=v_id and color='Đen';

  -- AD_PRODUCT_14: Hidden -> Discontinued -> Active never changes variant stock, SKU or price.
  foreach v_status in array array['hidden','discontinued','on_sale'] loop
    v_product := public.admin_change_product_status(v_id,v_status,'Chu kỳ trạng thái UAT AD_PRODUCT_14',v_version,'127.0.0.1');
    v_version := v_version + 1;
    if v_product->>'status' <> v_status or (v_product->>'version')::integer <> v_version then
      raise exception 'Status % was not applied in one versioned write', v_status;
    end if;
    if (v_product - array['status','version','updated_at']) is distinct from v_before_identity then
      raise exception 'Status % changed SKU, price or other product fields', v_status;
    end if;
    select jsonb_agg(to_jsonb(v) order by v.variant_id) into v_current_variants from public.variant v where product_id=v_id;
    if v_current_variants is distinct from v_variants then raise exception 'Status % mutated variant rows', v_status; end if;
  end loop;
  if (select stock_quantity from public.variant where product_id=v_id and color='Đen') <> 50
    or (select stock_quantity from public.variant where product_id=v_id and color='Trắng') <> 30 then
    raise exception 'Đen=50 / Trắng=30 changed after the status cycle';
  end if;

  -- Discontinued can be reactivated into every other status (UAT 3.1.10-01).
  foreach v_status in array array['discontinued','hidden','discontinued','out_of_stock','discontinued','on_sale'] loop
    v_product := public.admin_change_product_status(v_id,v_status,'Kiểm tra chuyển trạng thái từ Ngừng kinh doanh',v_version,'127.0.0.1');
    v_version := v_version + 1;
  end loop;

  -- Audit: every status change stores the reason and is filterable by action type, product, user and date range.
  select count(*) into v_count from public.admin_list_product_audit_logs(
    p_action_type => 'UPDATE_STATUS', p_target_id => v_id);
  if v_count <> 9 then raise exception 'Expected 9 UPDATE_STATUS audit rows, found %', v_count; end if;
  select * into v_row from public.admin_list_product_audit_logs(p_action_type => 'UPDATE_STATUS', p_target_id => v_id) limit 1;
  if v_row.new_value->>'reason' is null or v_row.actor_email <> 'catalog-uat@example.invalid' or v_row.product_sku <> 'VL-UAT19' then
    raise exception 'Audit row lacks reason, actor email or product SKU: %', to_jsonb(v_row);
  end if;

  -- TH6: stock can be adjusted below the threshold; the audit row is UPDATE_STOCK with the reason.
  perform public.admin_update_stock(v_id,v_black,-47,'Kiểm kê giảm tồn xuống dưới ngưỡng',
    (select version from public.variant where variant_id=v_black),'127.0.0.1');
  if (select stock_quantity from public.variant where variant_id=v_black) <> 3 then raise exception 'Stock below threshold was not applied'; end if;
  if not exists(select 1 from public.admin_list_low_stock(500) where variant_id=v_black) then
    raise exception 'Variant below threshold is missing from the low-stock list';
  end if;
  select count(*) into v_count from public.admin_list_product_audit_logs(p_action_type => 'update_stock', p_product => 'cotton 100%');
  if v_count <> 1 then raise exception 'UPDATE_STOCK filter by product name returned % rows', v_count; end if;
  select * into v_row from public.admin_list_product_audit_logs(p_action_type => 'UPDATE_STOCK', p_user => 'catalog-uat@') limit 1;
  if v_row.new_value->>'reason' <> 'Kiểm kê giảm tồn xuống dưới ngưỡng' then raise exception 'Stock reason missing from audit: %', to_jsonb(v_row); end if;
  begin
    perform public.admin_update_stock(v_id,v_black,-4,'Xuất âm tồn kho không hợp lệ',
      (select version from public.variant where variant_id=v_black),'127.0.0.1');
    raise exception 'Negative stock was accepted';
  exception when sqlstate 'PT422' then null;
  end;

  -- Date range and wildcard-safe product search; a range in the future matches nothing.
  select count(*) into v_count from public.admin_list_product_audit_logs(
    p_from => now() - interval '1 day', p_to => now() + interval '1 day', p_target_id => v_id);
  if v_count < 10 then raise exception 'Date range returned % rows, expected at least the create + 9 status audits', v_count; end if;
  if exists(select 1 from public.admin_list_product_audit_logs(p_from => now() + interval '1 day')) then raise exception 'Future range matched rows'; end if;
  if exists(select 1 from public.admin_list_product_audit_logs(p_product => '100%x')) then raise exception '% acted as a wildcard'; end if;
  begin
    perform public.admin_list_product_audit_logs(p_action_type => 'DROP');
    raise exception 'Unknown action type accepted';
  exception when sqlstate 'PT422' then null;
  end;
end;
$$;
rollback;
