-- KAN-106: admin CMS cho nội dung blog. Requires 013 (blog/content_category/policy/static_page),
-- 002 (velura_append_module_audit), 006 (velura_has_admin_role), 001 (users, velura_current_user_id).
-- Read surface for policy/static_page stays public GET; writes for those kinds are intentionally
-- not added here because changing chính sách là quyết định pháp lý, không phải thao tác biên tập.
begin;

-- Phiên bản riêng và người sửa gần nhất: blog là bảng nội dung cũ, không có khoá lạc quan, nên
-- admin sửa bằng lệnh SQL trực tiếp sẽ ghi đè bản khác đang mở. Hai cột này thêm để RPC chặn
-- ghi đè và để dấu vết nói ai sửa lần cuối.
alter table public.blog add column if not exists version integer not null default 1;
alter table public.blog add column if not exists updated_by uuid references public.users(user_id) on delete set null;
create index if not exists blog_status_updated_idx on public.blog (status, updated_at desc);

-- Bảng chuyển trạng thái một chỗ: SQL chặn, TypeScript cùng bảng này quyết định nút hiển thị.
create or replace function public.velura_blog_transition_allowed(p_from text, p_to text)
returns boolean
language sql
stable
as $$
  select case
    when p_from = 'draft' then p_to in ('published', 'archived')
    when p_from = 'published' then p_to in ('draft', 'archived')
    when p_from = 'archived' then p_to = 'draft'
    else false
  end;
$$;

revoke all on function public.velura_blog_transition_allowed(text, text) from public, anon;
grant execute on function public.velura_blog_transition_allowed(text, text) to authenticated;

