# Triển khai A4 — Khuyến mãi

**Trạng thái: đã triển khai lên Supabase ngày 19/09/2026.** Tài liệu này ghi lại những
gì đã chạy, cách kiểm chứng, và cách chạy lại trên một môi trường khác.

## Đã làm gì

| Việc | Trạng thái |
|---|---|
| Migration 025 — cộng dồn ngân sách, hoàn lại khi huỷ đơn, đồng bộ lịch | Đã chạy |
| Migration 026 — 5 cột nội dung trình bày trên `public.promotion` | Đã chạy |
| Migration 027 — dựng lại `admin_update_promotion`, chốt quyền 4 RPC | Đã chạy |
| Kho chứa `promotion-banners` (public, 5 MB, JPG/PNG/WebP/GIF) | Đã tạo |

Kiểm chứng ngay sau khi chạy:

- 5/5 cột của 026 có mặt; `admin_update_promotion` từ 7 lên 13 tham số.
- 3/3 RPC của 025 tồn tại và gọi được.
- `velura_sync_promotion_schedule()` chạy lần đầu trả về `activated: 2, deactivated: 2`.
  Đây là dữ liệu thật được sửa: hai chiến dịch đã quá hạn vẫn đang bật, và hai chiến
  dịch nằm trong khung ngày lại đang tắt. Sau đồng bộ, 3 chiến dịch thật chạy (đều
  trong khung), 5 chiến dịch test/hết hạn tắt.
- PostgREST đọc được các cột mới bằng khoá anon (200).

## Cách chạy migration

Kho có sẵn trình chạy. Chuỗi kết nối đọc từ `SUPABASE_DB_URL` trong `.env` ở gốc kho
chính (`.env` nằm trong `.gitignore`, không bao giờ commit). Khi làm việc trong một git
worktree, script tự tìm ngược về `.env` của kho chính.

```bash
npm run db:check                      # chỉ đọc hiện trạng, không ghi gì
npm run db:migrate -- 025 026 027     # chạy theo đúng thứ tự liệt kê
node scripts/run-migrations.mjs --dry-run 027   # in SQL rồi dừng
```

Mỗi tệp chạy trong một giao dịch riêng: hỏng giữa chừng thì tệp đó quay lui trọn vẹn,
các tệp trước đó giữ nguyên.

**Thứ tự bắt buộc: 026 trước 027.** 027 có `drop function` để bỏ chữ ký cũ của
`admin_update_promotion` trước khi tạo lại — bắt buộc, vì `create or replace` với danh
sách tham số khác chỉ tạo thêm một bản nạp chồng và PostgREST gọi bằng tham số có tên
sẽ báo `function is not unique`. Chạy 027 trước 026 thì nó tham chiếu cột chưa tồn tại.

## Cách kiểm tra lại bằng tay

```sql
-- Phải là 13.
select pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'admin_update_promotion';

-- Phải đủ 5 cột.
select column_name from information_schema.columns
 where table_name = 'promotion'
   and column_name in ('description','banner_image_url','highlight_label','display_order','is_featured');
```

Luồng nghiệp vụ, chạy trên giao diện:

1. Admin → Khuyến mãi → **Tạo chiến dịch**: điền tên, hai mốc thời gian, ngân sách, tải
   một ảnh banner. Lưu xong chiến dịch phải ở trạng thái **Tạm dừng**.
2. Bấm **Kích hoạt**. Trạng thái chuyển sang *Đang chạy*.
3. Mở trang Ưu đãi phía khách: chiến dịch vừa tạo phải xuất hiện cùng ảnh và mô tả đã
   nhập. Tạm dừng chiến dịch rồi tải lại trang — nó phải biến mất.
4. Đặt một đơn có dùng mã của chiến dịch. Quay lại admin, thanh ngân sách phải tăng.
5. Huỷ đơn đó. Thanh ngân sách phải giảm về mức cũ.

## Việc còn để lại

- **Tuyến `POST /api/user/upload/evidence` không có xác thực.** `handleUploadRoute`
  không nhận `context`, nên bất kỳ ai trên Internet cũng tải được tệp 5 MB vào kho
  `return-evidence`. Không thuộc phạm vi A4 nhưng cần xử lý — ghi ở đây để không rơi.
  Kho `promotion-banners` của A4 đi qua tuyến admin riêng có kiểm vai trò.
- **Kho `return-evidence` không có giới hạn kích thước ở tầng kho chứa.** Chặn 5 MB
  hiện chỉ nằm trong mã API. Kho `promotion-banners` đã đặt giới hạn ngay ở kho.
- **Dữ liệu rác trên cơ sở dữ liệu thật:** 5 trong 8 chiến dịch là bản test
  (`Test Campaign 1783249933508`, `grsgrg`, …). Nên dọn trước khi trình bày.
- Các thông báo lỗi tiếng Anh còn lại trong `pricingErrorMessage` thuộc luồng đổi giá.
  Giao diện quản trị là tiếng Việt nên phần này nên được dịch nốt trong một lần riêng.
