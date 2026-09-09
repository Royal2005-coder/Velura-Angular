-- ====================================================================
-- VELURA - Tạo Supabase Storage Bucket cho ảnh minh chứng đổi trả
-- ====================================================================
-- Chạy trong Supabase SQL Editor.
-- ====================================================================

-- Tạo bucket "return-evidence" (public = có thể xem URL công khai)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'return-evidence',
  'return-evidence',
  true,
  5242880,  -- 5MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

-- Cho phép upload (INSERT) bởi bất kỳ ai (anon + authenticated)
CREATE POLICY IF NOT EXISTS "Allow public uploads to return-evidence"
ON storage.objects
FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'return-evidence');

-- Cho phép đọc (SELECT) public
CREATE POLICY IF NOT EXISTS "Allow public reads from return-evidence"
ON storage.objects
FOR SELECT
TO anon, authenticated
USING (bucket_id = 'return-evidence');
