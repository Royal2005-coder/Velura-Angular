# Technical Plan: Notifications & Email Pipeline, Admin-ERP Form Validation & Performance Optimization

## 1. Kiến Trúc Kỹ Thuật (Architecture Overview)

```
[Storefront User / Member] <---- (Signal Polling & PWA Web Push) ---- [Notifications Table]
         |                                                                    ^
         | (POST /api/user/returns)                                           |
         v                                                                    |
[User Returns Service] -------------------------------------------------------+
         |                                                                    |
         +---- (void / background) ----> [Mailer: sendReturnIntakeEmail]      |
                                                                              |
[Admin ERP Operator]                                                          |
         | (Approve / Manual Refund / Gateway Refund)                         |
         v                                                                    |
[Admin Return Service] -------------------------------------------------------+
         |
         +---- (sendRefundSuccessEmail) + (createNotification)

[Carrier Webhook / Admin Order]
         | (Delivered / Completed)
         v
[Order Service] --------------------------------------------------------------+
         |
         +---- (sendOrderDeliveredEmail) + (createNotification)
```

## 2. Các Hợp Đồng Kỹ Thuật & Giải Pháp (Design Decisions)

### 2.1. Backend Notification & Email Service
1. **Chống nghẽn & Độc lập giao dịch**:
   - Mọi tác vụ gửi email hoặc notification sau khi cập nhật database đều chạy bằng async non-blocking (`void dispatchNotification(...)` hoặc `Promise.allSettled`).
   - Thất bại khi gửi email (ví dụ SMTP timeout) KHÔNG ĐƯỢC làm fail HTTP request của người dùng/operator.
2. **Khách Hàng Vãng Lai (Guest) vs Thành Viên (Member)**:
   - Bảng `notifications` có ràng buộc foreign key `user_id references public.users(user_id)`.
   - Đối với đơn hàng/yêu cầu của khách vãng lai (`order.user_id === null` hoặc không có `userId`): BỎ QUA việc insert vào `notifications` để tránh lỗi DB, chỉ gửi Email xác nhận tới `shipping_email`.
   - Đối với thành viên (`order.user_id` tồn tại): Ghi nhận cả `notifications` và gửi Email.
3. **Template Email Quiet Luxury**:
   - `sendReturnIntakeEmail`: Thư xác nhận tiếp nhận yêu cầu đổi/trả.
   - `sendReturnApprovedEmail`: Thư thông báo yêu cầu đổi/trả đã được chấp thuận kèm mã vận đơn.
   - `sendRefundSuccessEmail`: Đã có trong `return-email.ts`, bổ sung gọi `createNotification`.
   - `sendOrderDeliveredEmail`: Thư thông báo giao hàng thành công.

### 2.2. Storefront PWA Web Push & Notification Bell
1. **`NotificationsService` trong `apps/user-ng`**:
   - Quản lý danh sách thông báo thành viên qua Angular Signal.
   - Lắng nghe unread count.
   - Khi có thông báo mới (so sánh với id đã nạp), nếu trình duyệt hỗ trợ và người dùng đã cấp quyền (`Notification.permission === 'granted'`), hiển thị thông báo trình duyệt (Browser Notification / Service Worker).
   - Có cơ chế xin quyền nhẹ nhàng (`requestPermission`) khi thành viên nhấp vào icon chuông hoặc cài đặt.

### 2.3. Chuẩn Hóa Form Admin-ERP với Sao Đỏ `*` & Validation
1. **CSS Toàn Cục**:
   - `.erp-required`: màu đỏ tươi `--erp-danger, #e11d48`, font-weight 700, margin-left 2px, `aria-hidden="true"`.
   - `.erp-field-error`: text lỗi màu đỏ hiển thị bên dưới input khi `invalid && (touched || dirty)`.
   - `.erp-input.is-invalid`: border đỏ cảnh báo.
2. **Rà soát & Loại Bỏ `(bắt buộc)`**:
   - Thay thế toàn bộ text `(bắt buộc)` thành `<span class="erp-required" aria-hidden="true">*</span>` ở tất cả các form (sản phẩm, chiến dịch, voucher, blog, tài khoản, đơn hàng, đổi trả).
3. **Tương thích Responsive & Layout**:
   - Đảm bảo các field error được đặt `min-height` hoặc absolute/inline flow phù hợp, không làm xô lệch grid hay form table.

### 2.4. Tối Ưu Tải Hình Ảnh & Database Indexing
1. **Frontend Image Optimization**:
   - Gắn `loading="lazy"` và `decoding="async"` trên toàn bộ các ảnh `<img>` trong cả 2 app (`admin-erp-ng` và `user-ng`).
   - Đảm bảo có placeholder hoặc fallback src.
2. **PostgreSQL / Supabase Migration**:
   - `database/migrations/125_performance_and_notification_indexes.sql`:
     * Index cho `notifications (user_id, is_read, created_at desc)`
     * Composite index cho `return_exchange (user_id, status, created_at desc)`
     * Index cho `orders (user_id, status, created_at desc)`
     * Index cho `reviews (product_id, is_approved, created_at desc)`

## 3. Kế Hoạch Kiểm Thử (Verification Plan)
- **Unit Tests**:
  * Test email & notification dispatch trong `tests/api/`.
  * Test validation và sao đỏ trong `apps/admin-erp-ng`.
  * Test notifications service trong `apps/user-ng`.
- **E2E / Regression**:
  * Chạy `npm run test:api`, `npm run test:admin-erp`, `npm run test:user`.
  * Chạy `npm run build:api`, `npm run build:admin-erp`, `npm run build:user`.
