-- KAN-106: nền loyalty thật của production + phân hệ "Thành viên & điểm" cho admin ERP.
--
-- Vì sao cần migration này:
--   * 061/073 chạy trên mô hình legacy `loyalty_account/loyalty_ledger/referral/member_voucher`
--     nhưng bốn bảng đó chỉ tồn tại trong database production, không có định nghĩa nào trong Git.
--     Một môi trường dựng từ migrations vì vậy không thể chạy thưởng điểm, không thể đối soát.
--   * 073 định nghĩa `velura_loyalty_return_trigger` nhưng không attach trigger nào, nên clawback
--     theo hàng trả không bao giờ chạy. Production đang có 11 return REFUNDED/COMPLETED và 0 bút toán
--     'clawback' dù hai đơn trong đó đã từng cộng 38.000 và 52.900 điểm.
--
-- Nguyên tắc:
--   1. Bảng: `create table if not exists` đúng như đang chạy — production không đổi gì.
--   2. Hàm tiền đang tồn tại ngoài Git (`velura_ensure_loyalty_account`, `velura_complete_referral`)
--      chỉ được định nghĩa khi CHƯA tồn tại. Không bao giờ `create or replace` body mà mình chưa đọc được.
--      Định nghĩa dự phòng bên dưới chỉ để môi trường mới không chết ở runtime, và được test pin lại.
--   3. Trigger thưởng/clawback chỉ attach khi chưa có trigger nào gọi hàm tương ứng. Hàm award idempotent
--      theo (order_id, kind='earn') và clawback idempotent theo (return_id, kind='clawback'), nên nếu môi
--      trường nào đã có đường gọi khác thì việc attach thêm cũng không cộng/trừ hai lần.
--   4. RPC admin chỉ đọc + khoá tích luỹ có lý do. Không có RPC sửa số dư: điều chỉnh điểm là quyết định
--      tiền, phải có phê duyệt riêng, không phải một nút bấm trong màn hình vận hành.
begin;

-- ---------------------------------------------------------------------------
-- 1. Baseline của mô hình legacy — tái tạo đúng cột production đang có.
-- ---------------------------------------------------------------------------

create table if not exists public.loyalty_account (
  user_id uuid primary key references public.users(user_id),
  balance_milli_points bigint not null default 0,
  debt_milli_points bigint not null default 0,
  warning_flags smallint not null default 0,
  accrual_locked boolean not null default false,
  referral_code varchar not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.loyalty_ledger (
  ledger_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id),
  order_id uuid references public.orders(order_id),
  return_id uuid references public.return_exchange(return_id),
  kind varchar not null,
  amount_milli_points bigint not null,
  balance_after_milli_points bigint not null,
  expires_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.referral (
  referral_id uuid primary key default gen_random_uuid(),
  referrer_user_id uuid not null references public.users(user_id),
  referred_user_id uuid not null references public.users(user_id),
  qualifying_order_id uuid references public.orders(order_id),
  status varchar not null default 'pending',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  reversed_at timestamptz
);

create table if not exists public.member_voucher (
  member_voucher_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id),
  voucher_id uuid not null references public.voucher(voucher_id),
  referral_id uuid references public.referral(referral_id),
  benefit varchar not null,
  status varchar not null default 'available',
  issued_at timestamptz not null default now(),
  used_order_id uuid references public.orders(order_id),
  revoked_at timestamptz
);

-- ---------------------------------------------------------------------------
-- 2. Hai hàm tiền thiếu định nghĩa trong Git — chỉ tạo khi chưa có.
-- ---------------------------------------------------------------------------

