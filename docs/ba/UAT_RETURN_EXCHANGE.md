# UAT đổi/trả hàng Velura: User và Admin

## 1. Kết luận, phạm vi và cách sử dụng

**Các chênh lệch triển khai so với BA ở §3 đã được đóng trong mã và kiểm chứng trên CSDL PostgreSQL 16 + PostgREST + API thật của một môi trường cô lập cục bộ** (storage riêng tư thay bằng fixture trong bộ nhớ; không ghi production). 114 ca UAT ở §7 vẫn **NOT_RUN** cho tới khi người dùng/CSKH chạy và ký theo §9/§11 — bằng chứng kỹ thuật ở §10 không thay thế chữ ký nghiệm thu.

Tài liệu này là bộ kiểm thử chấp nhận người dùng (UAT) cho mục **3.1.6**, **3.1.13** và phần tiền đề tra cứu/xác thực/hủy đơn trong **3.1.5** do người yêu cầu cung cấp. Không mở rộng sang đánh giá sản phẩm vì không có hợp đồng đánh giá trong nội dung đính kèm. Chuẩn kỳ vọng là BA, không phải hành vi hiện có của code.

| Thuộc tính | Giá trị |
|---|---|
| Ngày đối chiếu | 2026-10-29 |
| Nhánh | `feature/KAN-106-order-stage-evidence` |
| Revision đọc mã | Working tree sau migrations `084_return_item_workflow.sql`, `085_return_intake_policy.sql`, `086_return_loyalty_debt.sql` (chưa commit tại thời điểm ghi) |
| Quyền thao tác lần này | Đọc/sửa mã, chạy migration trên CSDL cô lập, smoke API và chạy test/build cục bộ |
| Không thực hiện | Không ghi production; không gọi SMS, thanh toán, vận chuyển thật; không chạy UAT trình duyệt với người dùng thật |
| Kiểm chứng thực thi | PostgreSQL 16 + PostgREST + handler API thật trong môi trường cô lập; SQL regression; `test:api` 729/729; `test:user` 313; `test:admin-erp` 216; `test:admin` 152; build toàn workspace |
| Giới hạn bằng chứng | Bằng chứng kỹ thuật cục bộ, chưa có chữ ký UAT hoặc provider receipt thật; chưa suy ra deployment production từ working tree |
| Trạng thái mọi ca UAT ở §7 | **NOT_RUN**, chưa phải PASS; §10 là bằng chứng kỹ thuật riêng |

**Cách chạy:** chuẩn bị §4 → chạy các hành trình §6 → chạy các ca chi tiết §7 → lưu kết quả theo §9 → quyết định nghiệm thu theo §11. Không bỏ qua ca đang thiếu chức năng: ghi FAIL nếu đã thao tác và quan sát sai; BLOCKED nếu chưa thể chạy do thiếu điều kiện.

### Charter đã xác lập trước khi chạy smoke

| ID | Hợp đồng / rủi ro | Điểm vào / phương pháp | Cô lập | Điều kiện dừng |
|---|---|---|---|---|
| C1 | Delivered + 7 ngày; rủi ro nhận yêu cầu quá hạn | Gọi hàm `returnWindowOpen` ở biên 7/30 ngày bằng Node + tsx, timeout 30 giây | Dữ liệu thời gian tổng hợp; không `.env`, DB hoặc mạng | Có output đối chiếu BA |
| C2 | Quyền, hoàn tiền, tiến độ item; rủi ro tiền trùng hoặc đóng sai request | Đọc UI/API/SQL và ghi file:line | Chỉ đọc mã, không chạy script demo | Có bằng chứng và ca tương ứng |
| C3 | Không bỏ sót BA User/Admin | Ánh xạ từng mã quy tắc với dữ liệu, thao tác, kỳ vọng | Chỉ ghi tài liệu này | Mỗi quy tắc có ca và có tiêu chí nghiệm thu |

## 2. Thiết kế có sát vận hành thực tế không?

**Khung nghiệp vụ phù hợp để triển khai:** tách đơn mua và hậu mãi; duyệt theo item; kiểm tra lại tồn; chỉ hoàn tất sau hiệu ứng tiền/giao hàng; kiểm tra bằng chứng nhiều bên; tách CSKH/Kho/Admin; không tự từ chối cả phiếu khi một item có vấn đề. Đây là đánh giá tính nhất quán nghiệp vụ, không phải chứng nhận tuân thủ pháp luật hoặc chính sách của mọi nhà bán lẻ.

Các điểm cần chốt trước khi ký UAT dưới đây không được tự coi là yêu cầu đã thống nhất:

| ID | Điểm chưa rõ / mâu thuẫn trong BA | Chuẩn tạm cho kịch bản và nội dung cần chốt |
|---|---|---|
| D01 | 7 ngày là 168 giờ hay ngày lịch; biên đúng hạn | Đề xuất `0 ≤ now − delivered_at ≤ 168 giờ`, thời gian server UTC, hiển thị giờ Việt Nam. Đúng biên nhận, quá 1 ms từ chối. Cần PO xác nhận; không gia hạn theo lúc Admin duyệt. |
| D02 | “Mỗi sản phẩm tối đa 2 lần” và “từng đơn vị sản phẩm” | Theo dõi quantity và lượt của phần hàng thực tế. Giữ lượt khi đang xử lý, tiêu lượt khi thành công. Cần quy tắc nhận diện phần hàng đổi lần hai, số lượng còn được trả sau hoàn tiền, thời hạn lần hai tính từ lần giao nào. Không chỉ đếm số request. |
| D03 | Ảnh + video tạo yêu cầu bắt buộc nhưng video đóng gói tự nguyện | Tách **video minh chứng ban đầu** theo RET-04/AD_REQ_03 khỏi **video đóng gói/bàn giao** tự nguyện theo AD_AUDIT_03. Không dùng thiếu video đóng gói để chặn nhận hoặc từ chối. Cần chốt định dạng/dung lượng/số file. |
| D04 | AD_REQ_02 chỉ Admin được duyệt nhưng chưa có ma trận capability cụ thể | CSKH ghi nhận và đề xuất, Admin có quyền đổi trả quyết định, kho ghi nhận hàng, tài chính xử lý tiền. Tên role kỹ thuật không tự chứng minh quyền duyệt; phải duyệt ma trận quyền thực tế. |
| D05 | PARTIALLY_APPROVED và IN_PROGRESS có thể đồng thời đúng | Phân biệt kết quả xét duyệt với tiến độ vận hành. Một item duyệt, một item từ chối: kết quả một phần; item duyệt còn xử lý: request vẫn đang xử lý. Không ép hai ý nghĩa vào một status làm mất thông tin. |
| D06 | Seal và tag/mác | AD_RECEIVE_01 không bắt buộc seal. Ghi nhận bao bì/niêm phong làm bằng chứng, không thay điều kiện sản phẩm còn tag/mác bằng điều kiện seal bắt buộc. |
| D07 | COD: mục User nói ngân hàng, mục Admin cho ngân hàng hoặc ví | Bắt buộc có kênh nhận hợp lệ. Ca ngân hàng là chuẩn chung; ví là ca điều kiện cần PO xác nhận có trong phạm vi. Không chặn gửi yêu cầu chỉ vì chưa có tài khoản; phải chặn chuyển tiền. |
| D08 | 4–5 ngày làm việc chưa có lịch nghỉ, mốc quá hạn và giờ cut-off | Mốc bắt đầu là thời điểm muộn hơn giữa nhận hàng hợp lệ và đủ thông tin nhận tiền. Cần lịch nghỉ áp dụng, cách đếm ngày đầu và ngưỡng cảnh báo chính thức. |
| D09 | TRK_OTP_03 được viện dẫn nhưng không có trong bảng | Chưa có giới hạn gửi lại/cooldown được duyệt. Không tự đặt con số; ca giới hạn gửi lại BLOCKED cho đến khi có chính sách. OTP 1 phút, sai tối đa 5 lần vẫn kiểm thử được. |
| D10 | Không lộ dữ liệu trước OTP nhưng trả “SĐT/mã không tồn tại” ngay | Thông báo tồn tại có thể dùng để dò danh sách khách. Cần PO/security chốt mức tiết lộ và chống dò; dù chọn cách nào vẫn không trả sản phẩm, tên, địa chỉ trước OTP. |
| D11 | Hoàn tiền item có voucher/Point/phí vận chuyển/combo | Dùng snapshot phân bổ lúc mua, không tính theo giá hiện tại. Cần chốt hoàn shipping, Point đã dùng, quà tặng/combo, làm tròn và đổi sang variant khác giá. Không tự thêm phụ phí, vì BA quy định không phí đổi/trả. |
| D12 | Hàng đổi giao thất bại, hư hỏng ngược và khách không gửi tiếp | Chưa phải kết quả thành công; cần dữ liệu phần quantity và đường xử lý lại/chuyển refund có đồng ý khách. Không tự đóng hoặc quy lỗi khách. |
| D13 | Kênh thông báo đổi trả và hoàn tiền | RET-15 chốt mốc, chưa chốt kênh. SMS bắt buộc ở mốc tạo đơn/đang giao theo TRK; kênh mốc hậu mãi phải được chốt, không tự suy diễn mọi mốc đều bắt buộc SMS. |

**D01–D13 là điểm cần phê duyệt tiêu chí, không phải lý do giảm phạm vi.** Ca phụ thuộc tiêu chí chưa rõ phải ghi BLOCKED, không thay kỳ vọng bằng code hiện tại.

## 3. Đối chiếu triển khai hiện có

Các dòng “tĩnh” là chênh lệch đọc mã; chưa khẳng định đã tái hiện qua UI/DB production.

