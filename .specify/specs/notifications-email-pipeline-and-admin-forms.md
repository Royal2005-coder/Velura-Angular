# Specification: Notifications & Email Pipeline for Orders/Returns, Admin-ERP Form Validation & Performance Optimization

## 1. Mục tiêu & Bối cảnh
- **Vấn đề cốt lõi**:
  1. Khi người dùng tạo yêu cầu đổi/trả hàng, hoặc khi hệ thống duyệt đổi trả / hoàn tiền thành công, hoặc khi đơn hàng hoàn thành / giao hàng thành công:
     - Chưa hiển thị thông báo lên icon chuông (Notification Center) trên Storefront.
     - Chưa gửi email xác nhận và thông báo trạng thái tới khách hàng.
     - Web Push Notification (PWA) chưa được kích hoạt theo chuẩn giáo trình `Progressive Web App (PWA).pdf`.
  2. Toàn bộ các form trong `apps/admin-erp-ng`:
     - Còn tồn tại các chữ text thô `(bắt buộc)` thay vì đánh dấu sao đỏ `*` cạnh nhãn (label).
     - Chưa có inline error feedback khi người dùng chạm (touched) hoặc sửa (dirty) dữ liệu không hợp lệ theo chuẩn giáo trình `Angular Framework.pdf` và bài tập `DE-07-FORM-VALIDATION`.
  3. Tối ưu hiệu năng:
     - Tối ưu tải hình ảnh với `loading="lazy"`, `decoding="async"`, skeleton placeholders chống giật layout (CLS).
     - Bổ sung composite indexes cho cơ sở dữ liệu PostgreSQL (`notifications`, `return_exchange`, `orders`, `reviews`) giúp tăng tốc độ truy vấn đáng kể theo kiến trúc môn Web Nâng Cao (`TONGHOP-02-SHOP-DIEN-MAY`).

## 2. Đặc tả Kỹ thuật Chi tiết

### 2.1. Pipeline Thông Báo & Email cho Đơn Hàng & Đổi Trả (Backend & Storefront)
1. **Sự kiện Đổi/Trả Hàng Được Tạo (`POST /api/user/returns`)**:
   - Ghi bản ghi vào bảng `notifications` cho `user_id`:
     * `type`: `'return_requested'`
     * `title`: `'Đã tiếp nhận yêu cầu đổi/trả hàng #' || tracking_code`
     * `content`: `'Yêu cầu đổi/trả cho đơn hàng #' || order_code || ' đã được ghi nhận thành công. CSKH sẽ liên hệ và xử lý trong 24h làm việc.'`
     * `link`: `'/account/orders/' || order_id || '?tab=returns'`
   - Gửi email xác nhận (`sendReturnIntakeEmail`):
     * Template Quiet Luxury với bảng thông tin sản phẩm đổi/trả, lý do, và 5 bước chuẩn bị hàng theo `RETURN_INSTRUCTIONS`.
2. **Sự kiện Đổi Trả Được Phê Duyệt (`Approved`)**:
   - Ghi thông báo chuông:
     * `type`: `'return_approved'`
     * `title`: `'Yêu cầu đổi/trả #' || tracking_code || ' đã được phê duyệt'`
     * `content`: `'Yêu cầu đổi/trả cho đơn hàng #' || order_code || ' đã được phê duyệt. Vui lòng đóng gói sản phẩm và chuẩn bị bàn giao cho ĐVVC.'`
     * `link`: `'/account/orders/' || order_id`
   - Gửi email xác nhận phê duyệt với mã QR vận đơn trả hàng.
3. **Sự kiện Hoàn Tiền Thành Công (`Refunded` / `recordManualRefund` / `triggerStripeRefund`)**:
   - Ghi thông báo chuông:
     * `type`: `'return_refunded'`
     * `title`: `'Hoàn tiền thành công cho đơn hàng #' || order_code`
     * `content`: `'Số tiền ' || amount_formatted || ' đã được hoàn tất thủ tục hoàn về tài khoản/thẻ của bạn.'`
     * `link`: `'/account/orders/' || order_id`
   - Gọi `sendRefundSuccessEmail` gửi thư chi tiết kèm thông tin kênh hoàn tiền (Stripe, VNPay, MoMo, hoặc chuyển khoản ngân hàng COD).
