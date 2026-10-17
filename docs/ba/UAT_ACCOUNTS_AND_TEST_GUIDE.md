# CẨM NANG TÀI KHOẢN & HƯỚNG DẪN KIỂM THỬ UAT 6 QUY TRÌNH CORE VELURA E-COMMERCE
> **Phiên bản:** Release Candidate v1.0-RC (Core E-Commerce Only - Tạm hoãn AI & Dashboard)  
> **Dự án:** Nền tảng Thương mại Điện tử Thời trang Cao cấp Velura  
> **File Excel UAT:** [Velura_UAT_Core_Workflows_6_Testers.xlsx](./Velura_UAT_Core_Workflows_6_Testers.xlsx)

---

## 1. MÔI TRƯỜNG KIỂM THỬ (TEST ENVIRONMENTS)

| Phân hệ | Môi trường Local Dev | Môi trường Staging / Production | Mục đích kiểm thử |
|---|---|---|---|
| **Storefront (Khách hàng)** | `http://localhost:4200` | `https://royalai.dev` | Dành cho Tester 01, 02, 03, 04, 05 thực hiện các luồng giỏ hàng, mua ngay, checkout, đổi trả, săn voucher, review |
| **Admin Backoffice (Quản trị)** | `http://localhost:4201` | `https://admin.royalai.dev` | Dành cho Tester 03, 04, 05, 06 thực hiện duyệt RMA, tạo voucher khuyến mãi, duyệt review, quản lý sản phẩm & đơn hàng |
| **Backend API Service** | `http://localhost:8787` | `https://api.royalai.dev` | Dịch vụ API và cổng thanh toán webhook |

---

## 2. MA TRẬN 6 NHÂN SỰ & TÀI KHOẢN ĐĂNG NHẬP (CREDENTIALS)

Mỗi tester phụ trách **duy nhất 1 Tab Core** trong file Excel UAT, chịu trách nhiệm nghiệm thu trọn vẹn quy trình của mình:

| Tester | Họ & Tên | Persona / Vai Trò | Tab Excel Phụ Trách | Tài Khoản Đăng Nhập | Mật Khẩu | Phân Quyền Hệ Thống |
|---|---|---|---|---|---|---|
| **Tester 01** | Nguyễn Thị Ánh | Khách Shopper Online | `1. Thêm Giỏ Hàng & PDP` | `shopper.uat@velura.test`<br>*(Hoặc Khách vãng lai)* | `Velura@2026` | `member` (Khách hàng) |
| **Tester 02** | Trần Quốc Bảo | Khách Mua Ngay & Checkout | `2. Mua Hàng & Thanh Toán` | `shopper.checkout@velura.test`<br>*(Hoặc Guest Checkout)* | `Velura@2026` | `member` (Khách hàng) |
| **Tester 03** | Lê Hoàng Châu | Khách Hậu Mãi & CSKH RMA | `3. Hủy Đơn & Đổi Trả` | **Khách:** `customer.rma@velura.test`<br>**CSKH:** `cskh.rma@velura.vn` | `Velura@2026`<br>`Admin@2026` | `member`<br>`admin_operator_cskh_dt` |
| **Tester 04** | Phạm Văn Dũng | Trưởng Phòng MKT & Săn Sale | `4. Khuyến Mãi & Voucher` | **Admin MKT:** `admin.marketing@velura.vn`<br>**Khách:** `member.promo@velura.test` | `Admin@2026`<br>`Velura@2026` | `admin_operator_gia_km`<br>`member` (Ví voucher) |
| **Tester 05** | Đặng Thị Mai | Khách Review & CSKH Duyệt | `5. Đánh Giá Sản Phẩm` | **Khách:** `chau.le@gmail.test`<br>**Admin Review:** `admin.reviews@velura.vn` | `Velura@2026`<br>`Admin@2026` | `member`<br>`admin_operator_danhgia_review` |
| **Tester 06** | Vũ Minh Tuấn | Quản Trị Catalog & Vận Hành | `6. Quản Lý Sản Phẩm & Đơn` | `admin.operator@velura.vn` | `Admin@2026` | `admin_operator_sanpham`<br>& `admin_operator_donhang` |

---

## 3. DỮ LIỆU KIỂM THỬ THANH TOÁN & BẢO MẬT (TEST DATA)

### 3.1 Cổng Thanh Toán Thẻ Quốc Tế Stripe Test
Dùng cho **Tester 02** tại màn hình thanh toán thẻ tín dụng:
* **Số thẻ test thành công:** `4242 4242 4242 4242`
* **Ngày hết hạn:** Bất kỳ tháng/năm nào trong tương lai (Ví dụ: `12/28`)
* **Mã bảo mật CVC/CVV:** `123`
* **Mã bưu chính (Zip code):** `70000` (hoặc `10000`)
* **Số thẻ test bị từ chối (Card Declined):** `4000 0000 0000 0002`

### 3.2 Mã OTP Demo / Khách Vãng Lai Review
Dùng cho **Tester 05** khi kiểm thử luồng Đánh giá khách vãng lai qua SĐT/Email:
* **Số điện thoại khách vãng lai:** `0912345678`
* **Mã OTP xác thực mặc định:** `123456`