| ID / mức rủi ro | Kỳ vọng BA | Quan sát và bằng chứng | Xác nhận / ca liên quan |
|---|---|---|---|
| GAP-01 / Cao | RET-01: 7 ngày | **Đã đóng.** `apps/api/src/user/return-window.ts` đặt `RETURN_WINDOW_DAYS=7`, biên bao gồm đúng 168 giờ; RPC intake 085 từ chối `delivered_at < now()-interval '7 days'`; mọi copy khách hàng đã đổi từ 30 sang 7 ngày. | Hàm thuần §10.1; `tests/api/return-window.test.ts`, `tests/api/order-return-eligibility.test.ts`; intake SQL 085. U02–U04. |
| GAP-02 / Cao | RET-05/06, AD_STATUS_01/02: kết quả và tiến độ item độc lập | **Đã đóng.** `velura_return_item_action` (084) khóa từng `return_item`, version riêng, tách quantity thành phần dư, action approve/reject/wait/pickup/receive/exchange; header chỉ là projection qua `velura_refresh_return_aggregate`. Admin ERP và storefront thao tác/theo dõi theo item. | SQL `tests/database/return-item-workflow.sql`; API `tests/api/return-item-api.test.ts`; admin 216 test; smoke E01/E02/E04 §10.2. A04–A06, M01–M08. |
| GAP-03 / Cao | AD_REQ_02: CSKH không mặc nhiên có quyền duyệt cuối | **Đã đóng.** API trả `RBAC_DENIED` cho approve/reject nếu role khác `super_admin`; DB `velura_require_return_actor(..., true)` cũng chỉ nhận `super_admin`; UI `canApprove` chỉ bật cho `super_admin`. CSKH vẫn ghi liên hệ/nghiệp vụ khác theo ma trận đã chốt. | SQL workflow (CSKH approve bị PT403); `tests/api/return-service.test.ts`; `admin-erp-returns.page.spec.ts`. A02/A03. |
| GAP-04 / Cao | AD_RECEIVE_01: không bắt buộc seal | **Đã đóng.** Receive bắt buộc ghi `sealIntact` boolean nhưng không từ chối khi false; chỉ QA thực tế (đúng hàng/tag/điều kiện/bao bì) quyết định RECEIVED; seal lưu để đối soát. | SQL workflow nhận `sealIntact:false` + restock; smoke E02 nhận hàng với seal false. L06/L07. |
| GAP-05 / Cao | TRK_AUTH_02: OTP tới SĐT đặt hàng; email không thay SMS | **Đã đóng.** `guest-order-session.ts` chỉ gửi email OTP ở chế độ dev; production không dùng email do caller gửi và trả 502 nếu SMS không gửi được. | `tests/api/guest-tracking-delivery.test.ts`; đọc mã. T02/T03/T15. |
| GAP-06 / Vừa | UAT phải dùng đúng môi trường và admin hiện hành | **Đã đóng trong tài liệu.** §4 dùng Admin ERP `/returns`, storefront `/account|/guest`; guide tài khoản đã thêm cảnh báo không dùng màn/approve cũ. | `docs/ba/UAT_ACCOUNTS_AND_TEST_GUIDE.md`; §4 tài liệu này. |
| GAP-07 / Cao | RET-04/AD_REQ_03: ảnh và video minh chứng ban đầu bắt buộc | **Đã đóng.** Intake service bắt buộc ≥1 ảnh và ≥1 video, từ chối URL công khai/trùng lặp; 085 xác minh từng `storage_ref` thuộc đúng đơn, đúng loại, chưa dùng, trong 24h; UI member/guest thu ảnh+video trước khi gửi. | `tests/api/return-intake.test.ts`; SQL intake 085; `order-flow.page.spec.ts`. U13/U15. |
| GAP-08 / Cao | AD_EXCHANGE_03: chuyển phương án riêng item, giữ type ban đầu | **Đã đóng.** `convert_refund` đổi `resolution_type` của đúng item, giữ `return_exchange.return_type`; yêu cầu consent + lý do; hoàn tất refund theo item. Chuyển trước bàn giao giữ `WAITING_RETURN`, đang vận chuyển giữ `RETURN_SHIPPING`. | SQL workflow (type vẫn exchange, sớm/đã nhận); smoke E04; `tests/api/return-item-api.test.ts`. X02–X04/E04. |
| GAP-09 / Cao | AD_REFUND_05: không thu hồi Point đã hết hạn/đã thu hồi | **Đã đóng.** 086 chỉ clawback trên `payment_refund.status='succeeded'`, mỗi operation một lần qua unique `payment_refund_id`, loại lot expired/reversed, cap theo earn còn sống; thiếu hụt vào debt + warning, không khóa mua/tích điểm. | `tests/database/return-loyalty-debt.sql`; `tests/api/loyalty.test.ts`. F12/F13. |
| GAP-10 / Cao | Full return cộng dồn nhiều request phải đảo referral, không phụ thuộc có Point thưởng | **Đã đóng.** 086 tính tổng quantity refund thành công trên toàn đơn (nhiều request), đảo referral và thu hồi voucher referrer kể cả `points_earned_milli=0`; exchange không tính là refund. | SQL loyalty-debt (fixture earned=0, hai request); API loyalty tests. F14/E06. |
| GAP-11 / Cao | Guest và Member bảo toàn lựa chọn, quantity và toàn vẹn request | **Đã đóng.** 085 tạo header + items + reserve unit + claim evidence trong một transaction; lưu `replacement_variant_id`, kiểm tồn cùng product; member và guest dùng chung RPC. | SQL intake 085; `tests/api/return-intake.test.ts`, `user-returns-service.test.ts`. U08/U17/X01. |
| GAP-12 / Vừa | BA quy ước chi phí và giảm giá đơn đổi bằng 0 | **Đã đóng.** `prepare_exchange` tạo replacement với `subtotal=0`, `discount_amount=0`, `total_amount=0`, `shipping_fee=0`, `unit_price=0`; stock trừ đúng quantity. | SQL workflow assertion dòng 90; `tests/api/return-item-api.test.ts`. X05. |
| GAP-13 / Vừa | Chờ khách giữ stage và có attention; cảnh báo liên hệ 24h | **Đã đóng.** Contact lưu `attention_status=waiting_customer`, `contact_history`, `last_contact_at`; `contact_due_at=+24h`; ERP hiển thị “Đã quá hạn liên hệ” và badge chờ khách theo item. | `admin-erp-returns.page.spec.ts` (quá hạn liên hệ); `return-repository.recordContact`; A09–A11/F11. |

### Phần đã có dấu vết triển khai, chưa đồng nghĩa UAT đạt

- `return-service.ts:43-63` có hợp đồng xử lý liên hệ, hoàn tiền thủ công/cổng, inbound shipment, pickup, outbound shipment và evidence.
- `apps/api/src/user/returns-service.ts:10-14,38-68` giới hạn hủy trước bàn giao, lọc một số trường nội bộ và dựng thông tin nhận tiền phía khách.
- `apps/api/src/user/order-access.ts:11-37` gắn quyền Guest với SĐT và token 15 phút, kiểm tra sở hữu ở thao tác khách; `guest-order-session.ts:191-205` phát session sau verify OTP.
- `docs/HOW-IT-WORKS.md:142-147,164-170` ghi nhận stock movement chống ghi lặp, đơn đổi liên kết và xử lý webhook riêng cho return. Cần UAT chứng minh các hiệu ứng lưu trữ và webhook thật.

## 4. Điều kiện vào UAT và dữ liệu chuẩn bị

### 4.1 Môi trường, danh tính và an toàn

Theo `docs/ARCHITECTURE.md:40-45` và `package.json:14-17`:

| Surface | Local | Lệnh được repo công bố | Chức năng |
|---|---|---|---|
| Storefront | `http://localhost:4002` | `npm run start:user` | Member/Guest |
| Admin ERP | `http://localhost:4003` | `npm run start:admin-erp` | Quản lý đổi trả |
| Admin cũ | `http://localhost:4001` | `npm run start:admin` | Kiểm tra link chuyển sang ERP, không chạy state machine cũ |
| API | `http://localhost:8787` | `npm run start:api` | API, webhook và kiểm chứng quyền |

Điểm vào thật: Member `/account/orders`, `/account/orders/:id`, `/account/returns`; Guest `/guest/orders`, `/guest/orders/:id`, `/guest/returns`; trang tra cứu `/account/track`. Các route dùng `OrderFlowPage` (`apps/user-ng/src/app/app.routes.ts:130-182`). Deep link dùng query `order`, không phải `order_id` (`order-flow.page.ts:190-207`). ERP dùng `/returns` (`apps/admin-erp-ng/src/app/app.routes.ts:60-65`). Không bật `?preview=1`: chế độ đó dùng demo adapter, không phải hệ thống thật. `returns.page.ts/html` cũ không phải surface nghiệm thu.

Production được map trong architecture: storefront `https://velura.royalai.dev`, ERP `https://admin-erp.royalai.dev`. **Không mặc nhiên dùng production để UAT ghi dữ liệu.** Repo không có release gate staging; cần môi trường cục bộ/cô lập do người phụ trách cấp, không tự tạo thêm quy trình triển khai.

Trước khi chạy, ghi base URL, build/commit từng app/API, phiên bản migration thực tế, timezone, lịch nghỉ, cấu hình payment sandbox và địa chỉ nhận SMS/email tổng hợp. Localhost có thể trỏ DB/provider production: phải xác nhận đích kết nối trước thao tác ghi. Không đưa token, OTP, tài khoản ngân hàng đầy đủ hoặc mật khẩu vào tài liệu/báo lỗi. Không dùng tài khoản bất kỳ lấy từ DB.