do $ensure$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'velura_ensure_loyalty_account'
  ) then
    execute $ddl$
      create function public.velura_ensure_loyalty_account(p_user_id uuid)
      returns public.loyalty_account
      language plpgsql
      security definer
      set search_path = pg_catalog, public
      as $fn$
      declare
        v_account public.loyalty_account;
      begin
        insert into public.loyalty_account(user_id, referral_code)
        values (p_user_id, 'VLR' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)))
        on conflict (user_id) do nothing;
        select * into v_account from public.loyalty_account where user_id = p_user_id;
        return v_account;
      end;
      $fn$;
    $ddl$;
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'velura_complete_referral'
  ) then
    -- Định nghĩa dự phòng: đơn đủ điều kiện = đơn đã giao của người được giới thiệu. Thưởng cho người
    -- giới thiệu đúng một voucher, cùng hình dạng ưu đãi giới thiệu đang dùng (20%, tối đa 500k, đơn từ 1M).
    execute $ddl$
      create function public.velura_complete_referral(p_user_id uuid, p_order_id uuid)
      returns void
      language plpgsql
      security definer
      set search_path = pg_catalog, public
      as $fn$
      declare
        v_referral public.referral%rowtype;
        v_code text;
        v_voucher uuid;
      begin
        select * into v_referral from public.referral
        where referred_user_id = p_user_id and status = 'pending'
        order by created_at limit 1 for update;
        if not found then
          return;
        end if;
        if not exists (
          select 1 from public.orders
          where order_id = p_order_id and user_id = p_user_id and status::text = 'delivered'
        ) then
          raise sqlstate 'PT409' using message = 'REFERRAL_ORDER_NOT_DELIVERED';
        end if;
        update public.referral
        set status = 'successful', qualifying_order_id = p_order_id, completed_at = now()
        where referral_id = v_referral.referral_id;
        if exists (
          select 1 from public.member_voucher
          where referral_id = v_referral.referral_id and benefit = 'referrer_reward'
        ) then
          return;
        end if;
        v_code := 'REF' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 24));
        insert into public.voucher(code, name, discount_type, discount_value, max_discount_amount,
          min_order_value, usage_limit_total, usage_limit_per_user, applicable_user_group,
          start_date, end_date, is_active, created_by, reward_member_id)
        values (v_code, 'Ưu đãi giới thiệu thành viên', 'percentage', 20, 500000, 1000000, 1, 1,
          'all_users', now(), now() + interval '60 days', true, v_referral.referrer_user_id,
          v_referral.referrer_user_id)
        returning voucher_id into v_voucher;
        insert into public.member_voucher(user_id, voucher_id, referral_id, benefit)
        values (v_referral.referrer_user_id, v_voucher, v_referral.referral_id, 'referrer_reward');
      end;
      $fn$;
    $ddl$;
  end if;
end;
$ensure$;

-- ---------------------------------------------------------------------------
-- 3. Attach đường thưởng & clawback — chỉ khi chưa có trigger nào gọi hàm tương ứng.
-- ---------------------------------------------------------------------------

create or replace function public.velura_loyalty_award_trigger()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.status::text = 'delivered' and old.status::text is distinct from new.status::text then
    perform public.velura_award_order_loyalty(new.order_id);
  end if;
  return new;
end; $$;

create or replace function public.velura_loyalty_clawback_trigger()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.status::text in ('completed', 'COMPLETED', 'refunded', 'REFUNDED')
     and old.status::text is distinct from new.status::text then
    perform public.velura_adjust_loyalty_for_return(new.return_id);
  end if;
  return new;
end; $$;

do $triggers$
begin
  if not exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal
      and p.proname in ('velura_loyalty_award_trigger', 'velura_award_order_loyalty')
  ) then
    execute 'create trigger loyalty_order_award after update of status on public.orders '
         || 'for each row execute function public.velura_loyalty_award_trigger()';
  end if;

  if not exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal
      and p.proname in ('velura_loyalty_clawback_trigger', 'velura_loyalty_return_trigger', 'velura_adjust_loyalty_for_return')
  ) then
    execute 'create trigger loyalty_return_clawback after update of status on public.return_exchange '
         || 'for each row execute function public.velura_loyalty_clawback_trigger()';
  end if;
end;
$triggers$;

revoke all on function public.velura_loyalty_award_trigger() from public, anon, authenticated;
revoke all on function public.velura_loyalty_clawback_trigger() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. RPC admin cho phân hệ members.
-- ---------------------------------------------------------------------------