create or replace function public.admin_list_blogs(
  p_status text default null,
  p_q text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_rows jsonb;
  v_count bigint;
begin
  if not public.velura_is_active_admin() then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  select count(*) into v_count
  from public.blog b
  where (p_status is null or p_status = '' or b.status = p_status)
    and (p_q is null or p_q = '' or b.title ilike '%' || p_q || '%' or b.slug ilike '%' || p_q || '%' or b.excerpt ilike '%' || p_q || '%');

  select coalesce(jsonb_agg(row_to_json(b)::jsonb order by b.updated_at desc), '[]'::jsonb) into v_rows
  from (
    select * from public.blog
    where (p_status is null or p_status = '' or status = p_status)
      and (p_q is null or p_q = '' or title ilike '%' || p_q || '%' or slug ilike '%' || p_q || '%' or excerpt ilike '%' || p_q || '%')
    order by updated_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    offset greatest(coalesce(p_offset, 0), 0)
  ) b;

  return jsonb_build_object('rows', v_rows, 'count', v_count);
end;
$$;

create or replace function public.admin_upsert_blog(
  p_blog_id uuid,
  p_category_slug text,
  p_slug text,
  p_title text,
  p_excerpt text,
  p_content text,
  p_image_url text,
  p_author text,
  p_read_minutes integer,
  p_is_featured boolean,
  p_status text,
  p_expected_version integer,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor_role text;
  v_before public.blog%rowtype;
  v_after public.blog%rowtype;
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_status text := coalesce(nullif(btrim(coalesce(p_status, '')), ''), 'draft');
begin
  select u.admin_role::text into v_actor_role
  from public.users u
  where u.user_id = public.velura_current_user_id()
    and u.role::text = 'admin'
    and u.is_active;

  if v_actor_role is null or v_actor_role <> 'super_admin' then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,119}$' then
    raise sqlstate 'PT422' using message = 'BLOG_SLUG_INVALID';
  end if;
  if length(btrim(coalesce(p_title, ''))) < 4 or length(btrim(coalesce(p_title, ''))) > 180 then
    raise sqlstate 'PT422' using message = 'BLOG_TITLE_INVALID';
  end if;
  if length(btrim(coalesce(p_category_slug, ''))) = 0 then
    raise sqlstate 'PT422' using message = 'BLOG_CATEGORY_REQUIRED';
  end if;
  if not exists (select 1 from public.content_category c where c.content_type = 'blog' and c.slug = btrim(p_category_slug)) then
    raise sqlstate 'PT422' using message = 'BLOG_CATEGORY_NOT_FOUND';
  end if;
  if length(coalesce(p_excerpt, '')) > 500 then
    raise sqlstate 'PT422' using message = 'BLOG_EXCERPT_TOO_LONG';
  end if;
  if length(btrim(coalesce(p_content, ''))) < 40 then
    raise sqlstate 'PT422' using message = 'BLOG_CONTENT_TOO_SHORT';
  end if;
  if p_image_url is not null and btrim(p_image_url) <> ''
     and p_image_url !~ '^https://' and p_image_url !~ '^/assets/' then
    raise sqlstate 'PT422' using message = 'BLOG_IMAGE_URL_INVALID';
  end if;
  if coalesce(p_read_minutes, 5) not between 1 and 60 then
    raise sqlstate 'PT422' using message = 'BLOG_READ_MINUTES_INVALID';
  end if;
  if v_status not in ('draft', 'published', 'archived') then
    raise sqlstate 'PT422' using message = 'BLOG_STATUS_INVALID';
  end if;

  if p_blog_id is null then
    if exists (select 1 from public.blog b where b.slug = v_slug) then
      raise sqlstate 'PT409' using message = 'BLOG_SLUG_TAKEN';
    end if;
    -- Bản mới chỉ là nháp hoặc bài đã công bố; "archived" là trạng thái của bài từng tồn tại.
    if v_status = 'archived' then
      raise sqlstate 'PT422' using message = 'BLOG_CREATE_STATUS_INVALID';
    end if;

    insert into public.blog (
      category_slug, slug, title, excerpt, content, image_url, author, read_minutes,
      is_featured, status, published_at, version, updated_by
    ) values (
      btrim(p_category_slug), v_slug, btrim(p_title), coalesce(p_excerpt, ''), p_content,
      nullif(btrim(coalesce(p_image_url, '')), ''), coalesce(nullif(btrim(coalesce(p_author, '')), ''), 'Velura Editorial'),
      coalesce(p_read_minutes, 5), coalesce(p_is_featured, false), v_status, now(), 1, public.velura_current_user_id()
    ) returning * into v_after;

    perform public.velura_append_module_audit(
      'content', public.velura_current_user_id(), v_actor_role, 'create', v_after.blog_id,
      '{}'::jsonb,
      jsonb_build_object('slug', v_after.slug, 'status', v_after.status, 'version', v_after.version),
      p_ip_address
    );
    return to_jsonb(v_after);
  end if;

  select * into v_before from public.blog where blog_id = p_blog_id for update;
  if v_before.blog_id is null then
    raise sqlstate 'PT404' using message = 'BLOG_NOT_FOUND';
  end if;
  if v_before.version <> coalesce(p_expected_version, -1) then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;
  if v_slug <> v_before.slug and exists (select 1 from public.blog b where b.slug = v_slug) then
    raise sqlstate 'PT409' using message = 'BLOG_SLUG_TAKEN';
  end if;
  if not public.velura_blog_transition_allowed(v_before.status, v_status) then
    raise sqlstate 'PT422' using message = 'BLOG_TRANSITION_DENIED';
  end if;

  update public.blog
  set category_slug = btrim(p_category_slug),
      slug = v_slug,
      title = btrim(p_title),
      excerpt = coalesce(p_excerpt, ''),
      content = p_content,
      image_url = nullif(btrim(coalesce(p_image_url, '')), ''),
      author = coalesce(nullif(btrim(coalesce(p_author, '')), ''), 'Velura Editorial'),
      read_minutes = coalesce(p_read_minutes, 5),
      is_featured = coalesce(p_is_featured, false),
      status = v_status,
      published_at = case
        when v_before.status <> 'published' and v_status = 'published' then now()
        else v_before.published_at
      end,
      version = v_before.version + 1,
      updated_by = public.velura_current_user_id(),
      updated_at = now()
  where blog_id = p_blog_id
  returning * into v_after;

  perform public.velura_append_module_audit(
    'content', public.velura_current_user_id(), v_actor_role, 'update', v_after.blog_id,
    jsonb_build_object('status', v_before.status, 'slug', v_before.slug, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'slug', v_after.slug, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

revoke all on function public.admin_list_blogs(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_upsert_blog(
  uuid, text, text, text, text, text, text, text, integer, boolean, text, integer, text
) from public, anon, authenticated;
grant execute on function public.admin_list_blogs(text, text, integer, integer) to authenticated;
grant execute on function public.admin_upsert_blog(
  uuid, text, text, text, text, text, text, text, integer, boolean, text, integer, text
) to authenticated;

comment on function public.admin_upsert_blog(uuid, text, text, text, text, text, text, text, integer, boolean, text, integer, text) is
  'Biên tập blog có kiểm soát: slug chuẩn, danh mục thật tồn tại, chuyển trạng thái theo bảng quy tắc, audit module content.';
comment on function public.velura_blog_transition_allowed(text, text) is
  'Bảng chuyển trạng thái nội dung: draft/published/archived; archived chỉ quay về draft để biên tập lại.';

commit;