Không chạy `scripts/demo_return_e2e.ts` để chứng minh UAT: script lấy user/variant sẵn có rồi insert order/return, giả lập context quản trị và gọi các bước hoàn tiền (`:13-89,147-187`), bỏ qua điểm vào và quyền thực tế của User.

| Danh tính tổng hợp | Quyền mong đợi | Cách dùng |
|---|---|---|
| MEMBER_A / MEMBER_B | Hai khách độc lập | A sở hữu bộ đơn test; B thử sai chủ |
| GUEST_A / GUEST_B | Hai SĐT kiểm soát được, session riêng | A có ≥2 đơn cùng SĐT; B không có quyền với A |
| CSKH_ONLY | Xem hồ sơ, ghi liên hệ/đề xuất | Không quyền quyết định cuối trừ capability được phê duyệt |
| RETURN_ADMIN | Duyệt/từ chối theo item | Lưu người quyết định và lý do |
| WAREHOUSE | Nhận/kiểm hàng theo item | Không tự ghi nhận tiền hoặc quyết định ngoài quyền |
| REFUND_OPERATOR | Xử lý hoàn tiền, đọc thông tin nhận tiền được cấp | Chứng từ chuyển khoản sandbox |
| READ_ONLY / OTHER_ADMIN | Chỉ xem hoặc không có quyền đổi trả | Kiểm tra che thông tin và từ chối thao tác |

### 4.2 Bộ fixture

Tạo dữ liệu bằng kênh được người phụ trách cho phép trong DB test. Snapshot trước/sau cần có order/item/request, payment/refund, tồn khả dụng/đang giữ, lượt giữ/đã dùng, Point ledger, referral/voucher, shipment, notification, audit. Không cập nhật thời gian production để tạo biên.

| Mã | Dữ liệu |
|---|---|
| ORD-BASE | Đơn A đã delivered, `delivered_at = T0 − 2 ngày`, thanh toán paid; item I1 quantity 3, I2 quantity 2; chưa hậu mãi; đúng tag/mác. |
| ORD-ONLINE | Như BASE, online sandbox; lưu payment transaction và snapshot phân bổ thực trả. |
| ORD-COD | Như BASE, COD đã thu tiền; chưa có thông tin nhận tiền. |
| ORD-STATES | Bản sao ở waiting_payment, pending, confirmed, preparing, shipping, delivery_failed, cancelled. |
| ORD-TIME | Bản sao delivered tại T0; T0−7 ngày; T0−7 ngày−1 ms; T0−8 ngày; thiếu/future delivered_at. |
| ORD-GUEST | Hai đơn cùng GUEST_A; một đơn GUEST_B; một đơn cũ >30 ngày để tra cứu, không tạo return. |
| VAR | Cùng product P: size S/M/L, màu khác; một variant tồn 0, một variant tồn 1, một tồn ≥3. Product Q khác P cũng có variant tồn >0. |
| QUOTA | I1 có lịch sử 0/1/2 lượt thành công cho phần quantity tương ứng; có phần bị reject/cancel/không gửi; có request đang giữ. |
| MONEY | I1 mua 2 × 500.000đ = 1.000.000đ, ưu đãi tiền đã phân bổ 100.000đ, net paid item 900.000đ; snapshot mỗi đơn vị 450.000đ; I2 net 300.000đ; shipping tách riêng. Không trộn Point đã dùng vào fixture này. |
| POINT | Fixture riêng có ledger chứng minh số cần thu hồi R=120 Point còn hiệu lực, chưa thu hồi; balance trước 50; fixture khác có lô hết hạn/đã thu hồi. R phải được bộ phận nghiệp vụ xác nhận từ ledger, không tự suy ra tỷ lệ. |
| REFERRAL | Đơn đã làm referral Successful và có voucher của người giới thiệu; bản sao partial/full return; voucher chưa dùng/đã dùng/hết hạn theo chính sách thành viên được cấp. |
| MEDIA | Ảnh và video minh chứng hàng ban đầu; ảnh pickup có thời gian/người bàn giao; ảnh QA tag/mác; video đóng gói riêng có/không có; file hỏng và file không được hỗ trợ. Dùng dữ liệu tổng hợp. |
| BANK | Thông tin ngân hàng test hợp lệ được kênh sandbox cho phép; bộ thiếu holder/thiếu số/sai định dạng; ví test nếu D07 đã chốt. Không dùng tài khoản nhận tiền thật. |

Mỗi ca dùng bản sao fixture riêng hoặc reset có kiểm soát. Không tái sử dụng request đã hoàn tiền cho ca happy path tiếp theo. Với concurrency/webhook, dùng công cụ sandbox/API do team cấp, lưu idempotency/event ID và hiệu ứng DB; không tạo hook bỏ qua quyền production.

## 5. Trạng thái, tiền và các bất biến phải quan sát

### 5.1 Nhãn chuẩn BA

| Mã tham chiếu | Nhãn nghiệp vụ |
|---|---|
| REQUESTED | Đã ghi nhận yêu cầu |
| CONTACTING | Velura đang liên hệ |
| WAITING_RETURN | Chờ gửi hàng |
| RETURN_IN_TRANSIT | Hàng đang về Velura |
| RECEIVED | Velura đã nhận hàng |
| REFUND_PROCESSING | Đang xử lý hoàn tiền |
| REFUNDED | Hoàn tiền thành công |
| EXCHANGE_PREPARING | Đang chuẩn bị hàng đổi |
| EXCHANGE_SHIPPING | Đang giao hàng đổi |
| COMPLETED | Hoàn tất |
| NEEDS_SUPPORT | Cần Velura hỗ trợ |
| CANCELLED / REJECTED | Phân biệt khách hủy và bị từ chối, có lý do |
| PARTIALLY_APPROVED / IN_PROGRESS | Kết quả duyệt một phần / tiến độ đang xử lý; áp dụng D05 |

Tên mã có thể được nhóm thiết kế ánh xạ khác, nhưng không được làm mất ý nghĩa nghiệp vụ. Lưu riêng trạng thái item, kết quả duyệt, phương án cuối, quantity, attention và timeline. `waiting_customer` không thay thế bước nghiệp vụ. Không dùng state request để chặn item đủ điều kiện.

### 5.2 Bất biến

1. Đơn gốc luôn delivered; request có mã riêng, giữ liên kết hai chiều, không nhầm mã vận đơn với mã request.
2. Quantity đang giữ không được đồng thời xử lý ở request khác; lượt chỉ tiêu khi refund hoặc replacement delivery thành công. Reject/cancel/không gửi giải phóng đúng phần chưa thành công.
3. Request chỉ kết thúc khi mọi phần item có kết quả cuối; một item lỗi không kéo dừng item hợp lệ.
4. Tiền hoàn lấy snapshot thực trả của quantity được trả, không lấy giá hiện tại/nhập tay. Tổng hoàn thành công + đang giữ tiền không vượt khoản còn được hoàn của giao dịch gốc.
5. Với MONEY: trả 1 đơn vị I1 → 450.000đ; trả đơn vị thứ hai → thêm 450.000đ; không hoàn 500.000đ/đơn vị hoặc phân bổ lại giảm giá. Shipping/Point đã dùng xét riêng theo D11.
6. Với POINT: refund thành công thu hồi 120 từ balance 50 → −70; chỉ preview trước đó, không sửa ledger. Event lặp không thu hồi thêm. Không thu hồi lô hết hạn/đã thu hồi. Exchange không đổi Point.
7. Đơn đổi không doanh thu mới, phí/giảm giá bằng 0 theo BA, không cộng Point, vẫn có giá vốn/tồn/logistics truy vết theo mô hình thực tế; không sửa hóa đơn mua gốc.
8. `picked_up_at`/handover là mốc khóa tự hủy. Cạnh tranh hủy/bàn giao chỉ có một kết quả hợp lệ, không mất tracking hoặc hoàn sai lượt.
9. Lỗi provider/timeout không phải hoàn tiền thành công. Gửi lại không làm tiền, tồn, lượt, Point, referral hoặc notification phát sinh trùng ngoài chính sách.
10. Mọi quyết định/giao nhận/tiền có người hoặc nguồn sự kiện, thời điểm, trước/sau và bằng chứng; tài khoản nhận tiền/evidence không lộ cho sai người.

## 6. Hành trình nghiệm thu xuyên User–Admin

Chạy các hành trình với phiên trình duyệt riêng theo vai trò; reload sau mỗi mốc và đối chiếu API/DB test bằng quyền đọc được cấp. Giữ screenshot User/Admin và bản ghi hiệu ứng tiền/tồn/Point, không chỉ toast.

### E01. Member trả một phần, hoàn tiền Online

1. MEMBER_A mở Đơn hàng của tôi → ORD-ONLINE → Đổi/Trả; chọn I1 quantity 1, refund, lý do đổi ý, ảnh + video minh chứng.
2. Kiểm tra tiền 450.000đ và preview Point theo ledger; gửi một lần, ghi mã request; đơn gốc vẫn delivered; chưa trừ Point.
3. CSKH_ONLY mở ERP → đổi trả → mã vừa tạo; ghi liên hệ trong 24h, kết quả và bước tiếp; RETURN_ADMIN duyệt đúng item; khách thấy Chờ gửi hàng.
4. Tạo vận đơn hoàn; ĐVVC xác nhận pickup kèm định danh/thời gian/ảnh; khách thấy Hàng đang về Velura và không tự hủy được.
5. WAREHOUSE đối chiếu vận đơn, ảnh pickup, I1 quantity 1, tag/mác/tình trạng; ghi thực nhận và ảnh; không bắt video đóng gói tự nguyện.
6. REFUND_OPERATOR xử lý về giao dịch gốc, không duyệt refund lần hai. Khi provider còn pending: chưa hoàn tất/chưa trừ Point; khi success: đúng 450.000đ, điều chỉnh Point một lần, tiêu lượt quantity 1, rồi hoàn tất phần này.
7. Tab Đổi trả User/Admin cùng kết quả, timeline và số tiền; I1 còn lại/I2 không bị xử lý nhầm; đơn gốc không bị hủy.