-- Tổng quan đầu trang: chỉ đếm từ ví và ledger thật. `users.loyalty_points`/`users.tier` của production
-- toàn số 0/'Standard' dù ví đang giữ điểm, nên không được dùng làm nguồn sự thật.
create or replace function public.admin_member_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.velura_is_active_admin() then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  return jsonb_build_object(
    'members', (select count(*) from public.users where role::text = 'member'),
    'with_wallet', (select count(*) from public.loyalty_account),
    'total_points_milli', (select coalesce(sum(balance_milli_points - debt_milli_points), 0) from public.loyalty_account),
    'negative_accounts', (select count(*) from public.loyalty_account where balance_milli_points < debt_milli_points),
    'locked_accounts', (select count(*) from public.loyalty_account where accrual_locked),
    'flagged_accounts', (select count(*) from public.loyalty_account where warning_flags > 0),
    'referrals_pending', (select count(*) from public.referral where status = 'pending'),
    'referrals_successful', (select count(*) from public.referral where status = 'successful'),
    'vouchers_available', (select count(*) from public.member_voucher where status = 'available'),
    'ledger_entries', (select count(*) from public.loyalty_ledger),
    'zero_entries', (select count(*) from public.loyalty_ledger where amount_milli_points = 0),
    'earliest_expiry', (select min(expires_at) from public.loyalty_ledger where kind = 'earn' and expires_at > now()),
    'last_ledger_at', (select max(created_at) from public.loyalty_ledger)
  );
end;
$$;

