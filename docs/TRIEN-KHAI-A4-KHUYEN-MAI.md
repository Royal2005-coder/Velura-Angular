# Triển khai A4 — Khuyến mãi

Ghi chú cho người có quyền chạm vào Supabase. Toàn bộ mã nguồn của module A4 đã lên
nhánh và qua pipeline, nhưng **ba migration và một kho chứa tệp vẫn chưa được áp
dụng** — người viết mã không có quyền truy cập cơ sở dữ liệu.

Cho tới khi làm xong các bước dưới đây:

- Thanh ngân sách trong trang Khuyến mãi của admin luôn hiển thị `0đ / <hạn mức>`.
- Trang Ưu đãi của khách sẽ lỗi vì thiếu cột.
- Nút tải ảnh banner trả về lỗi kho chứa không tồn tại.

## 1. Chạy migration theo đúng thứ tự

```bash
psql "$SUPABASE_DB_URL" -f database/migrations/025_promotion_budget_and_schedule.sql
psql "$SUPABASE_DB_URL" -f database/migrations/026_promotion_presentation_fields.sql
psql "$SUPABASE_DB_URL" -f database/migrations/027_promotion_update_presentation.sql
```

| Migration | Việc nó làm |
|---|---|
| 025 | Ba RPC cộng dồn tiền đã giảm, hoàn lại khi huỷ đơn, và đồng bộ lịch chạy. Trước đó `promotion.total_discount_issued` được khai báo và được đọc để hiển thị nhưng **không có nơi nào ghi vào**, nên chiến dịch có thể tiêu vượt ngân sách không giới hạn. |
| 026 | Năm cột nội dung trình bày trên `public.promotion`: `description`, `banner_image_url`, `highlight_label`, `display_order`, `is_featured`. |
| 027 | Dựng lại `admin_update_promotion` để nhận các cột của 026 cùng hai mốc lịch chạy, và đặt chốt quyền cho bốn RPC ghi khuyến mãi/voucher. |

**027 có `drop function`.** Nó bỏ chữ ký cũ của `admin_update_promotion` trước khi tạo
lại — bắt buộc, vì `create or replace` với danh sách tham số khác chỉ tạo thêm một bản
nạp chồng và PostgREST gọi bằng tham số có tên sẽ báo `function is not unique`. Chạy
026 trước 027; chạy ngược lại thì 027 tham chiếu cột chưa tồn tại.

Kiểm tra sau khi chạy:

```sql
-- Phải trả về đúng một dòng, 13 tham số.
select pronargs from pg_proc where proname = 'admin_update_promotion';

-- Phải có đủ năm cột.
select column_name from information_schema.columns
 where table_name = 'promotion'
   and column_name in ('description','banner_image_url','highlight_label','display_order','is_featured');
```

## 2. Tạo kho chứa ảnh banner

Tuyến `POST /api/v1/admin/promotions/banner` ghi vào kho `promotion-banners`, thư mục
`campaign/`. Kho này chưa tồn tại.

Trên Supabase Dashboard → Storage → New bucket:

- Tên: `promotion-banners`
- Public: **có** (ảnh banner hiển thị công khai trên trang Ưu đãi)
- Giới hạn kích thước: 5 MB, khớp với mức API đang chặn

Kho này cố tình tách khỏi `return-evidence`: banner là nội dung công khai lâu dài, còn
ảnh bằng chứng đổi trả là dữ liệu riêng của một khách cụ thể — hai vòng đời và hai mức
quyền đọc khác hẳn nhau.

## 3. Kiểm tra lại sau khi triển khai

1. Admin → Khuyến mãi → **Tạo chiến dịch**: điền tên, hai mốc thời gian, ngân sách, tải
   một ảnh banner. Lưu xong chiến dịch phải ở trạng thái **Tạm dừng**.
2. Bấm **Kích hoạt**. Trạng thái chuyển sang *Đang chạy*.
3. Mở trang Ưu đãi phía khách: chiến dịch vừa tạo phải xuất hiện cùng ảnh và mô tả đã
   nhập. Tạm dừng chiến dịch rồi tải lại trang — nó phải biến mất.
4. Đặt một đơn có dùng mã của chiến dịch. Quay lại admin, thanh ngân sách phải tăng.
5. Huỷ đơn đó. Thanh ngân sách phải giảm về mức cũ.

## Việc còn để lại

- **Tuyến `/api/user/upload/evidence` không có xác thực.** `handleUploadRoute` không
  nhận `context`, nên bất kỳ ai trên Internet cũng tải được tệp 5 MB vào kho
  `return-evidence`. Không thuộc phạm vi A4 nhưng cần xử lý — ghi ở đây để không rơi.
- Các thông báo lỗi tiếng Anh còn lại trong `pricingErrorMessage` thuộc luồng đổi giá.
  Giao diện quản trị là tiếng Việt nên phần này nên được dịch nốt trong một lần riêng.