---

## 4. HƯỚNG DẪN CHI TIẾT 6 QUY TRÌNH CORE THEO TỪNG TAB

### TAB 1: THÊM GIỎ HÀNG, PDP & KHÓA HẾT HÀNG (TESTER 01)
* **Trọng tâm kiểm thử:**
  1. **PDP & Biến thể:** Mở trang chi tiết sản phẩm `/products/...`, chọn Màu và Size -> Ảnh gallery chính đổi theo màu mượt mà.
  2. **Khóa Hết Hàng (Out of Stock):** Chọn biến thể có tồn kho = 0 (Màu Đen - Size XL). **Bắt buộc ô biến thể bị gạch chéo mờ (disabled), nút "Thêm vào giỏ" và "Mua ngay" bị khóa (disabled) kèm badge "Hết hàng"**, chặn hoàn toàn không cho click.
  3. **Nút Thêm Nhanh (Quick Add):** Bấm "Thêm vào giỏ" khi còn hàng -> Hiện Toast thông báo thành công, badge giỏ hàng header nhảy số tức thì, không reload trang.
  4. **Quản lý Giỏ hàng `/cart`:** Tăng/giảm số lượng, đổi size trực tiếp trong giỏ, xóa sản phẩm, kiểm tra tạm tính và tổng tiền tự động tính lại chuẩn xác.

### TAB 2: NÚT MUA NGAY, CHECKOUT STRIPE & COD (TESTER 02)
* **Trọng tâm kiểm thử:**
  1. **Nút Mua Ngay (Buy Now):** Chọn biến thể còn hàng, bấm "Mua ngay" -> Chuyển thẳng tức thì sang trang `/checkout` với đúng sản phẩm và số lượng vừa chọn.
  2. **Guest Checkout COD:** Khách chưa đăng nhập vào `/checkout/guest` -> Điền thông tin giao hàng đầy đủ -> Chọn COD -> Đặt hàng thành công -> Chuyển sang `/checkout/confirm`, nhận mã đơn `VEL-2026-XXXX`.
  3. **Option Gia Tăng:** Tích chọn Gói quà tặng cao cấp (+50k) và nhập lời chúc thiệp; Tích chọn yêu cầu xuất hóa đơn điện tử VAT công ty.
  4. **Thanh Toán Thẻ Stripe:** Đăng nhập thành viên vào `/checkout/user` -> Nạp sổ địa chỉ tự động -> Nhập thẻ test Stripe `4242...` -> Thanh toán thành công trong 2s, đơn chuyển `PAID`. Thử nghiệm nhập thẻ lỗi `4000...02` để kiểm tra thông báo từ chối lịch sự và giữ nguyên giỏ hàng.

### TAB 3: HỦY ĐƠN HÀNG & ĐỔI TRẢ RMA (TESTER 03)
* **Trọng tâm kiểm thử:**
  1. **Hủy đơn PENDING:** Vào đơn hàng ở trạng thái `PENDING`, bấm Hủy đơn -> Trạng thái đổi thành `CANCELLED`, tồn kho tự động hoàn lại ngay lập tức. Vào đơn đang giao `SHIPPING` -> Nút Hủy đơn phải biến mất.
  2. **Yêu cầu RMA:** Vào đơn đã giao `DELIVERED`, bấm "Yêu cầu đổi / trả" -> **Tải lên ảnh chụp bằng chứng lỗi sản phẩm** (xem preview ảnh thumbnail mượt mà, bấm icon xóa ảnh hoạt động tốt).
  3. **Cố định số tiền hoàn:** Chọn hình thức Hoàn tiền -> Hệ thống khóa cố định số tiền hoàn theo đúng hóa đơn thực tế, chặn không cho người dùng sửa tay số tiền.
  4. **CSKH Duyệt & Kho QA:** Đăng nhập `cskh.rma@velura.vn` -> Mở `/admin/returns` -> **Cột Thao tác dùng Dropdown Context Menu chuẩn UX**: Chuyển `CONTACTING`, duyệt hoàn tiền hoặc duyệt đổi hàng (hoặc từ chối bắt buộc lý do >= 10 ký tự). Kho nhận hàng thực hiện kiểm định QA (Pass/Fail) kích hoạt hoàn tiền Stripe.

