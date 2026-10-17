-- Run only against a disposable migrated local/staging database with canonical seed data.
-- Every mutation is rolled back; use psql -v ON_ERROR_STOP=1 -f tests/api/catalog-content-db.sql.
begin;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare admin_id uuid; fixture public.product%rowtype; original public.product%rowtype; current_row public.product%rowtype;
 pid uuid:=gen_random_uuid(); batch jsonb; same_batch jsonb; work jsonb; draft_id uuid; d jsonb; c jsonb; src jsonb; quoted jsonb;
 metadata jsonb; result jsonb; failed boolean; regenerate jsonb; source_revision text;
begin
 select user_id into admin_id from public.users where role::text='admin' and admin_role::text='super_admin' and is_active limit 1;
 select * into fixture from public.product limit 1;
 if admin_id is null or fixture.product_id is null then raise exception 'Requires seeded active super_admin and product in disposable database'; end if;
 -- Clone a complete canonical row to avoid assumptions about required legacy columns.
 fixture.product_id:=pid; fixture.name:='SEO Regression '||pid::text; fixture.sku:='SEO-'||replace(pid::text,'-',''); fixture.slug:='seo-regression-'||pid::text;
 fixture.description:='Original live description'; fixture.seo_title:='Original live SEO '||pid::text; fixture.seo_description:='Original live meta'; fixture.version:=1;
 fixture.images:='{}'::text[];
 insert into public.product select fixture.*;
 select * into original from public.product where product_id=pid;
 src:=public.catalog_content_source(pid);
 quoted:=jsonb_build_object('text',fixture.name,'sources',jsonb_build_array(jsonb_build_object('field','name','quote',fixture.name)));
 c:=jsonb_build_object('title',quoted,'short',quoted,'long',quoted,'highlights','[]'::jsonb,'styling','[]'::jsonb,'care','[]'::jsonb,
   'seoTitle',quoted,'metaDescription',quoted,'proposedSlug',fixture.slug,'primaryKeywords',jsonb_build_array(quoted),'secondaryKeywords','[]'::jsonb,'alt','[]'::jsonb,'tags','[]'::jsonb);
 metadata:=jsonb_build_object('model','test','schema','catalog-extractive-v1','prompt','verified-catalog-v1','sourceRevision',src->>'revision');
 batch:=public.catalog_content_operation(admin_id,'enqueue',jsonb_build_object('idempotencyKey','seo-db-idempotency','products',jsonb_build_array(jsonb_build_object('productId',pid,'expectedVersion',1))));
 same_batch:=public.catalog_content_operation(admin_id,'enqueue',jsonb_build_object('idempotencyKey','seo-db-idempotency','products',jsonb_build_array(jsonb_build_object('productId',pid,'expectedVersion',1))));
 if batch->>'id'<>same_batch->>'id' then raise exception 'Idempotency created a second batch'; end if;
 failed:=false;
 begin perform public.catalog_content_operation(admin_id,'enqueue',jsonb_build_object('idempotencyKey','seo-db-idempotency','products',jsonb_build_array(jsonb_build_object('productId',pid,'expectedVersion',2)))); exception when sqlstate 'PT409' then failed:=true; end;
 if not failed then raise exception 'Changed retry payload did not conflict'; end if;
 update public.catalog_content_item set created_at='1970-01-01' where batch_id=(batch->>'id')::uuid;
 work:=public.catalog_content_operation(null,'claim');
 if work->>'id' is null or work->'source'->>'productId'<>pid::text then raise exception 'Did not claim isolated regression item'; end if;
 perform public.catalog_content_operation(admin_id,'finish',jsonb_build_object('id',work->>'id','lease',work->>'lease','generated',c,'metadata',metadata));
 draft_id:=(select i.draft_id from public.catalog_content_item i where i.id=(work->>'id')::uuid);
 select * into current_row from public.product where product_id=pid;
 if to_jsonb(current_row)<>to_jsonb(original) then raise exception 'Generation auto-published or altered live product'; end if;
 failed:=false;
 begin perform public.catalog_content_operation(admin_id,'publish',jsonb_build_object('id',draft_id,'expectedVersion',1,'expectedDraftVersion',1)); exception when sqlstate 'PT409' then failed:=true; end;
 if not failed then raise exception 'Unapproved draft was published'; end if;
 d:=public.catalog_content_operation(admin_id,'review',jsonb_build_object('id',draft_id,'expectedVersion',1,'decision','approve','content',c));
 select * into current_row from public.product where product_id=pid;
 if to_jsonb(current_row)<>to_jsonb(original) then raise exception 'Approval auto-published'; end if;
 -- A direct source change (including a writer that forgot to increment version) invalidates approval.
 update public.product set brand=coalesce(brand,'')||' changed' where product_id=pid;
 failed:=false;
 begin perform public.catalog_content_operation(admin_id,'publish',jsonb_build_object('id',draft_id,'expectedVersion',1,'expectedDraftVersion',2)); exception when sqlstate 'PT409' then failed:=true; end;
 if not failed then raise exception 'Stale source was published'; end if;
 update public.product set brand=original.brand where product_id=pid;
 failed:=false;
 begin perform public.catalog_content_operation(admin_id,'publish',jsonb_build_object('id',draft_id,'expectedVersion',1,'expectedDraftVersion',1)); exception when sqlstate 'PT409' then failed:=true; end;
 if not failed then raise exception 'Stale draft version was published'; end if;
 result:=public.catalog_content_operation(admin_id,'publish',jsonb_build_object('id',draft_id,'expectedVersion',1,'expectedDraftVersion',2));
 if result->>'status'<>'published' then raise exception 'Approved explicit publication did not complete'; end if;
 select * into current_row from public.product where product_id=pid;
 if current_row.description<>fixture.name or current_row.version<>2 then raise exception 'Approved content was not atomically published'; end if;
 if current_row.product_id<>original.product_id or current_row.name<>original.name or current_row.sku<>original.sku or current_row.base_price is distinct from original.base_price or current_row.sale_price is distinct from original.sale_price then raise exception 'Publication modified immutable commercial/identity data'; end if;
 failed:=false;
 begin update public.catalog_content_draft set source='{}' where id=draft_id; exception when sqlstate 'PT409' then failed:=true; end;
 if not failed then raise exception 'Draft provenance was mutable'; end if;
 -- Regeneration obtains a separate record and must preserve already published content.
 original:=current_row;
 regenerate:=public.catalog_content_operation(admin_id,'enqueue',jsonb_build_object('idempotencyKey','seo-db-regenerate','products',jsonb_build_array(jsonb_build_object('productId',pid,'expectedVersion',2))));
 update public.catalog_content_item set created_at='1970-01-01' where batch_id=(regenerate->>'id')::uuid;
 work:=public.catalog_content_operation(null,'claim');
 perform public.catalog_content_operation(admin_id,'finish',jsonb_build_object('id',work->>'id','lease',work->>'lease','generated',c,'metadata',metadata));
 select * into current_row from public.product where product_id=pid;
 if to_jsonb(current_row)<>to_jsonb(original) or (select count(*) from public.catalog_content_draft where product_id=pid)<>2 then raise exception 'Regeneration overwrote live content/history'; end if;
 -- Source version mismatch is a per-item finite failure, not a batch-wide exception.
 batch:=public.catalog_content_operation(admin_id,'enqueue',jsonb_build_object('idempotencyKey','seo-db-stale-item','products',jsonb_build_array(jsonb_build_object('productId',pid,'expectedVersion',1))));
 if batch->>'status'<>'complete' or batch->'items'->0->>'error'<>'SOURCE_VERSION_STALE' then raise exception 'Stale item not finite failure'; end if;
 failed:=false;
 begin perform public.catalog_content_operation(gen_random_uuid(),'draft',jsonb_build_object('id',draft_id)); exception when sqlstate 'PT403' then failed:=true; end;
 if not failed then raise exception 'Unknown actor accessed admin draft'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 failed:=false;
 begin perform public.catalog_content_operation(admin_id,'draft',jsonb_build_object('id',draft_id)); exception when sqlstate 'PT403' then failed:=true; end;
 if not failed then raise exception 'Authenticated actor forged service-role call'; end if;
end $$;
rollback;