### E02. Guest trả COD, bổ sung tài khoản sau nhận hàng

1. GUEST_A tra mã ORD-COD, xác thực OTP SMS; xem đơn cùng SĐT trong 15 phút, không thấy GUEST_B.
2. Gửi refund có ảnh/video, chưa có BANK. Tạo request hợp lệ; thiếu BANK chỉ ngăn chuyển tiền.
3. CSKH/Admin duyệt, pickup, kho nhận như E01; item ở xử lý refund, `attention_status=waiting_customer`, khách nhận nội dung cần bổ sung.
4. Guest bổ sung BANK bằng session hợp lệ; session hết hạn phải OTP mới. Sai BANK chưa được chuyển tiền; đúng BANK thì người có quyền thực hiện và ghi chứng từ sandbox.
5. Chỉ sau bằng chứng giao dịch thành công mới REFUNDED/COMPLETED; kiểm tra masking, lượt, lịch sử và đơn gốc.

### E03. Đổi hàng thành công

1. A chọn I1 quantity 1 → exchange → variant M cùng product còn hàng; gửi hồ sơ. CSKH/Admin duyệt, khách gửi hàng cũ, kho nhận hợp lệ.
2. Kiểm tra tồn lại; tạo đơn đổi liên kết request + đơn gốc, các khoản doanh thu/phí/giảm giá theo quy ước 0; giữ/trừ tồn nguyên tử để không bán quá.
3. Chuẩn bị và bàn giao hàng đổi: trạng thái Preparing → Shipping, khách thấy vận đơn. Không tính hoàn tất/lượt thành công lúc mới gửi.
4. Provider xác nhận giao thành công: item mới hoàn tất, tiêu lượt đúng quantity; không cộng/trừ Point hoặc doanh thu mới; request hoàn tất khi không còn item mở.

### E04. Đổi hết hàng sau khi nhận, chuyển một item sang refund

1. Tạo exchange khi VAR tồn 1, rồi cho giao dịch test khác tiêu tồn trước khi kho nhận. Giữ item thứ hai có thể tiếp tục.
2. Kho nhận, kiểm tra tồn lần hai phát hiện 0: không tạo đơn đổi vượt tồn, không hủy cả request; chuyển item cần hỗ trợ.
3. CSKH ghi đồng ý khách chọn refund; giữ request_type ban đầu exchange, cập nhật phương án cuối của item và history. Nếu COD, thu BANK hợp lệ.
4. Refund thành công mới thu hồi Point tương ứng, tiêu lượt và hoàn tất item; item khác tiếp tục không cần chờ giải quyết toàn phiếu.

### E05. Nhiều item, duyệt/nhận/kết quả khác nhau

1. Request I1 quantity 2 và I2 quantity 1; duyệt một phần, từ chối một phần có lý do; kết quả request thể hiện một phần, tiến độ vẫn mở.
2. Một phần hàng bàn giao và nhận đúng, phần khác sai số lượng/tag; ghi sai lệch theo phần và đưa cần hỗ trợ; phần đúng đi refund/exchange ngay.
3. Khách không tiếp tục gửi phần chưa bàn giao: CSKH ghi lượng dừng và giải phóng giữ phần đó, không ghi hàng đã nhận hay thành công.
4. Cố tự hủy toàn request bị từ chối vì đã bàn giao một phần. Khi mọi phần có kết quả cuối, tổng hợp request, tiền/lượt/tồn đúng từng phần.

### E06. Lỗi thanh toán, gửi lại và referral

1. Refund trên đơn REFERRAL sau QA hợp lệ; sandbox trả pending/failed rồi success. Không đánh dấu hoàn tất/thu hồi Point khi chưa success.
2. Gửi lại thao tác và webhook success cùng ID; đối chiếu một hiệu ứng tiền, Point và lượt. Kiểm tra request cạnh tranh không hoàn vượt khoản thực trả.
3. Partial refund không đảo referral như full return. Khi toàn bộ hàng của đơn được hoàn trả thành công qua một hoặc nhiều request, referral chuyển Reversed đúng một lần và voucher xử lý theo chính sách chương trình.
4. Đơn gốc vẫn delivered, timeline và thông báo cả User/Admin không báo thành công trước xác nhận.

## 7. Danh mục ca chi tiết

Mỗi dòng là một ca độc lập. `P0`: quyền/tiền/dữ liệu/lượt hoặc điều kiện cốt lõi; `P1`: vận hành/thông báo; `P2`: nhãn/tiện dụng. Tất cả bắt đầu **NOT_RUN**. Thực tế, bằng chứng, người chạy và bug ID ghi theo §9. “API” nghĩa là gọi điểm vào thực với tài khoản test, không giả context service. Nếu UI không cho thao tác, vẫn kiểm tra backend bằng công cụ được cấp; nếu chức năng chưa có, ghi giới hạn và không tự đánh PASS.

### 7.1 Tra cứu, OTP và hủy đơn mua hàng (tiền đề)

| ID / ưu tiên | Dữ liệu và thao tác | Kết quả mong đợi |
|---|---|---|
| T01 P0 | MEMBER_A đăng nhập, xem danh sách rồi chuyển giữa ≥2 đơn A, thử mở đơn B | Chỉ thấy đơn A; không OTP lại trong phiên; đơn B không trả dữ liệu. |
| T02 P0 | Guest tra mã ORD-GUEST trước OTP; xem response, UI và mạng | Chỉ challenge/thông báo an toàn, không tên/SĐT đầy đủ/sản phẩm/địa chỉ/tiền; OTP chỉ tới SĐT đặt đơn. Không hiển thị SĐT ở luồng mã theo BA. |
| T03 P0 | Guest tra SĐT A, chưa OTP; thử thêm email khác vào request; sau đó OTP đúng | Không lộ danh sách/mã đơn trước OTP; email do người tra nhập không được thành kênh vượt xác thực SĐT; sau OTP mới xem đúng danh sách. |
| T04 P0 | Nhập mã đơn không tồn tại và SĐT không có đơn | Báo không tìm thấy theo chính sách D10; cho nhập lại; không tính lần sai OTP và không trả nghiệp vụ. |
| T05 P0 | Challenge mới; nhập OTP đúng trước 60 giây; fixture riêng nhập tại/sau hết hạn | Trước hạn xác thực; mã hết hạn bị từ chối. Quy ước biên OTP phải chốt; không tự dùng TTL checkout thay TTL tracking. |
| T06 P0 | Challenge mới; nhập sai 4 lần, lần 5 sai, sau đó thử mã đúng cũ | Trước ngưỡng còn được thử; sai thứ 5 vô hiệu mã; mã cũ không thể cấp phiên. |
| T07 P1 | Yêu cầu gửi lại OTP rồi thử mã cũ/mã mới theo policy được duyệt | Giới hạn gửi lại/cooldown theo TRK_OTP_03 sau khi bổ sung; BLOCKED nếu chưa chốt, không tự gán số. |
| T08 P0 | OTP A thành công; phút 14 xem lại SĐT, chuyển mã đơn/AWB các đơn cùng A | Không OTP lại, xem đúng scope cùng SĐT; không mở rộng sang B. |
| T09 P0 | Session A hết 15 phút; xem/hủy/tạo return; rồi thử B khi session A còn hạn | Yêu cầu xác thực mới; ghi bị chặn, không hiệu ứng dữ liệu; xác thực B không tái dùng scope A sai. |
| T10 P0 | Guest session hợp lệ thử hủy đơn đủ điều kiện và tạo return ORD-GUEST delivered | Cho thao tác ghi theo điều kiện như Member; session không chỉ có quyền đọc. |
| T11 P0 | Member và Guest lần lượt hủy COD ở trạng thái được phép; dùng lý do có sẵn/khác | Đã hủy, lưu lý do, giải phóng giữ tồn một lần, không refund/không cần xét duyệt lý do. |
| T12 P0 | Hủy đơn Online đã paid nhưng chưa preparing; provider pending rồi success | Đơn hủy, tiền pending → xác nhận refund, thông báo khi xong; không coi COD và Online giống nhau. |
| T13 P0 | Đơn preparing/shipping/delivered; thử hủy ở UI và gọi API với version cũ | Không tự hủy từ preparing; không giải phóng tồn/hoàn tiền sai; lỗi cạnh tranh không ghi đè. |
| T14 P1 | Đơn Member/Guest không email; quan sát SMS lúc tạo và chuyển shipping; lặp với có email | SMS có mã đơn + link; shipping có AWB/link nếu có; email bổ sung không thay SMS, thiếu email không chặn. |
| T15 P0 | SMS/OTP không đến hoặc gateway lỗi; kiểm tra lối ra CSKH | Không tự mở chi tiết vì lỗi SMS; thông báo trung thực; có kênh hỗ trợ và xác minh trước tiết lộ. Không dùng email tùy ý thay OTP SĐT. |
| T16 P1 | Guest mất mã và đổi SĐT; CSKH tiếp nhận fixture riêng | Xác minh thông tin khác theo quy trình trước cung cấp; không lấy tên/địa chỉ đơn lẻ làm bằng chứng tự động đủ. |
| T17 P0 | Member có đơn mua khi chưa login; xem trước và sau xác minh SĐT | Không nhận đơn chỉ vì tự nhập trùng SĐT; sau xác minh đúng thì đồng bộ user_id và xuất hiện đúng tài khoản; tài khoản khác không nhận đơn. |
| T18 P1 | Guest tra đơn delivered >30 ngày bằng SĐT đã OTP | Vẫn xem được đơn; thời hạn tạo return không trở thành hạn tra cứu. |
| T19 P0 | Đơn thường thử chuyển lùi trạng thái hoặc chuyển vượt bước qua API | Chặn chuyển trái state machine; chỉ luồng giao lại được thiết kế cho delivery_failed có ngoại lệ. |
| T20 P1 | Đơn đang shipping/delivered và Member dùng Point; mở detail/reload | Hiển thị trạng thái/thời gian, sản phẩm/giao hàng/mã đơn/AWB, Point đã dùng/thưởng theo ledger; không cộng thưởng trước điều kiện. |

