-- Migration: Ghi nhận lượt dùng mã một cách nguyên tử và cộng dồn ngân sách chiến dịch;
--             tự bật/tắt chiến dịch theo lịch.
-- Target tables: public.voucher, public.promotion
--
-- Bối cảnh: trước migration này, cột promotion.total_discount_issued được khai báo, được
-- đọc để hiển thị, nhưng KHÔNG có bất kỳ câu lệnh cập nhật nào trong toàn bộ mã nguồn.
-- Hệ quả: màn admin vĩnh viễn hiện "0đ / hạn mức" và một chiến dịch có thể vượt ngân
-- sách không giới hạn mà không ai biết. Ngoài ra việc tăng used_count đang được làm bằng
-- đọc-rồi-ghi ở tầng ứng dụng nên hai đơn đặt cùng lúc có thể ghi đè lẫn nhau.

-- ---------------------------------------------------------------------------
-- 1. Ghi nhận một lượt dùng mã: tăng used_count + cộng dồn ngân sách chiến dịch
-- ---------------------------------------------------------------------------
create or replace function public.velura_record_voucher_redemption(
  p_voucher_id uuid,
  p_discount_amount numeric default 0
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_voucher public.voucher%rowtype;
  v_promotion public.promotion%rowtype;
  v_budget_exhausted boolean := false;
begin
  -- Khoá dòng voucher để hai đơn đặt cùng lúc không ghi đè số lượt của nhau.
  select * into v_voucher from public.voucher where voucher_id = p_voucher_id for update;
  if v_voucher.voucher_id is null then
    raise sqlstate 'PT404' using message = 'VOUCHER_NOT_FOUND';
  end if;

  update public.voucher
     set used_count = coalesce(used_count, 0) + 1,
         version = coalesce(version, 1) + 1,
         updated_at = now()
   where voucher_id = p_voucher_id
  returning * into v_voucher;

  -- Mã không thuộc chiến dịch nào thì không có ngân sách để cộng dồn.
  if v_voucher.promo_id is null then
    return jsonb_build_object(
      'voucher_id', v_voucher.voucher_id,
      'used_count', v_voucher.used_count,
      'promo_id', null,
      'budget_exhausted', false
    );
  end if;

  select * into v_promotion from public.promotion where promo_id = v_voucher.promo_id for update;
  if v_promotion.promo_id is null then
    return jsonb_build_object(
      'voucher_id', v_voucher.voucher_id,
      'used_count', v_voucher.used_count,
      'promo_id', null,
      'budget_exhausted', false
    );
  end if;

  update public.promotion
     set total_discount_issued = coalesce(total_discount_issued, 0) + greatest(coalesce(p_discount_amount, 0), 0),
         version = coalesce(version, 1) + 1,
         updated_at = now()
   where promo_id = v_promotion.promo_id
  returning * into v_promotion;

  -- Chạm trần ngân sách thì dừng chiến dịch ngay và tắt luôn mọi mã thuộc chiến dịch,
  -- cùng hành vi với admin_pause_promotion để hai đường dừng không lệch nhau.
  if coalesce(v_promotion.budget_limit, 0) > 0
     and coalesce(v_promotion.total_discount_issued, 0) >= v_promotion.budget_limit then
    v_budget_exhausted := true;

    update public.promotion
       set is_active = false, version = coalesce(version, 1) + 1, updated_at = now()
     where promo_id = v_promotion.promo_id and is_active = true;

    update public.voucher
       set is_active = false, version = coalesce(version, 1) + 1, updated_at = now()
     where promo_id = v_promotion.promo_id and is_active = true;

    perform public.velura_append_module_audit(
      'promotions', null, 'system', 'update', v_promotion.promo_id,
      jsonb_build_object('is_active', true),
      jsonb_build_object('is_active', false, 'reason', 'BUDGET_EXHAUSTED',
                         'total_discount_issued', v_promotion.total_discount_issued,
                         'budget_limit', v_promotion.budget_limit),
      null);
  end if;

  return jsonb_build_object(
    'voucher_id', v_voucher.voucher_id,
    'used_count', v_voucher.used_count,
    'promo_id', v_promotion.promo_id,
    'total_discount_issued', v_promotion.total_discount_issued,
    'budget_limit', v_promotion.budget_limit,
    'budget_exhausted', v_budget_exhausted
  );
end; $$;

-- ---------------------------------------------------------------------------
-- 2. Hoàn lại ngân sách khi đơn bị hủy
-- ---------------------------------------------------------------------------
create or replace function public.velura_release_voucher_redemption(
  p_voucher_id uuid,
  p_discount_amount numeric default 0
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_voucher public.voucher%rowtype;
  v_promotion public.promotion%rowtype;
begin
  select * into v_voucher from public.voucher where voucher_id = p_voucher_id for update;
  if v_voucher.voucher_id is null then
    raise sqlstate 'PT404' using message = 'VOUCHER_NOT_FOUND';
  end if;

  update public.voucher
     set used_count = greatest(coalesce(used_count, 0) - 1, 0),
         version = coalesce(version, 1) + 1,
         updated_at = now()
   where voucher_id = p_voucher_id
  returning * into v_voucher;

  if v_voucher.promo_id is not null then
    update public.promotion
       set total_discount_issued = greatest(coalesce(total_discount_issued, 0) - greatest(coalesce(p_discount_amount, 0), 0), 0),
           version = coalesce(version, 1) + 1,
           updated_at = now()
     where promo_id = v_voucher.promo_id
    returning * into v_promotion;
  end if;

  return jsonb_build_object(
    'voucher_id', v_voucher.voucher_id,
    'used_count', v_voucher.used_count,
    'total_discount_issued', coalesce(v_promotion.total_discount_issued, 0)
  );
end; $$;

-- ---------------------------------------------------------------------------
-- 3. Tự bật/tắt chiến dịch theo lịch
-- ---------------------------------------------------------------------------
-- Trước đây ngày bắt đầu/kết thúc chỉ dùng để chặn admin bật nhầm ngoài khoảng, không
-- có gì tự chạy — nên chiến dịch hết hạn vẫn hiện "Đang hoạt động" mãi mãi trên màn
-- admin dù mã đã bị từ chối khi thanh toán. Hàm này được gọi định kỳ từ tiến trình nền.
create or replace function public.velura_sync_promotion_schedule()
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_activated integer := 0;
  v_deactivated integer := 0;
begin
  -- Hết hạn hoặc chưa tới ngày mà đang bật thì tắt.
  with stopped as (
    update public.promotion
       set is_active = false, version = coalesce(version, 1) + 1, updated_at = now()
     where is_active = true
       and (now() > end_date or now() < start_date)
    returning promo_id
  )
  select count(*) into v_deactivated from stopped;

  update public.voucher v
     set is_active = false, version = coalesce(v.version, 1) + 1, updated_at = now()
    from public.promotion p
   where v.promo_id = p.promo_id and p.is_active = false and v.is_active = true;

  -- Đã tới ngày, còn ngân sách, mà đang tắt thì bật.
  with started as (
    update public.promotion
       set is_active = true, version = coalesce(version, 1) + 1, updated_at = now()
     where is_active = false
       and now() between start_date and end_date
       and (coalesce(budget_limit, 0) = 0 or coalesce(total_discount_issued, 0) < budget_limit)
    returning promo_id
  )
  select count(*) into v_activated from started;

  update public.voucher v
     set is_active = true, version = coalesce(v.version, 1) + 1, updated_at = now()
    from public.promotion p
   where v.promo_id = p.promo_id and p.is_active = true and v.is_active = false
     and now() between v.start_date and v.end_date;

  return jsonb_build_object(
    'activated', v_activated,
    'deactivated', v_deactivated,
    'ran_at', now()
  );
end; $$;

revoke all on function public.velura_record_voucher_redemption(uuid, numeric) from public, anon, authenticated;
revoke all on function public.velura_release_voucher_redemption(uuid, numeric) from public, anon, authenticated;
revoke all on function public.velura_sync_promotion_schedule() from public, anon, authenticated;
grant execute on function public.velura_record_voucher_redemption(uuid, numeric) to service_role;
grant execute on function public.velura_release_voucher_redemption(uuid, numeric) to service_role;
grant execute on function public.velura_sync_promotion_schedule() to service_role;
