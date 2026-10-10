-- Run only against a disposable/local Supabase database after migration 051; all fixtures and constraints roll back.
\set ON_ERROR_STOP on
begin;

insert into public.users(user_id, email, full_name, role, admin_role, is_active) values
 ('51000000-0000-4000-8000-000000000001', 'image-reviewer@example.invalid', 'Image reviewer', 'admin', 'admin_operator_sanpham', true),
 ('51000000-0000-4000-8000-000000000002', 'image-owner@example.invalid', 'Other reviewer', 'admin', 'super_admin', true),
 ('51000000-0000-4000-8000-000000000003', 'image-viewer@example.invalid', 'Viewer', 'admin', 'admin_viewer', true),
 ('51000000-0000-4000-8000-000000000004', 'image-inactive@example.invalid', 'Inactive reviewer', 'admin', 'super_admin', false);
insert into public.category(category_id, name, slug) values
 ('51000000-0000-4000-8000-000000000010', 'Image test', 'image-review-test');
select set_config('request.jwt.claim.sub', '51000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"51000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

create function pg_temp.save_images(p_id uuid, p_version integer, p_images text[], p_name text default null)
returns jsonb language sql as $$
 select public.admin_update_product(p_id, p_name, null, null, null, null, null, p_images,
   null, null, null, null, null, null, null, null, null, null, p_version, '127.0.0.1');
$$;

alter table public.product add constraint image_review_test_after_trigger check (name <> 'force-review-save-failure');

do $$
declare
  v_actor uuid := '51000000-0000-4000-8000-000000000001';
  v_original uuid := '51000000-0000-4000-8000-000000000020';
  v_enhanced uuid := '51000000-0000-4000-8000-000000000021';
  v_other uuid := '51000000-0000-4000-8000-000000000022';
  v_job uuid := '51000000-0000-4000-8000-000000000030';
  v_url text := 'https://storage.example/storage/v1/object/public/product-images/ai-reviewed/51000000-0000-4000-8000-000000000020.png';
  v_output text := 'https://storage.example/storage/v1/object/public/product-images/ai-reviewed/51000000-0000-4000-8000-000000000021.png';
  v_quality jsonb := '{"valid":true,"metrics":{"brightness":120,"sharpness":40,"background_score":0.8}}';
  v_product jsonb;
  v_id uuid;
  v_before integer;
begin
  if has_function_privilege('authenticated', 'public.velura_stage_image_approval(uuid,uuid,uuid,integer,uuid,text,text,text,text,text,jsonb,timestamptz,text)', 'EXECUTE') then
    raise exception 'An authenticated browser can forge worker evidence';
  end if;
  if has_table_privilege('authenticated', 'public.product_image_approval', 'INSERT,UPDATE,DELETE') then
    raise exception 'An authenticated browser can forge or consume approvals';
  end if;
  perform public.velura_stage_image_approval(v_original, v_actor, null, 0, v_job, 'original', v_url,
    repeat('a',64), repeat('a',64), 'cpu-quality-v2', v_quality, now()+interval '1 hour', '127.0.0.1');
  if exists(select 1 from public.product where v_url = any(images)) then raise exception 'Approval auto-published an image'; end if;

  v_product := public.admin_create_product('VL-REVIEW001', 'Review test', 'review-test', null,
    '51000000-0000-4000-8000-000000000010', null, 100, 100, array[v_url], '{}', null, '{}', '{}',
    'hidden', false, false, null, null, null, 0, '127.0.0.1');
  v_id := (v_product->>'product_id')::uuid;
  if not exists(select 1 from public.product_image_approval where approval_id=v_original and consumed_product_id=v_id
    and consumed_product_version=1 and consumed_image_revision=1) then raise exception 'Create did not atomically consume original review'; end if;

  perform public.velura_stage_image_approval(v_enhanced, v_actor, v_id, 1, v_job, 'enhanced', v_output,
    repeat('a',64), repeat('b',64), 'rembg-photometric-v2', v_quality, now()+interval '1 hour', '127.0.0.1');
  if (select images from public.product where product_id=v_id) is distinct from array[v_url] then raise exception 'Enhancement approval changed published original'; end if;

  -- Force a real table constraint failure AFTER the production BEFORE trigger attempted consumption.
  begin
    perform pg_temp.save_images(v_id, 1, array[v_output], 'force-review-save-failure');
    raise exception 'Expected constraint failure';
  exception when check_violation then null;
  end;
  if (select images from public.product where product_id=v_id) is distinct from array[v_url] then raise exception 'Failed save replaced published original'; end if;
  if (select consumed_at from public.product_image_approval where approval_id=v_enhanced) is not null then raise exception 'Failed save consumed approval'; end if;

  -- Another allowed reviewer cannot publish an image approved by the first reviewer.
  perform set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000002',true);
  perform set_config('request.jwt.claims','{"sub":"51000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
  begin
    perform pg_temp.save_images(v_id,1,array[v_output]);
    raise exception 'Expected reviewer ownership rejection';
  exception when sqlstate 'PT422' then null;
  end;
  perform set_config('request.jwt.claim.sub',v_actor::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,true);

  -- Old images stay untouched while a metadata save wins the next product version.
  select image_revision into v_before from public.product where product_id=v_id;
  perform pg_temp.save_images(v_id,1,array[v_url], 'Changed metadata only');
  if (select image_revision from public.product where product_id=v_id) <> v_before then raise exception 'Unchanged image got another revision'; end if;
  begin
    perform pg_temp.save_images(v_id,1,array[v_output]);
    raise exception 'Expected optimistic locking rejection';
  exception when sqlstate 'PT409' then null;
  end;
  begin
    perform pg_temp.save_images(v_id,2,array[v_output]);
    raise exception 'Expected stale approval rejection';
  exception when sqlstate 'PT409' then null;
  end;
  if (select images from public.product where product_id=v_id) is distinct from array[v_url] then raise exception 'Stale approval replaced original'; end if;

  -- Review the same source against the new version, then publish precisely that selection.
  delete from public.product_image_approval where approval_id=v_enhanced;
  perform public.velura_stage_image_approval(v_enhanced, v_actor, v_id, 2, v_job, 'enhanced', v_output,
    repeat('a',64), repeat('b',64), 'rembg-photometric-v2', v_quality, now()+interval '1 hour', '127.0.0.1');
  perform pg_temp.save_images(v_id,2,array[v_output]);
  if (select images from public.product where product_id=v_id) is distinct from array[v_output] then raise exception 'Save did not publish selected validated asset'; end if;
  if not exists(select 1 from public.product_image_approval where approval_id=v_enhanced and consumed_product_version=3
    and consumed_image_revision=2 and reviewer_id=v_actor) then raise exception 'Published revision/reviewer missing'; end if;
  if not exists(select 1 from public.audit_log where target_id=v_id and new_value->>'image_approval'=v_enhanced::text) then raise exception 'Image publication audit missing'; end if;

  begin
    perform pg_temp.save_images(v_id,3,array['https://storage.example/unreviewed.png']);
    raise exception 'Expected unvalidated replacement rejection';
  exception when sqlstate 'PT422' then null;
  end;
  begin
    perform public.velura_stage_image_approval(v_other,'51000000-0000-4000-8000-000000000003',v_id,3,v_job,'original',v_url,
      repeat('a',64),repeat('a',64),'cpu-quality-v2',v_quality,now()+interval '1 hour','127.0.0.1');
    raise exception 'Expected nonproduct role rejection';
  exception when sqlstate 'PT403' then null;
  end;
  begin
    perform public.velura_stage_image_approval(v_other,'51000000-0000-4000-8000-000000000004',v_id,3,v_job,'original',v_url,
      repeat('a',64),repeat('a',64),'cpu-quality-v2',v_quality,now()+interval '1 hour','127.0.0.1');
    raise exception 'Expected inactive administrator rejection';
  exception when sqlstate 'PT403' then null;
  end;
  perform set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000003',true);
  perform set_config('request.jwt.claims','{"sub":"51000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
  begin
    perform pg_temp.save_images(v_id,3,array[v_output]);
    raise exception 'Expected product mutation role rejection';
  exception when sqlstate 'PT403' then null;
  end;
end;
$$;
rollback;