### 7.2 User tạo và theo dõi yêu cầu

| ID / ưu tiên | Dữ liệu và thao tác | Kết quả mong đợi |
|---|---|---|
| U01 P0 | ORD-STATES chưa delivered; tìm nút return và gọi API tạo | Không tạo request; không giữ lượt/tồn/tiền. |
| U02 P0 | ORD-TIME tại delivered_at và ngay trước hạn 7 ngày; gửi hồ sơ đủ | Được tạo theo D01, không lấy created_at đơn làm mốc. |
| U03 P0 | ORD-TIME đúng biên 168 giờ; gửi theo giờ server cố định | Được nhận nếu D01 được duyệt; giờ client không thay quyết định. |
| U04 P0 | ORD-TIME quá 7 ngày +1 ms và ngày 8; thử UI/API | Bị từ chối, không phiếu/hold; không cho 30 ngày nếu BA chưa đổi. |
| U05 P0 | Delivered thiếu delivered_at hoặc có thời gian tương lai | Không suy diễn thời hạn từ created_at hoặc giá trị client; chặn tạo, báo dữ liệu cần kiểm tra, không giữ lượt. |
| U06 P0 | QUOTA: từng phần 0/1/2 lượt thành công; mở danh sách và gửi phần hết lượt | Phần còn lượt chọn được; phần hết 2 lượt không chọn/gửi được; không ảnh hưởng phần còn lượt. |
| U07 P0 | ORD-BASE I1 q3; chọn q1 rồi thử q0, âm, thập phân, q4 và trùng dòng qua API | Chỉ quantity nguyên dương trong phần còn khả dụng; request sai không ghi dở hoặc giữ thừa. |
| U08 P0 | Member và Guest: request đang mở giữ I1 q2; tạo request khác cho phần đã giữ và q1 còn lại; thử hai lần gửi đồng thời | Không giữ trùng phần; q1 độc lập vẫn xử lý nếu còn điều kiện. Kiểm DB, không chỉ precheck UI; phiếu và item không được ghi dở khi một lần thất bại. |
| U09 P0 | QUOTA có reject/cancel/không gửi và có phần success | Phần thất bại không tiêu lượt; phần thành công vẫn giữ lượt đã dùng; lịch sử không bị xóa. |
| U10 P0 | Chọn I1 + I2, số lượng khác nhau; gửi refund rồi fixture khác exchange | Tạo mã request riêng và đủ Return Item, đúng order_item/quantity/type; không lấy item ngoài đơn. |
| U11 P0 | Exchange I1; thử variant M/màu khác cùng P và variant Q khác product | Cùng P được chọn nếu đủ tồn; khác P bị chặn cả API. |
| U12 P0 | VAR tồn 0/1/≥3; chọn q2 với tồn1, thử sửa payload | Tồn0 hiển thị hết hàng/disabled; tồn không đủ quantity không nhận; không chỉ kiểm tra >0 bỏ qua q. |
| U13 P0 | Lần lượt bỏ item, quantity, type, lý do, ảnh, video minh chứng ban đầu | Báo đúng phần thiếu, không request/hold; ảnh không thay video bắt buộc nếu D03 giữ nguyên. |
| U14 P1 | Lý do đổi ý và lý do khác có mô tả; hàng đủ chính sách | Không từ chối chỉ vì lý do không phải lỗi sản xuất; giữ nội dung khách cung cấp. |
| U15 P0 | Hồ sơ có ảnh + video ban đầu, không video đóng gói; gửi và tiếp tục pickup/QA | Không chặn vì thiếu video đóng gói tự nguyện; phân biệt hai loại video. |
| U16 P0 | MONEY + POINT; chọn refund q1, xem preview rồi quay lại/đóng form | Đúng tiền snapshot và Point dự kiến/balance âm; chưa tạo giao dịch thu hồi hoặc cờ cảnh báo. |
| U17 P0 | Member và Guest: gửi đủ hồ sơ, double-click/retry sau mất mạng; môi trường cô lập giả lập lỗi lưu item thứ hai bằng cơ chế test được cấp | Không tạo hold trùng/vượt quota hoặc header mồ côi; thất bại không để phiếu thiếu item. Không ép lỗi DB thật; nhánh fault injection BLOCKED nếu chưa có cơ chế an toàn. |
| U18 P1 | Request tạo thành công; mở từ đơn gốc, tab Đổi trả, vào lại mã request | Mã riêng, liên kết hai chiều, timeline và item đúng; đơn gốc không đổi delivered. |
| U19 P0 | Hủy request ở REQUESTED/CONTACTING/WAITING_RETURN; lặp thao tác | Cho hủy trước pickup, ghi khách hủy, giải phóng phần đang giữ một lần; không biến thành Admin từ chối. |
| U20 P0 | Request có pickup hoặc có một phần đã bàn giao; thử tự hủy toàn phiếu UI/API | Không tự hủy; hướng CSKH; giữ phần đã gửi tiếp tục xử lý, không giải phóng lượt phần đang đi. |

### 7.3 Admin xét duyệt và CSKH

| ID / ưu tiên | Dữ liệu và thao tác | Kết quả mong đợi |
|---|---|---|
| A01 P1 | Tạo 2 request cùng đơn; ERP list/search/detail và link ngược | Hai mã riêng, không ghi đè; thấy đúng khách/đơn/hồ sơ và request từ dữ liệu dùng chung. |
| A02 P0 | CSKH_ONLY ghi liên hệ/đề xuất rồi thử duyệt/từ chối qua UI/API | Ghi liên hệ được, quyết định cuối bị chặn nếu không capability Admin đổi trả; lưu hiệu ứng quyền thực tế. |
| A03 P0 | RETURN_ADMIN duyệt item, OTHER_ADMIN/READ_ONLY/Warehouse thử cùng API | Chỉ đúng capability được ghi; lưu actor/time/decision; không chỉ ẩn nút UI. |
| A04 P0 | Request có I1/I2; duyệt I1, reject I2 có lý do | Kết quả riêng, request một phần; I1 tiếp tục, I2 giải phóng hold và hiển thị lý do đúng khách. |
| A05 P0 | Reject toàn bộ item, thử không lý do rồi có lý do | Thiếu lý do bị chặn; đủ lý do thì kết thúc bị từ chối, không gắn thành khách hủy, không tiêu lượt. |
| A06 P0 | Item I1 đang refund, I2 cần hỗ trợ; thử thao tác hợp lệ I1 | Không bị chặn vì request đang hỗ trợ/khác stage; chưa đóng request khi I2 còn mở. |
| A07 P0 | Yêu cầu tạo trong 7 ngày, Admin mở ngày 9 | Đánh giá thời điểm tạo hợp lệ, không từ chối vì thời gian chờ xử lý vượt 7 ngày. |
| A08 P0 | CSKH chưa liên hệ thành công nhưng hồ sơ đủ; Admin duyệt không/có lý do | Không lý do bị chặn; có lý do được duyệt theo AD_REQ_05, không bắt xác nhận khách giả. |
| A09 P1 | Fixture trước/sau 24h chưa liên hệ | Có hạn và cảnh báo quá 24h; không tự hủy/reject. |
| A10 P1 | CSKH liên hệ 2 lần: không nghe máy, sau đó xác nhận | Lưu riêng actor/time/result/next action, giữ lịch sử; bắt đầu xử lý → CONTACTING. |
| A11 P1 | Cần khách thêm ảnh/thông tin; đánh waiting_customer rồi khách phản hồi | Giữ stage nghiệp vụ, có nội dung cần bổ sung hiển thị phù hợp, cập nhật attention khi có phản hồi. |
| A12 P0 | Mở hồ sơ thiếu chứng cứ/ngoài đơn/hết quota, sửa request bằng API | Kiểm tra lại hợp đồng ở backend; không duyệt phần sai hoặc dùng giá trị client thay source of truth. |
| A13 P0 | Hai Admin mở cùng version; duyệt/reject cạnh tranh | Một kết quả nhất quán; bên stale nhận conflict/reload, không mất quyết định hoặc hold. |
| A14 P1 | Đủ điều kiện duyệt và đã thống nhất gửi hàng | Item đủ điều kiện sang Chờ gửi hàng, không tạo pickup giả trước bàn giao. |
| A15 P0 | Reject/cancel một phần quantity q1 trong I1 q3 | Giải phóng đúng q1; phần q2 đã gửi/đã thành công không bị tác động. |
| A16 P1 | Đánh dấu cần hỗ trợ, đối soát xong rồi tiếp tục đúng nhánh | Có nội dung và lịch sử hỗ trợ; trở về bước hợp lệ, không yêu cầu làm lại bước đã lưu hoặc refund lần hai. |
| A17 P0 | Khách xác nhận không gửi phần còn lại; CSKH ghi nhận | Kết quả “Khách không tiếp tục đổi/trả”, giải phóng giữ đúng phần; không coi received/success. |
| A18 P0 | Có một phần đã bàn giao, Admin ghi khách ngừng phần chưa gửi | Không hủy toàn bộ; phần đã bàn giao tiếp tục, lịch sử/quantity truy vết được. |
| A19 P1 | Từ Admin cũ mở đổi trả rồi sang ERP | Điều hướng đúng ERP, không còn màn cũ ghi divergent state; giữ mã cần tra nếu có hỗ trợ. |
| A20 P0 | Trực tiếp gọi transition nhảy bước RECEIVED→COMPLETED hoặc REQUESTED→REFUNDED | Bị chặn nếu chưa đủ sự kiện thực nhận/thành công; không tạo hiệu ứng tiền/lượt/Point. |