### TAB 4: QUẢN TRỊ KHUYẾN MÃI & VÍ VOUCHER SINH NHẬT (TESTER 04)
* **Trọng tâm kiểm thử:**
  1. **Admin Tạo Khuyến Mãi:** Đăng nhập `admin.marketing@velura.vn` -> Vào `/admin/promotions` -> Tạo chiến dịch Mùa Thu và tạo voucher `%` (`VELURA20` giảm 20%, đơn tối thiểu 500k, giảm tối đa 100k).
  2. **Cấu Hình Voucher Sinh Nhật:** Tạo mã `HPBD2026` giảm tiền mặt 150.000đ cho đơn từ 600.000đ, cấu hình áp dụng cho quà sinh nhật thành viên.
  3. **Đồng Bộ Sang Storefront:** Mở trang `/offers` bên khách hàng kiểm tra các voucher công khai tự động hiển thị kèm nút "Sao chép mã".
  4. **Nạp Voucher vào Ví Sinh Nhật:** Đăng nhập `member.promo@velura.test` (khách có sinh nhật trong tháng) -> Mở `/account/vouchers` -> Kiểm tra mã `HPBD2026` tự động nằm trong ví.
  5. **Áp Dụng Tại Checkout & Ràng Buộc Min Order:**
     * Đơn hàng 800.000đ (> 600k) -> Nhập `HPBD2026` -> Giảm đúng `-150.000đ`, còn 650.000đ.
     * Đơn hàng 400.000đ (< 600k) -> Nhập `HPBD2026` -> Báo lỗi "Đơn hàng tối thiểu phải từ 600.000đ", chặn không cho áp dụng.
     * Thử nhập mã hết hạn hoặc bị tắt -> Báo mã không hợp lệ.

### TAB 5: ĐÁNH GIÁ SẢN PHẨM & REVIEW GUEST OTP (TESTER 05)
* **Trọng tâm kiểm thử:**
  1. **Review Đơn Đã Giao:** Khách đăng nhập `chau.le@gmail.test` -> Vào `/account/reviews` -> Chọn sản phẩm đã giao -> Chấm 5 sao, viết nhận xét chất liệu vải.
  2. **Upload Ảnh Thực Tế:** Tải lên 2 file ảnh chụp mặc đồ thực tế -> Xem preview thumbnail sắc nét, xóa ảnh mượt mà -> Gửi đánh giá nhận 50 điểm thưởng.
  3. **Khách Vãng Lai Review Qua OTP:** Truy cập `/guest/reviews` -> Nhập SĐT `0912345678` -> Nhận mã OTP (mã demo `123456`) -> Xác thực thành công -> Hệ thống load đúng các đơn hàng đã mua để review bình thường.
  4. **Admin Kiểm Duyệt (`/admin/reviews`):** Đăng nhập `admin.reviews@velura.vn` -> Duyệt đánh giá hợp lệ -> Review xuất hiện công khai trên PDP kèm ảnh thực tế; Điểm rating trung bình cập nhật; Thử tính năng ẩn/từ chối review vi phạm.

### TAB 6: QUẢN LÝ SẢN PHẨM, VẬN HÀNH ĐƠN & PHÂN QUYỀN (TESTER 06)
* **Trọng tâm kiểm thử:**
  1. **Quản trị Sản phẩm (`/admin/products`):** Thêm sản phẩm mới 'Đầm Dạ Hội Lụa Hoàng Gia' -> Tạo ma trận biến thể Màu x Size (6 mã SKU) với giá bán và tồn kho riêng biệt.
  2. **Kiểm tra Đồng bộ Tồn kho = 0:** Cài đặt biến thể Màu Đỏ Ruby - Size S có tồn kho = 0 -> Kiểm tra bên Storefront biến thể này bị mờ và khóa nút Mua ngay/Thêm giỏ lập tức.
  3. **Tiếp nhận & Ghi Log Đơn COD:** Đăng nhập `/admin/orders` -> Tiếp nhận đơn hàng mới PENDING -> Đơn COD rủi ro cao bấm ghi log cuộc gọi xác minh -> Phê duyệt đơn chuyển sang `CONFIRMED`.
  4. **Xuất kho 3PL & Hoàn tất:** Nhập đơn vị ViettelPost và Mã vận đơn `VTP-883921094` -> Chuyển sang `SHIPPING` (đồng bộ sang màn hình tra cứu của khách `/account/track`) -> Cập nhật `DELIVERED` mở quyền review và đổi trả.
  5. **Phân quyền RBAC & Audit Trail:** Kiểm tra tài khoản Kho bị chặn vào đổi mật khẩu/xóa sản phẩm; Kiểm tra trang Nhật ký hệ thống (`/admin/logs`) ghi nhận đầy đủ lịch sử thao tác.

---

## 5. QUY TRÌNH BÁO CÁO LỖI (DEFECT LOGGING)

Khi phát hiện lỗi, tester chuyển sang **Sheet 8 ("Nhật ký Báo cáo Bug UAT")** trong file Excel ghi nhận:
* **Bug ID:** Đánh số tự tăng (`BUG-005`, `BUG-006`, ...)
* **Mã TC Liên Quan:** Ví dụ `TC-CART-04`, `TC-RMA-06`
* **Mức độ (Severity):**
  * `Blocker`: Lỗi sập luồng, không đặt được đơn, hết hàng vẫn cho mua (SLA <= 2h).
  * `Critical`: Sai tiền hoàn trả, voucher tính sai chiết khấu (SLA <= 6h).
  * `Major`: Menu dropdown vỡ giao diện, lỗi upload ảnh review (SLA <= 24h).
  * `Minor`: Lệch màu, lệch icon, sai chính tả (Sprint tới).
* **Các bước tái hiện (Steps to Reproduce):** Ghi rõ từng bước 1, 2, 3 để Dev sửa nhanh nhất.
