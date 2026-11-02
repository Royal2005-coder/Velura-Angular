-- Migration 076 — Tạo 3 bảng Dimension và hàm chuẩn hóa vùng miền (Star Schema)
-- Thực thi trên Supabase Dashboard SQL Editor

-- 1. Hàm extract_region (Immutable - chuẩn hóa địa chỉ thành 4 phân vùng)
CREATE OR REPLACE FUNCTION public.extract_region(p_address text)
RETURNS varchar(50)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_norm text;
BEGIN
  IF p_address IS NULL OR trim(p_address) = '' THEN
    RETURN 'Khác';
  END IF;

  v_norm := lower(p_address);

  -- 1. Miền Nam
  IF v_norm ~ '(hcm|hồ chí minh|sài gòn|bình dương|đồng nai|long an|cần thơ|bà rịa|vũng tàu|tây ninh|tiền giang|bến tre|vĩnh long)' THEN
    RETURN 'Miền Nam';
  END IF;

  -- 2. Miền Bắc
  IF v_norm ~ '(hà nội|hải phòng|quảng ninh|bắc ninh|nam định|thái bình|hải dương|ninh bình|hà nam|hưng yên|vĩnh phúc)' THEN
    RETURN 'Miền Bắc';
  END IF;

  -- 3. Miền Trung
  IF v_norm ~ '(đà nẵng|huế|quảng nam|nha trang|khánh hòa|bình định|quảng ngãi|hà tĩnh|nghệ an|thanh hóa|phú yên)' THEN
    RETURN 'Miền Trung';
  END IF;

  RETURN 'Khác';
END;
$$;

-- 2. Bảng Dim Date (501 ngày gần nhất)
CREATE TABLE IF NOT EXISTS public.dim_date (
  date_key int PRIMARY KEY,
  full_date date NOT NULL UNIQUE,
  day_of_week varchar(20) NOT NULL,
  month int NOT NULL,
  quarter int NOT NULL,
  year int NOT NULL
);

INSERT INTO public.dim_date (date_key, full_date, day_of_week, month, quarter, year)
SELECT
  to_char(d, 'YYYYMMDD')::int AS date_key,
  d::date AS full_date,
  to_char(d, 'TMDay') AS day_of_week,
  extract(MONTH FROM d)::int AS month,
  extract(QUARTER FROM d)::int AS quarter,
  extract(YEAR FROM d)::int AS year
FROM generate_series(CURRENT_DATE - INTERVAL '500 days', CURRENT_DATE, '1 day'::interval) d
ON CONFLICT (date_key) DO NOTHING;

-- 3. Bảng Dim Region
CREATE TABLE IF NOT EXISTS public.dim_region (
  region_key serial PRIMARY KEY,
  region_name varchar(50) NOT NULL UNIQUE
);

INSERT INTO public.dim_region (region_name) VALUES 
('Miền Nam'), ('Miền Bắc'), ('Miền Trung'), ('Khác')
ON CONFLICT (region_name) DO NOTHING;

-- 4. Bảng Dim Order Status (Bộ 8 trạng thái chuẩn KAN-59 State Machine V2)
CREATE TABLE IF NOT EXISTS public.dim_order_status (
  status_key serial PRIMARY KEY,
  status_name varchar(50) NOT NULL UNIQUE
);

INSERT INTO public.dim_order_status (status_name) VALUES
('pending'), ('waiting_payment'), ('confirmed'), ('processing'), 
('shipping'), ('delivered'), ('delivery_failed'), ('cancelled')
ON CONFLICT (status_name) DO NOTHING;

-- 5. Cấp quyền SELECT cho API / PostgREST
GRANT SELECT ON public.dim_date TO anon, authenticated;
GRANT SELECT ON public.dim_region TO anon, authenticated;
GRANT SELECT ON public.dim_order_status TO anon, authenticated;