create or replace function public.admin_list_members(
  p_q text default null,
  p_wallet text default 'all',
  p_sort text default 'balance',
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
  v_count bigint;
  v_rows jsonb;
  v_wallet text := coalesce(nullif(btrim(p_wallet), ''), 'all');
  v_sort text := coalesce(nullif(btrim(p_sort), ''), 'balance');
begin
  if not public.velura_is_active_admin() then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if v_wallet not in ('all', 'has', 'none', 'negative', 'locked') then
    raise sqlstate 'PT422' using message = 'MEMBER_FILTER_INVALID';
  end if;
  if v_sort not in ('balance', 'name', 'recent') then
    raise sqlstate 'PT422' using message = 'MEMBER_SORT_INVALID';
  end if;

  with base as (
    select
      u.user_id,
      u.full_name,
      u.email,
      u.phone,
      u.is_active,
      u.created_at,
      a.user_id is not null as wallet_exists,
      coalesce(a.balance_milli_points, 0) as balance_milli_points,
      coalesce(a.debt_milli_points, 0) as debt_milli_points,
      coalesce(a.accrual_locked, false) as accrual_locked,
      coalesce(a.warning_flags, 0) as warning_flags,
      a.referral_code,
      a.updated_at as account_updated_at,
      (select count(*) from public.loyalty_ledger l where l.user_id = u.user_id) as ledger_entries,
      (select max(l.created_at) from public.loyalty_ledger l where l.user_id = u.user_id) as last_ledger_at,
      (select count(*) from public.referral r
        where r.referrer_user_id = u.user_id or r.referred_user_id = u.user_id) as referrals,
      (select count(*) from public.member_voucher mv where mv.user_id = u.user_id and mv.status = 'available') as vouchers_available
    from public.users u
    left join public.loyalty_account a on a.user_id = u.user_id
    where u.role::text = 'member'
      and (
        p_q is null or btrim(p_q) = ''
        or u.full_name ilike '%' || btrim(p_q) || '%'
        or coalesce(u.email, '') ilike '%' || btrim(p_q) || '%'
        or coalesce(u.phone, '') ilike '%' || btrim(p_q) || '%'
        or coalesce(a.referral_code, '') ilike '%' || btrim(p_q) || '%'
      )
  ),
  filtered as (
    select *
    from base
    where case v_wallet
      when 'has' then wallet_exists
      when 'none' then not wallet_exists
      when 'negative' then balance_milli_points < debt_milli_points
      when 'locked' then accrual_locked
      else true
    end
  ),
  page as (
    select *
    from filtered
    order by
      case when v_sort = 'balance' then (balance_milli_points - debt_milli_points) end desc nulls last,
      case when v_sort = 'name' then full_name end asc nulls last,
      case when v_sort = 'recent' then last_ledger_at end desc nulls last,
      full_name asc nulls last,
      user_id
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select
    (select count(*) from filtered),
    (select coalesce(jsonb_agg(row_to_json(page)::jsonb), '[]'::jsonb) from page)
  into v_count, v_rows;

  return jsonb_build_object('rows', v_rows, 'count', v_count);
end;
$$;

create or replace function public.admin_member_detail(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user public.users%rowtype;
  v_account public.loyalty_account%rowtype;
begin
  if not public.velura_is_active_admin() then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  select * into v_user from public.users where user_id = p_user_id and role::text = 'member';
  if not found then
    raise sqlstate 'PT404' using message = 'MEMBER_NOT_FOUND';
  end if;
  select * into v_account from public.loyalty_account where user_id = p_user_id;

  return jsonb_build_object(
    'user', jsonb_build_object(
      'user_id', v_user.user_id,
      'full_name', v_user.full_name,
      'email', v_user.email,
      'phone', v_user.phone,
      'is_active', v_user.is_active,
      'created_at', v_user.created_at
    ),
    'account', case when v_account.user_id is null then null else jsonb_build_object(
      'balance_milli_points', v_account.balance_milli_points,
      'debt_milli_points', v_account.debt_milli_points,
      'points_balance', round((v_account.balance_milli_points - v_account.debt_milli_points)::numeric / 1000, 3),
      'warning_flags', v_account.warning_flags,
      'accrual_locked', v_account.accrual_locked,
      'referral_code', v_account.referral_code,
      'updated_at', v_account.updated_at
    ) end,
    'totals', jsonb_build_object(
      'earned_milli', (select coalesce(sum(amount_milli_points), 0) from public.loyalty_ledger
        where user_id = p_user_id and amount_milli_points > 0 and kind in ('earn', 'debt_repayment')),
      'reversed_milli', (select coalesce(-sum(amount_milli_points), 0) from public.loyalty_ledger
        where user_id = p_user_id and amount_milli_points < 0),
      'ledger_entries', (select count(*) from public.loyalty_ledger where user_id = p_user_id),
      'zero_entries', (select count(*) from public.loyalty_ledger where user_id = p_user_id and amount_milli_points = 0),
      'delivered_orders', (select count(*) from public.orders where user_id = p_user_id and status::text = 'delivered'),
      'refunded_returns', (
        select count(*) from public.return_exchange r join public.orders o on o.order_id = r.order_id
        where o.user_id = p_user_id and r.status::text in ('completed', 'COMPLETED', 'refunded', 'REFUNDED')
      )
    ),
    'trail', (
      select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc, t.ledger_id desc), '[]'::jsonb)
      from (
        select
          l.ledger_id, l.kind, l.amount_milli_points, l.balance_after_milli_points,
          l.expires_at, l.note, l.created_at,
          l.order_id, o.order_code, o.status::text as order_status,
          l.return_id, r.status::text as return_status
        from public.loyalty_ledger l
        left join public.orders o on o.order_id = l.order_id
        left join public.return_exchange r on r.return_id = l.return_id
        where l.user_id = p_user_id
        order by l.created_at desc, l.ledger_id desc
        limit 100
      ) t
    ),
    'referrals', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'referral_id', x.referral_id,
        'role', x.role,
        'counterpart_name', x.counterpart_name,
        'status', x.status,
        'created_at', x.created_at,
        'completed_at', x.completed_at,
        'reversed_at', x.reversed_at,
        'qualifying_order_id', x.qualifying_order_id,
        'qualifying_order_code', x.qualifying_order_code
      ) order by x.created_at desc), '[]'::jsonb)
      from (
        select r.referral_id, 'referrer' as role, u2.full_name as counterpart_name, r.status,
               r.created_at, r.completed_at, r.reversed_at, r.qualifying_order_id, o.order_code as qualifying_order_code
        from public.referral r
        join public.users u2 on u2.user_id = r.referred_user_id
        left join public.orders o on o.order_id = r.qualifying_order_id
        where r.referrer_user_id = p_user_id
        union all
        select r.referral_id, 'referred', u2.full_name, r.status,
               r.created_at, r.completed_at, r.reversed_at, r.qualifying_order_id, o.order_code
        from public.referral r
        join public.users u2 on u2.user_id = r.referrer_user_id
        left join public.orders o on o.order_id = r.qualifying_order_id
        where r.referred_user_id = p_user_id
      ) x
    ),
    'vouchers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'member_voucher_id', mv.member_voucher_id,
        'voucher_id', mv.voucher_id,
        'code', v.code,
        'name', v.name,
        'benefit', mv.benefit,
        'status', mv.status,
        'issued_at', mv.issued_at,
        'expires_at', v.end_date,
        'used_order_id', mv.used_order_id,
        'revoked_at', mv.revoked_at
      ) order by mv.issued_at desc), '[]'::jsonb)
      from public.member_voucher mv
      join public.voucher v on v.voucher_id = mv.voucher_id
      where mv.user_id = p_user_id
    )
  );