### 7.4 Bàn giao, kho và bằng chứng

| ID / ưu tiên | Dữ liệu và thao tác | Kết quả mong đợi |
|---|---|---|
| L01 P1 | Item WAITING_RETURN; tạo vận đơn/nhãn, quét mã request và AWB | Mã request bất biến, AWB liên kết đúng; tạo nhãn chưa đồng nghĩa pickup. |
| L02 P0 | ĐVVC pickup với định danh, thời gian, ảnh kiện; xem hai phía | RETURN_IN_TRANSIT đúng item/phần; lưu đủ bằng chứng, khóa tự hủy theo bàn giao. |
| L03 P0 | Gửi pickup thiếu ảnh/time/identity hoặc AWB sai | Không ghi bàn giao hoàn chỉnh sai; yêu cầu bổ sung/đối soát, không trỏ sang đơn khác. |
| L04 P0 | Callback ĐVVC đã giao kiện về kho nhưng kho chưa kiểm | Phân biệt carrier delivered với QA thực nhận; không tự refund hoặc hoàn tất. |
| L05 P0 | Kho nhận đúng hàng/q/tag, đối chiếu AWB và ảnh; ghi receipt/proof | RECEIVED phần đủ điều kiện, lưu timestamp/actor/quantity/condition, đi hậu mãi được. |
| L06 P0 | Hàng nguyên tag/mác/không hỏng, bao bì không còn seal | Không từ chối chỉ vì seal; ghi tình trạng làm bằng chứng theo AD_RECEIVE_01. |
| L07 P0 | Hàng mất tag/mác, biến dạng hoặc khác sản phẩm | Ghi sai lệch và bằng chứng, chuyển phần liên quan CSKH đối soát; không tự fail toàn request. |
| L08 P0 | Duyệt q2, thực nhận q1; fixture khác q3 | Lưu lượng thực nhận và sai lệch, không khai nhận đủ giả; phần đúng xử lý độc lập; lượng thiếu/thừa không tự sinh quyền hoàn. |
| L09 P0 | I1 nhận đúng, I2 còn trên đường/sai hàng | I1 được đi refund/exchange ngay, không bắt mọi item cùng RECEIVED. |
| L10 P0 | Hàng hư do vận chuyển ngược; ảnh pickup nguyên vẹn, ảnh kho hỏng | Có biên bản và đối soát logistics; không mặc định lỗi khách/tự reject. |
| L11 P0 | Ghi nhận kho cùng chứng từ hai lần; kiểm tồn trước/sau | Không cộng tồn bán được trùng; disposition không bán được không nhập sellable. Không mặc định mọi hàng trả đều bán được. |
| L12 P0 | Thử mở evidence bằng Guest/Member khác, READ_ONLY, URL hết hạn | Không truy cập trái scope; URL ký hết hạn không còn dùng; không lộ bucket public/chứng từ nhạy cảm. |
| L13 P1 | Có và không có video đóng gói tự nguyện; tải file lỗi/không hỗ trợ | Có thì liên kết được, không có vẫn vận hành; file lỗi báo rõ không tạo bằng chứng giả thành công. |
| L14 P0 | Pickup và hủy cạnh tranh; callback lặp/sai thứ tự/sai AWB | Một quyết định nhất quán, không giải phóng giữ khi hàng đã bàn giao; return webhook không sửa nhầm trạng thái đơn mua. |

### 7.5 Hoàn tiền, Point và Referral

| ID / ưu tiên | Dữ liệu và thao tác | Kết quả mong đợi |
|---|---|---|
| F01 P0 | MONEY trả I1 q1; đổi giá hiện tại lên 700.000đ rồi tính refund | Vẫn 450.000đ từ snapshot; không sửa tay để tăng khoản hoàn; không phí đổi/trả. |
| F02 P0 | MONEY đã refund một đơn vị; tiếp tục phần còn hợp lệ | Hoàn thêm đúng 450.000đ, tổng I1 không quá 900.000đ; không phân bổ ưu đãi lần hai. |
| F03 P0 | Nhận hợp lệ Online có payment transaction; bắt đầu refund | Hoàn đúng giao dịch/phương thức gốc, không yêu cầu BANK, không cần bước phê duyệt độc lập lần hai. |
| F04 P0 | Provider trả pending/timeout/failed; reload User/Admin | Tiếp tục REFUND_PROCESSING/hỗ trợ phù hợp, chưa COMPLETED/chưa thu hồi Point; khách biết chưa xong. |
| F05 P0 | Provider xác nhận success, gồm webhook lặp hoặc đến muộn | REFUNDED rồi phần hoàn tất; lưu reference/amount/time; chỉ một hiệu ứng tiền, lượt và Point. |
| F06 P0 | COD đã nhận hàng nhưng chưa BANK; thử ghi refund trực tiếp | Giữ giai đoạn refund và chờ bổ sung; không chuyển khoản/REFUNDED/COMPLETED giả. |
| F07 P0 | COD BANK thiếu/sai/đúng; khách cập nhật trong session hợp lệ | Chỉ dữ liệu hợp lệ cho xử lý tiếp; có lịch sử thay đổi, không mất receipt/hồ sơ. |
| F08 P0 | REFUND_OPERATOR ghi chuyển khoản success sandbox với chứng từ/reference; thử thiếu bằng chứng | Chỉ đủ bằng chứng xác nhận mới thành công; thiếu chứng từ không thể hoàn tất; quyền không phù hợp bị chặn. |
| F09 P0 | COD chuyển khoản failed rồi gửi lại; Online retry sau mất response | Không gửi hai khoản tiền; đối soát trạng thái giao dịch trước retry khi kết quả chưa rõ, giữ pending đến xác nhận. |
| F10 P0 | Hai request/người xử lý đồng thời refund vượt phần còn thực trả | Giao dịch nguyên tử/giữ khoản hoàn ngăn vượt; conflict không để ledger/tiền sai. |
| F11 P1 | Nhận hàng đủ thông tin tại thứ Sáu, fixture có ngày nghỉ; tính SLA | Mốc bắt đầu đúng, 4–5 ngày làm việc theo D08; cảnh báo quá hạn, không tự nhận thành công. BLOCKED nếu lịch/biên chưa chốt. |
| F12 P0 | POINT preview rồi REQUESTED/RECEIVED/pending và cuối cùng success | Chỉ success mới thu hồi R=120, balance 50→−70; không cờ tích điểm chỉ vì tạo request. |
| F13 P0 | Ledger có Point hết hạn/đã thu hồi; lặp success và kiểm ví/history | Không thu hồi các phần đã hết hạn/đã thu hồi hoặc trừ trùng; lịch sử tham chiếu đúng item/refund. |
| F14 P0 | Partial return REFERRAL rồi full return qua nhiều request; lặp với đơn referral Successful nhưng earned=0 | Partial không đảo như toàn bộ; đủ full return success mới Reversed một lần kể cả earned=0; voucher xử lý theo chính sách chương trình được cấp. |
| F15 P0 | Exchange thuần từ đầu đến giao thành công | Không cộng/thu hồi Point, không tạo refund hoặc đảo referral vì riêng thao tác đổi. |
| F16 P0 | READ_ONLY/CSKH không quyền tiền/Member khác đọc BANK/proof/API/list/export | Chỉ vai trò xử lý được cấp thấy đầy đủ; vai trò khác che hoặc không trả, không chỉ che CSS. |

### 7.6 Đổi hàng và xử lý hết hàng

| ID / ưu tiên | Dữ liệu và thao tác | Kết quả mong đợi |
|---|---|---|
| X01 P0 | Member và Guest: exchange sang variant cùng P khác variant mua, còn đủ tồn; gửi rồi mở lại User/Admin và kiểm DB | Lưu đúng replacement_variant_id, size/màu/quantity đã chọn; không rơi về variant gốc. Không mặc định tồn lúc đăng ký đảm bảo lúc xử lý. |
| X02 P0 | VAR tồn1 lúc tạo rồi 0 lúc kho nhận | Kiểm tra lại, không tạo đơn đổi vượt tồn; chuyển item hỗ trợ, không hủy toàn phiếu. |
| X03 P0 | X02; CSKH ghi đồng ý đổi sang variant khác còn hàng cùng P | Lưu phương án/lịch sử, kiểm lại tồn mới, tiếp tục không yêu cầu hủy tạo lại request. |
| X04 P0 | X02; khách đồng ý chuyển refund | Request giữ loại exchange ban đầu; item lưu phương án refund; tiền và Point theo nhánh refund thực tế, không theo type request cũ. |
| X05 P0 | Nhận hàng cũ hợp lệ và variant còn đủ tồn; chuẩn bị exchange | Đơn đổi liên kết parent/source return và đúng quantity/variant/khách; không doanh thu/phí/discount mới theo BA. |
| X06 P0 | Hai item/request cạnh tranh lấy variant tồn1 | Chỉ một giữ/lấy được tồn; còn lại hỗ trợ/chọn lại, không âm tồn/bán vượt. |
| X07 P1 | EXCHANGE_PREPARING→bàn giao ĐVVC | Lưu đóng gói/ảnh/bàn giao/AWB, khách thấy EXCHANGE_SHIPPING, chưa hoàn tất. |
| X08 P0 | Carrier giao thành công sản phẩm thay thế; callback lặp | Item hoàn tất, tiêu lượt đúng phần một lần; request chỉ kết thúc nếu không còn item mở. |
| X09 P0 | Carrier báo giao thử thất bại rồi giao lại thành công | Chưa tiêu lượt thành công/đóng item khi failed_retrying; có lịch sử lần giao và kết quả cuối đúng. |
| X10 P0 | Carrier giao đổi thất bại cuối, hàng quay về | Cần hỗ trợ; CSKH thống nhất giao lại/refund, không COMPLETED trước một kết quả thành công. |
| X11 P0 | Gửi callback sai đơn/AWB hoặc dùng returnCode trùng/không khớp | Từ chối/xử lý conflict không cập nhật nhầm đơn gốc; giữ trace kiểm tra. |
| X12 P0 | Khách đổi lần hai sau giao hàng thay thế | Theo hợp đồng D02 đã chốt; không reset quota bằng order con; nếu chưa có quy tắc lineage/thời hạn thì BLOCKED, không tự coi đơn đổi là đơn mua mới. |