4. **Sự kiện Đơn Hàng Hoàn Thành / Giao Thành Công (`Completed` / `Delivered`)**:
   - Ghi thông báo chuông:
     * `type`: `'order_completed'`
     * `title`: `'Đơn hàng #' || order_code || ' đã giao thành công'`
     * `content`: `'Đơn hàng #' || order_code || ' đã được giao thành công. Cảm ơn bạn đã lựa chọn Velura! Hãy đánh giá sản phẩm để nhận thêm điểm thưởng.'`
     * `link`: `'/account/orders/' || order_id`
   - Gửi email thông báo đơn hàng hoàn tất.
5. **Storefront PWA & Web Push Notification Handler**:
   - `NotificationsService` trong `apps/user-ng`:
     * Khi nhận được thông báo mới (hoặc khi polling/refresh phát hiện unread count tăng):
     * Nếu người dùng đã cấp quyền Notification (`Notification.permission === 'granted'`), kích hoạt hiển thị Browser Notification hoặc in-app toast notification.
     * Tích hợp đăng ký Service Worker theo `Progressive Web App (PWA).pdf`.

### 2.2. Chuẩn Hóa Form Validation & Sao Đỏ `*` trong Admin-ERP
1. **Thiết lập Helper CSS Toàn Cục**:
   - `.erp-required`: màu đỏ tươi `--erp-danger, #e11d48`, font weight 700, margin-left 2px, `aria-hidden="true"`.
   - `.erp-field-error`: text lỗi màu đỏ hiển thị bên dưới input khi invalid và touched/dirty.
   - `.erp-input.is-invalid`, `.erp-input:invalid:focus`: viền đỏ và shadow cảnh báo.
2. **Rà soát & Chuẩn hóa Toàn bộ Form**:
   - Xóa bỏ toàn bộ chữ text `(bắt buộc)` thô sơ.
   - Thêm `<span class="erp-required" aria-hidden="true">*</span>` vào tất cả các trường required trong:
     * `product-editor.component.html` (Tên, SKU, Slug, Danh mục, Giá niêm yết, Giá bán)
     * `admin-erp-promotions.page.html` (Tên chiến dịch, Ngày bắt đầu, Ngày kết thúc, Mã voucher, Giá trị)
     * `admin-erp-content.page.html` (Tiêu đề, Slug, Danh mục, Nội dung)
     * `admin-erp-accounts.page.html` (Email, Tên đầy đủ, Vai trò, Mật khẩu)
     * `admin-erp-orders.page.html` & `return-flow.component.html` & `chat-desk.component.html`
3. **Hiển thị Validation Inline**:
   - Bổ sung logic hiển thị thông báo lỗi khi trường required bị bỏ trống lúc người dùng tương tác.

### 2.3. Tối Ưu Tải Hình Ảnh, Dữ Liệu & Database Indexing
1. **Tối ưu Hình ảnh (Frontend)**:
   - Thêm `loading="lazy"` và `decoding="async"` trên tất cả các `<img>` trong `admin-erp-ng` và `user-ng` (sản phẩm, review đính kèm, media blogs, campaign banners).
   - Đảm bảo `aspect-ratio` và placeholder chống giật layout (Cumulative Layout Shift - CLS).
2. **Database Performance Indexing (Backend)**:
   - Migration `125_performance_and_notification_indexes.sql`:
     * Index cho `notifications (user_id, is_read, created_at desc)`
     * Index cho `return_exchange (user_id, status, created_at desc)`
     * Index cho `orders (user_id, status, created_at desc)`
     * Index cho `reviews (product_id, is_approved, created_at desc)`

## 3. Tiêu Chí Nghiệm Thu (Acceptance Criteria)
1. Tạo đơn đổi/trả hàng $\rightarrow$ bảng `notifications` có record mới, Storefront Bell icon tăng unread count, có email tiếp nhận gửi tới hòm thư khách hàng.
2. Hoàn tiền đổi/trả hàng $\rightarrow$ có notification cho user, có email hoàn tiền.
3. Đơn hàng hoàn thành / giao hàng thành công $\rightarrow$ có notification cho user, có email.
4. Mọi form trong Admin-ERP không còn chữ `(bắt buộc)`, thay bằng sao đỏ `*`; form fields có validation rõ ràng khi touched/dirty/invalid.
5. 100% hình ảnh trong Admin và Storefront có `loading="lazy"` và `decoding="async"`.
6. Tất cả bài test hiện hữu (Angular tests, API tests) pass 100%. Không có lỗi biên dịch TypeScript.