end;
$$;

-- Khoá/mở tích luỹ có lý do. Đây là công tắc vận hành, không phải điều chỉnh số dư: ví không đổi,
-- ledger vẫn là nguồn sự thật, và mọi lần bấm đều vào audit_log với action lock/unlock.
create or replace function public.admin_set_member_accrual_lock(
  p_user_id uuid,
  p_locked boolean,
  p_reason text,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor uuid := public.velura_current_user_id();
  v_role text;
  v_account public.loyalty_account%rowtype;
  v_before boolean;
begin
  if not public.velura_has_admin_role(array['super_admin']) then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  select admin_role::text into v_role from public.users
  where user_id = v_actor and role::text = 'admin' and is_active;

  if not exists (select 1 from public.users where user_id = p_user_id and role::text = 'member') then
    raise sqlstate 'PT404' using message = 'MEMBER_NOT_FOUND';
  end if;
  if p_locked is null then
    raise sqlstate 'PT422' using message = 'MEMBER_LOCK_STATE_REQUIRED';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 8 then
    raise sqlstate 'PT422' using message = 'MEMBER_LOCK_REASON_REQUIRED';
  end if;

  perform public.velura_ensure_loyalty_account(p_user_id);
  select * into v_account from public.loyalty_account where user_id = p_user_id for update;
  v_before := v_account.accrual_locked;

  if v_before = p_locked then
    return jsonb_build_object('user_id', p_user_id, 'accrual_locked', v_before, 'changed', false);
  end if;

  update public.loyalty_account
  set accrual_locked = p_locked, updated_at = now()
  where user_id = p_user_id
  returning * into v_account;

  perform public.velura_append_module_audit(
    'members', v_actor, v_role,
    case when p_locked then 'lock' else 'unlock' end,
    p_user_id,
    jsonb_build_object('accrual_locked', v_before),
    jsonb_build_object('accrual_locked', p_locked, 'reason', btrim(p_reason)),
    p_ip_address
  );

  return jsonb_build_object(
    'user_id', p_user_id,
    'accrual_locked', v_account.accrual_locked,
    'changed', true
  );
end;
$$;

revoke all on function public.admin_member_overview() from public, anon, authenticated;
revoke all on function public.admin_list_members(text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_member_detail(uuid) from public, anon, authenticated;
revoke all on function public.admin_set_member_accrual_lock(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.admin_member_overview() to authenticated;
grant execute on function public.admin_list_members(text, text, text, integer, integer) to authenticated;
grant execute on function public.admin_member_detail(uuid) to authenticated;
grant execute on function public.admin_set_member_accrual_lock(uuid, boolean, text, text) to authenticated;

notify pgrst, 'reload schema';
commit;
