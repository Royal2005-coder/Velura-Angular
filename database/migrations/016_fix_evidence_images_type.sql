-- ====================================================================
-- VELURA - FIX evidence_images COLUMN TYPE
-- ====================================================================
-- Mục đích: Đổi kiểu cột evidence_images từ VARCHAR(255)[] sang TEXT[]
-- để cho phép lưu URL ảnh dài hơn (Supabase Storage, CDN, placeholder URL...).
-- Chạy trong Supabase SQL Editor.
-- ====================================================================

ALTER TABLE public.return_exchange
  ALTER COLUMN evidence_images TYPE TEXT[]
  USING evidence_images::TEXT[];
