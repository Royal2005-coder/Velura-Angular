# Supabase Cloud & Google Cloud: Hướng Dẫn Kích Hoạt & Cấu Hình Redirect URLs Toàn Diện

Áp dụng cho dự án Supabase Cloud `unzffihtqdqgqbgnwokj` và hệ thống Velura (`https://velura.royalai.dev`).

---

### Bước 1: Cấu hình Authorized Redirect URIs trên Google Cloud Console
1. Truy cập [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
2. Chọn dự án chứa OAuth 2.0 Client IDs.
3. Nhấp vào Web client OAuth Client ID (ví dụ: `Web client 1`).
4. Tại mục **Authorized redirect URIs**, đảm bảo có đúng địa chỉ callback của Supabase:
   ```text
   https://unzffihtqdqgqbgnwokj.supabase.co/auth/v1/callback
   ```
5. Nhấp **Save**.

---

### Bước 2: Bật Google Provider trên Supabase Cloud
1. Mở [Supabase Dashboard > Auth > Providers](https://supabase.com/dashboard/project/unzffihtqdqgqbgnwokj/auth/providers).
2. Tìm **Google** trong danh sách Authentication Providers.
3. Bật công tắc **Enable Sign in with Google** sang **ON**.
4. Dán thông tin xác thực từ Google Cloud Console:
   - **Client ID**: `403482594252-r2415175l35c87l85e9m42j1t1j3c2d6.apps.googleusercontent.com` (hoặc Client ID hiện tại của bạn).
   - **Client Secret**: *(Google OAuth client secret tương ứng)*.
5. Nhấp **Save**.

---

### Bước 3: Cấu hình Redirect URLs trên Supabase Cloud (QUAN TRỌNG NHẤT)
> [!IMPORTANT]
> Nếu thiếu bước này, GoTrue sẽ từ chối chuyển hướng sau khi Google xác thực thành công và trả về lỗi `redirect_uri_not_allowed`, dẫn đến việc đăng nhập thất bại.

1. Mở [Supabase Dashboard > Auth > URL Configuration](https://supabase.com/dashboard/project/unzffihtqdqgqbgnwokj/auth/url-configuration).
2. **Site URL**:
   ```text
   https://velura.royalai.dev
   ```
3. **Redirect URLs**: Thêm toàn bộ các URL sau vào danh sách:
   ```text
   https://velura.royalai.dev/**
   https://velura.royalai.dev/auth/callback
   https://admin-erp.royalai.dev/**
   https://admin-erp.royalai.dev/auth/callback
   http://localhost:4200/**
   http://localhost:4300/**
   http://localhost:5173/**
   ```
4. Nhấp **Save**.

---

### Bước 4: Kiểm tra & Xác nhận luồng đăng nhập
1. Truy cập `https://velura.royalai.dev/auth/signin`.
2. Bấm nút **"Tiếp tục với Google"**.
3. Chọn tài khoản Google của bạn trên `accounts.google.com`.
4. Trình duyệt sẽ chuyển hướng mượt mà về `https://velura.royalai.dev/auth/callback` $\rightarrow$ Khởi tạo phiên thành viên $\rightarrow$ Đưa người dùng về trang chủ với phiên đăng nhập hoàn tất.
5. Nếu có bất kỳ sự cố nào xảy ra, trang callback hiện tại đã hiển thị rõ ràng:
   - Thông điệp nguyên nhân lỗi thân thiện.
   - Gợi ý hành động xử lý.
   - Mã tra cứu kỹ thuật chuẩn (`REDIRECT_URI_NOT_ALLOWED`, `PROVIDER_DISABLED`, `STATE_MISMATCH`, v.v.) kèm nút **"Sao chép mã"**.
   - Nút **"Thử lại bằng Google"** để khởi tạo lại phiên trực tiếp mà không cần quay lại.