### 7.7 Tổng hợp nhiều item, đồng bộ và audit

| ID / ưu tiên | Dữ liệu và thao tác | Kết quả mong đợi |
|---|---|---|
| M01 P0 | I1 approved, I2 rejected | Kết quả một phần; phần approved tiếp tục, không REJECTED toàn phiếu. |
| M02 P0 | I1 REFUND_PROCESSING, I2 WAITING_RETURN | Request IN_PROGRESS/tương đương đã chốt; cả hai item hiển thị đúng stage, không ép cùng bước. |
| M03 P0 | I1 refund success, I2 exchange shipping | Không COMPLETED request; I1 không bị rollback hoặc refund lại, I2 chưa tiêu lượt. |
| M04 P0 | Một item quantity3: q1 received+refund, q1 đang gửi, q1 khách không gửi | Lưu kết quả theo từng phần quantity; q1 thành công tiêu lượt, q1 đang gửi giữ, q1 không gửi giải phóng; không gộp sai. |
| M05 P0 | Mọi item có kết quả cuối gồm success/reject/không gửi | Request kết thúc tương ứng, vẫn thấy kết quả riêng và tổng tiền/quantity; không gọi tất cả thành công. |
| M06 P0 | Một item NEEDS_SUPPORT, item khác đủ hậu mãi | Item hợp lệ tiếp tục; request còn mở, không tự reject hoặc đóng hỗ trợ cả phiếu. |
| M07 P0 | Một đơn nhiều request mở/đã kết thúc; mở cả User/Admin | Không cộng nhầm lượt/tiền giữa item/request; mỗi request có mã và timeline riêng. |
| M08 P0 | Hoàn một phần rồi hủy/ngừng phần chưa gửi | Không đảo tiền/Point/lượt đã thành công; chỉ giải phóng hold phần được dừng hợp lệ. |
| M09 P1 | Qua các mốc REQUESTED, CONTACTING, RECEIVED, REFUND_PROCESSING, EXCHANGE_SHIPPING, COMPLETED | Có notification tới đúng khách ở từng mốc áp dụng; không thiếu/nhầm người; kiểm User và nguồn gửi, không chỉ toast Admin. |
| M10 P0 | User/Admin mở cùng mã, cập nhật rồi reload/quay lại từ đơn gốc | Cùng nguồn state/quantity/tiền/AWB; không tiến trình giả phía client; đơn gốc luôn delivered. |
| M11 P1 | Duyệt/reject, contact, pickup, receipt, refund, đổi phương án và carrier callback | Truy được actor/source/time/trước-sau/reason/evidence theo mã; không mất lịch sử hoặc lộ note nội bộ cho khách. |
| M12 P1 | Mất mạng sau submit/receive/refund rồi mở lại; timeout notification/evidence | UI báo trung thực, đối soát dữ liệu đã lưu, không thao tác lại hiệu ứng đã thành công; lỗi phụ không tạo thành công giả hoặc xóa hồ sơ. |

## 8. Ma trận truy vết quy tắc và ngoại lệ

Mã có thể dùng chung một ca nhưng không bỏ kiểm từng điều kiện trong dòng quy tắc. Nhóm ngoại lệ trùng nội dung vẫn được ánh xạ, không tạo hai ca giống nhau để tăng số lượng.

### 8.1 Quy tắc User và tiền đề

| Quy tắc BA | Ca UAT |
|---|---|
| TRK_STATUS_01 | T19 |
| TRK_AUTH_02 | T02, T03, T15 |
| TRK_AUTH_03 | T09, T10 |
| TRK_AUTH_04 | T08, T09 |
| TRK_OTP_01 | T05 |
| TRK_OTP_02 | T06 |
| TRK_NOTI_01 | T14 |
| TRK_NOTI_02 | T14, T15 |
| TRK_NOTI_03 | T14 |
| TRK_CSKH_01 | T15, T16 |
| RET-01 | U01–U05, A07 |
| RET-02 | U06–U09, A15, X12, M04 |
| RET-03 | U11, U12, X01 |
| RET-04 | U07, U10, U13–U15 |
| RET-05 | A04, A06, L09, M04 |
| RET-06 | M01–M06 |
| RET-07 | A01, A09, A10 |
| RET-08 | L01–L05 |
| RET-09 | L05–L10 |
| RET-10 | F03–F05 |
| RET-11 | F06–F08 |
| RET-12 | U16, F12, F13 |
| RET-13 | U12, X01, X02, X06 |
| RET-14 | X02–X04 |
| RET-15 | M09 |

`TRK_OTP_03` chỉ được viện dẫn trong ngoại lệ, chưa được định nghĩa: T07/D09 là tiêu chí còn chờ chốt, không tạo quy tắc giả.

### 8.2 Quy tắc Admin

| Quy tắc BA | Ca UAT |
|---|---|
| AD_REQ_01 | A01, U18, M07 |
| AD_REQ_02 | A02, A03, A13 |
| AD_REQ_03 | U01–U07, U13, U14, A07, A12 |
| AD_REQ_04 | A04, A05, M01 |
| AD_REQ_05 | A08 |
| AD_CSKH_01 | A09 |
| AD_CSKH_02 | A10 |
| AD_CSKH_03 | A11, F06, F07 |
| AD_LIMIT_01 | U06, U08, F05, X08, M04 |
| AD_LIMIT_02 | U09, U19, A15, A17, M08 |
| AD_RECEIVE_01 | L01–L10 |
| AD_RECEIVE_02 | L09, A06, M02–M04 |
| AD_RECEIVE_03 | A17, A18, M04 |
| AD_REFUND_01 | F01, F02 |
| AD_REFUND_02 | F03, F06–F08 |
| AD_REFUND_03 | F11 |
| AD_REFUND_04 | F03, A20 |
| AD_REFUND_05 | F04, F05, F12, F13, F15 |
| AD_EXCHANGE_01 | U11, X01, X02, X06 |
| AD_EXCHANGE_02 | X05, X07, M10 |
| AD_EXCHANGE_03 | X04 |
| AD_EXCHANGE_04 | X07–X10 |
| AD_STATUS_01 | A06, M01–M04, M06 |
| AD_STATUS_02 | M02–M06 |
| AD_STATUS_03 | U18, M10 |
| AD_AUDIT_01 | U18, L02, X07, M09, M10 |
| AD_AUDIT_02 | F16, L12 |
| AD_AUDIT_03 | A10, L02, L05, L13, M11 |

### 8.3 Ngoại lệ và nội dung mô tả không có mã riêng

| Nguồn / tình huống | Ca UAT |
|---|---|
| 3.1.5 ngoại lệ 1: mã không tồn tại | T04 |
| 3.1.5 ngoại lệ 2–3: OTP sai/hết hạn | T05, T06 |
| 3.1.5 ngoại lệ 4–5: không nhận OTP/SMS gateway lỗi | T07, T15 |
| 3.1.5 ngoại lệ 6: mất mã và SĐT | T16 |
| 3.1.5 ngoại lệ 7: Member mua lúc chưa login | T17 |
| 3.1.5 ngoại lệ 8: đơn hoàn tất từ lâu | T18 |
| 3.1.6 ngoại lệ 1 và 4: variant hết hàng | X02–X04 |
| 3.1.6 ngoại lệ 2: thực nhận không khớp | L07–L09, M04 |
| 3.1.6 ngoại lệ 3: item kết quả khác nhau | A04, M01–M06 |
| 3.1.6 ngoại lệ 5: refund failed/pending | F04, F05, F09 |
| 3.1.6 ngoại lệ 6: COD thiếu/sai tài khoản | F06, F07 |
| 3.1.6 ngoại lệ 7: hư hỏng vận chuyển ngược | L10 |
| 3.1.6 ngoại lệ 8: hủy sau bàn giao | U20, L14 |
| 3.1.13 ngoại lệ 1: CSKH không liên hệ được | A08–A11 |
| 3.1.13 ngoại lệ 2: hủy sau gửi một phần | A18, U20, M08 |
| 3.1.13 ngoại lệ 3: hàng thiếu/không khớp | L07–L09, M04 |
| 3.1.13 ngoại lệ 4: COD thiếu thông tin | F06, F07 |
| 3.1.13 ngoại lệ 5: refund thất bại | F04, F09, F10 |
| 3.1.13 ngoại lệ 6: variant hết hàng | X02–X04 |
| 3.1.13 ngoại lệ 7: giao đổi thất bại | X09, X10 |
| Hủy đơn Member/Guest, COD/Online, khóa từ preparing | T10–T13 |
| Phiên Guest dùng cho thao tác đổi/trả | T08–T10, E02 |
| Preview Point âm, không điều chỉnh lúc tạo | U16, F12 |
| Referral full return và voucher | F14, E06 |
| Đơn đổi không doanh thu, không Point | X05, F15 |
| Khách ngừng phần chưa gửi, quota quantity | A17, A18, M04, M08 |

