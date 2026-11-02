-- Migration 075 — Seed data cho widget SLA. Chạy trên Supabase Dashboard SQL Editor.
-- Mục tiêu: Khởi tạo 200 đơn hàng mẫu phân bổ theo vùng miền và chu trình giao vận thực tế.
-- Ghi chú: order_date = created_at = updated_at = v_created (chấp nhận cho seed data, trong production sẽ khác).

BEGIN;

-- 1. Đảm bảo có ít nhất 1 admin/staff làm changed_by
DO $$
DECLARE
  v_user_id uuid;
  v_order_id uuid;
  v_created timestamp;
  v_shipping_time timestamp;
  v_delivered_time timestamp;
  v_addr text;
  v_status order_status;
  v_shipping_fee numeric(10,0) := 30000;
  v_subtotal numeric(12,0);
  v_total numeric(12,0);
  i int;
BEGIN
  -- 0. Idempotency Guard: Nếu seed data đã tồn tại thì bỏ qua toàn bộ để tránh duplicate
  IF EXISTS (SELECT 1 FROM orders WHERE shipping_name LIKE 'Khách Seed%') THEN
    RAISE NOTICE 'Seed data đã tồn tại (đã có đơn Khách Seed). Bỏ qua để tránh duplicate.';
    RETURN;
  END IF;

  SELECT user_id INTO v_user_id FROM users LIMIT 1;
  IF v_user_id IS NULL THEN
    INSERT INTO users (user_id, email, password_hash, role, full_name)
    VALUES (
      gen_random_uuid(),
      'system.seed@velura.internal',
      '$2b$10$dummyhashfordemopurposesonly',
      'admin',
      'System Seed'
    )
    RETURNING user_id INTO v_user_id;
  END IF;

  -- 2. Sinh 200 đơn hàng ngẫu nhiên trong 30 ngày gần nhất
  FOR i IN 1..200 LOOP
    v_created := NOW() - (random() * 30 || ' days')::interval;
    
    -- Phân bổ miền: 50% Nam, 30% Bắc, 20% Trung
    IF i % 10 < 5 THEN
      v_addr := 'Quận ' || (1 + (i % 12)) || ', TP. Hồ Chí Minh';
    ELSIF i % 10 < 8 THEN
      v_addr := 'Quận Cầu Giấy, Hà Nội';
    ELSE
      v_addr := 'Quận Hải Châu, Đà Nẵng';
    END IF;

    -- Phân bổ trạng thái (chuẩn KAN-59 State Machine V2): 60% delivered, 20% shipping, 10% pending, 5% cancelled, 5% delivery_failed
    IF i % 20 < 12 THEN v_status := 'delivered';
    ELSIF i % 20 < 16 THEN v_status := 'shipping';
    ELSIF i % 20 < 18 THEN v_status := 'pending';
    ELSIF i % 20 = 18 THEN v_status := 'cancelled';
    ELSE v_status := 'delivery_failed';
    END IF;

    -- Tính toán tiền hàng: subtotal + shipping_fee = total_amount
    v_subtotal := (250000 + (random() * 750000))::numeric(12,0);
    v_total := v_subtotal + v_shipping_fee;

    INSERT INTO orders (
      order_id,
      user_id,
      order_date,
      status,
      total_amount,
      subtotal,
      shipping_name,
      shipping_phone,
      shipping_fee,
      payment_method,
      shipping_address,
      created_at,
      updated_at
    )
    VALUES (
      gen_random_uuid(),
      v_user_id,
      v_created,
      v_status,
      v_total,
      v_subtotal,
      'Khách Seed ' || i,
      '090' || lpad((i % 1000)::text, 7, '0'),
      v_shipping_fee,
      'COD',
      v_addr,
      v_created,
      v_created
    )
    RETURNING order_id INTO v_order_id;

    -- Tạo lịch sử trạng thái (Audit trail)
    IF v_status IN ('shipping', 'delivered') THEN
      v_shipping_time := v_created + ((6 + (random() * 66)) || ' hours')::interval;
      
      INSERT INTO order_status_history (order_id, old_status, new_status, trigger_type, changed_at, changed_by)
      VALUES (v_order_id, 'pending', 'shipping', 'system', v_shipping_time, v_user_id);

      IF v_status = 'delivered' THEN
        v_delivered_time := v_shipping_time + ((24 + (random() * 48)) || ' hours')::interval;
        
        INSERT INTO order_status_history (order_id, old_status, new_status, trigger_type, changed_at, changed_by)
        VALUES (v_order_id, 'shipping', 'delivered', 'system', v_delivered_time, v_user_id);

        -- Cập nhật delivered_at đồng bộ với lịch sử giao thành công
        UPDATE orders SET delivered_at = v_delivered_time WHERE order_id = v_order_id;
      END IF;
    END IF;
  END LOOP;
END $$;

COMMIT;
