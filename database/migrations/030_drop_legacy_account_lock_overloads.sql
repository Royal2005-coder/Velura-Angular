-- Migration: xoá hai bản nạp chồng cũ của RPC khoá/mở khoá tài khoản.
--
-- Trên cơ sở dữ liệu thật đang tồn tại hai bản của mỗi hàm:
--
--   admin_lock_user(uuid, text, text, integer, uuid, timestamptz, text)   -- có p_actor_id
--   admin_lock_user(uuid, text, text, integer, timestamptz, text)         -- bản của 001/029
--   admin_unlock_user(uuid, text, integer, uuid, text)                    -- có p_actor_id
--   admin_unlock_user(uuid, text, integer, text)                          -- bản của 001/029
--
-- Hai bản có `p_actor_id` không do migration nào trong kho này tạo ra (001 khai báo
-- `p_actor_id` cho `velura_append_audit`, không phải cho hai hàm này), nên chúng đến từ
-- một lần sửa tay ngoài quy trình. Hệ quả: migration 029 dùng `create or replace` chỉ
-- thay đúng bản trùng chữ ký, còn bản có `p_actor_id` vẫn giữ nguyên chốt kiểm tra cũ —
-- tức vẫn mở khoá được tài khoản chưa xác minh OTP.
--
-- Mức phơi nhiễm hiện tại: hai bản cũ chỉ được cấp cho `postgres` và `service_role`,
-- không cấp cho `authenticated`, nên không gọi tới được bằng token thành viên qua
-- PostgREST. Không có mã nào trong `apps/api` gọi chúng. Vì vậy đây là dọn dẹp, không
-- phải vá khẩn cấp — nhưng để lại thì mỗi lần sửa hai hàm này người sau đều phải nhớ
-- rằng có một bản thứ hai không được sửa theo, và sớm muộn sẽ quên.
--
-- Sau migration này mỗi hàm chỉ còn đúng một định nghĩa, là bản đã chốt ở 029.

drop function if exists public.admin_lock_user(uuid, text, text, integer, uuid, timestamptz, text);
drop function if exists public.admin_unlock_user(uuid, text, integer, uuid, text);