## 9. Ghi kết quả, bằng chứng và báo lỗi

Dùng bảng dưới bằng cách thêm một dòng cho **từng** ca §7 sau khi chạy, không sửa cột kỳ vọng để hợp thức hóa hành vi. Mỗi hành trình E01–E06 có kết quả riêng, không thay kết quả từng ca.

| Run ID | Case ID | Build UI/API + migration | Actor / fixture / order / request / item | Thời điểm + timezone | Thực tế quan sát | Kết quả | Bằng chứng trước/sau | Bug ID | Người chạy / retest |
|---|---|---|---|---|---|---|---|---|---|

- **PASS**: đã thao tác, quan sát đủ kỳ vọng và hiệu ứng lưu trữ; chỉ thấy HTTP 200 hoặc toast không đủ.
- **FAIL**: đã thao tác và có bằng chứng khác hợp đồng; giữ nguyên lần fail khi retest.
- **BLOCKED**: thiếu môi trường, quyền, provider sandbox, fixture hoặc tiêu chí được phê duyệt; ghi rõ điều kiện mở khóa và owner.
- **NOT_RUN**: chưa thực hiện. Không tính “có code/test” là đã chạy.
- **N/A**: chỉ dùng khi PO ký lý do ngoài phạm vi, không dùng cho tính năng còn thiếu.

Bằng chứng tối thiểu: ảnh trước/sau User và Admin đúng mã; request/response đã loại token/PII; snapshot trạng thái từng item/quantity/holds; payment/refund transaction reference và số tiền; stock/Point ledger/referral diff; notification receipt; audit actor/source/time. Với ca lặp/cạnh tranh, lưu thứ tự event, event ID, version và số hiệu ứng, không chỉ trạng thái cuối. Dữ liệu nhạy cảm lưu kho evidence phân quyền, không commit vào repo.

Mẫu bug:

```text
ID / tiêu đề:
Case và rule BA:
Mức ảnh hưởng (P0/P1/P2) / owner:
Môi trường, UI/API build, migration, timezone:
Vai trò, dữ liệu tổng hợp và trạng thái ban đầu:
Bước 1 / 2 / 3:
Mong đợi:
Thực tế:
Hiệu ứng tiền / quantity / lượt / tồn / Point / referral:
Evidence đã che thông tin nhạy cảm:
Tần suất đã quan sát (không suy đoán):
Retest build / kết quả / evidence mới:
```

## 10. Bằng chứng kiểm tra đã chạy trong lần lập tài liệu

### 10.1 Hàm thời hạn 7 ngày

Chạy một lần trên working tree hiện tại, output giữ nguyên:

```json
{
  "surface": "local pure business function",
  "configuredDays": 7,
  "cases": [
    { "elapsedMs": -1, "allowed": false, "expectedBA": false },
    { "elapsedMs": 0, "allowed": true, "expectedBA": true },
    { "elapsedMs": 604800000, "allowed": true, "expectedBA": true },
    { "elapsedMs": 604800001, "allowed": false, "expectedBA": false },
    { "elapsedMs": 691200000, "allowed": false, "expectedBA": false },
    { "elapsedMs": 2592000000, "allowed": false, "expectedBA": false },
    { "elapsedMs": 2592000001, "allowed": false, "expectedBA": false }
  ]
}
```

| Hợp đồng | Quan sát | Kết luận |
|---|---|---|
| Trước delivered | −1 ms trả false | Phù hợp |
| Đúng biên 7 ngày | 604.800.000 ms trả true | Phù hợp D01 |
| Quá 7 ngày 1 ms, ngày 8, ngày 30 | đều false | **Phù hợp RET-01** |

### 10.2 Smoke tích hợp cô lập (PostgreSQL 16 + PostgREST + API thật)

Môi trường dựng tạm, không phải production: container PostgreSQL 16 riêng, PostgREST trên cổng riêng và `handleApiRequest` thật của `apps/api/src/server.ts`; chỉ **object storage riêng tư** được thay bằng fixture trong bộ nhớ (`scratch/return-flow-uat/http-runtime.mjs`, không đưa vào sản phẩm). Migration áp theo thứ tự 001→080 baseline + 084→086. Không gọi SMS, thanh toán hay vận chuyển thật.

| Bước | Thao tác thật qua API | Kết quả đọc từ DB/API |
|---|---|---|
| E01 | Member tạo request `exchange` với ảnh+video intake đã claim; super-admin duyệt 1 đơn vị, từ chối phần dư | Request `PARTIALLY_APPROVED` / `IN_PROGRESS`; hai dòng độc lập `APPROVED` và `REJECTED`, version riêng |
| E02 | `wait_return` → `pickup` (carrier + tracking + người nhận + thời điểm + ảnh `storage://.../returns/<id>/pickup/...`) → `receive` với `sealIntact=false` | Dòng `RETURN_SHIPPING` rồi `RECEIVED`; seal false vẫn nhận vì QA đạt; event/audit ghi actor + IP |
| E04 | `convert_refund` có `customerConsent` trên dòng đã nhận | `return_exchange.return_type` vẫn `exchange`; dòng chuyển `resolution_type=refund`, `REFUND_PENDING` sau prepare, refundable 200.000đ |
| F04 | Upload chứng từ `refund_proof` riêng tư rồi `manual-refund` đúng version dòng | `payment_refund.status=succeeded`, dòng `COMPLETED`, `refund_amount=200000`, request `COMPLETED` |
| F05 | Gọi lại đúng reference/số tiền sau khi hoàn tất (version cũ) | HTTP 200, `idempotent=true`, không tạo giao dịch thứ hai; reference khác trả `409 REFUND_ALREADY_REQUESTED` |

Fixture dùng cho smoke: return `ac68aa66-090f-4d8e-8cde-1d1b636b1bd3`, dòng hoàn tiền `f8007938-334c-4048-b8f6-c8e25f0f2397`; DB kết thúc ở `COMPLETED`, `return_type=exchange`, `refund_amount=200000`. Dòng còn lại giữ `REJECTED` — chứng minh kết quả từng phần không bị header ghi đè.

### 10.3 Cổng kiểm tra tự động

| Cổng | Kết quả |
|---|---|
| SQL regression trên CSDL mới (084→086) | `tests/database/return-item-workflow.sql`, `return-intake-policy.sql`, `return-loyalty-debt.sql` — pass |
| `npm run typecheck:api` | pass |
| `npm run test:api` | 729/729 pass |
| `npm run test:user` | 313/313 pass (54 file) |
| `npm run test:admin-erp` | 216/216 pass (31 file) |
| `npm run test:admin` | 152/152 pass (26 file) |
| `npm run build` | pass cho API + user + admin + admin-erp |

### 10.4 Giới hạn

- Chưa chạy UAT trình duyệt với người dùng/CSKH thật; các ca §7 vẫn **NOT_RUN**.
- Không gọi Stripe sandbox, SMS, carrier thật; nhánh Stripe chỉ được kiểm bằng unit test với `fetch` giả.
- Không áp migration 084–086 lên production trong phạm vi tài liệu này; việc phát hành phải qua PR → `develop` → `main`/Flux và migration có owner approval.
- Bằng chứng trên là môi trường cô lập cục bộ; không suy ra trạng thái production từ working tree.

## 11. Điều kiện kết thúc và ký nghiệm thu

Chỉ kết luận **đạt** khi:

1. PO chốt D01–D13; mọi quyết định làm thay chuẩn BA phải có bản thiết kế được duyệt, không tự theo code hiện hành.
2. Mọi ca trong phạm vi đã chạy; toàn bộ P0/P1 PASS; không còn lỗi quyền, tiền, quota/quantity, Point/referral, item independence, trạng thái đơn gốc hoặc evidence chưa xử lý.
3. E01–E06 chạy xuyên UI thật và API/DB/provider sandbox tương ứng, có bằng chứng trước/sau. Test giả hoặc đọc mã không thay thế.
4. Mọi mã quy tắc §8 có kết quả liên kết; không còn BLOCKED/NOT_RUN của yêu cầu bắt buộc. P2 còn lại chỉ chấp nhận khi có waiver rõ tác động, owner và thời hạn.
5. Retest lỗi trên build mới, chạy lại đường ảnh hưởng và kiểm tra chống lặp/cạnh tranh tiền/tồn/lượt; giữ lịch sử fail.
6. User/Admin thống nhất kết quả từng item; tổng tiền/lượt/Point/referral khớp ledger; không còn đơn/phiếu test gây thanh toán hoặc thông báo thật ngoài phạm vi được cấp.

| Vai trò ký | Nội dung chịu trách nhiệm | Họ tên / build / ngày / quyết định |
|---|---|---|
| PO/BA | Chính sách và D01–D13, kết quả từng quy tắc | Chưa ký |
| Đại diện User/CSKH | Trải nghiệm tra cứu/tạo yêu cầu/liên hệ và thông báo | Chưa ký |
| Admin/Kho | Duyệt theo item, giao nhận, đối soát quantity và bằng chứng | Chưa ký |
| Tài chính/Loyalty | Tiền, Point, referral/voucher và chống lặp | Chưa ký |
| QA Lead | Truy vết ca, evidence, retest và phạm vi còn thiếu | Chưa ký |

**Trạng thái bàn giao tài liệu: DONE_WITH_CONCERNS. Trạng thái nghiệm thu tính năng: CHƯA NGHIỆM THU.** Không có xác nhận hệ thống production đã đáp ứng luồng BA.
