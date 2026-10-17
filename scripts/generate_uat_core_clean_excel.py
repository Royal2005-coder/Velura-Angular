import os
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

def build_core_uat_workbook():
    wb = openpyxl.Workbook()
    
    # ------------------ PALETTE & FONTS ------------------
    FONT_NAME = "Calibri"
    
    NAVY_DARK = "1E293B"    # Slate 800 - Primary Brand Navy
    GOLD_BROWN = "7D562D"   # Velura Gold Brown
    ACCENT_BLUE = "0284C7"  # Sky Blue
    BORDER_LIGHT = "E2E8F0" # Slate 200 border
    
    STATUS_PASS_FILL = "DCFCE7"    # Green 100
    STATUS_PASS_FONT = "166534"    # Green 800
    STATUS_FAIL_FILL = "FEE2E2"    # Red 100
    STATUS_FAIL_FONT = "991B1B"    # Red 800
    STATUS_UNTESTED_FILL = "F1F5F9"# Slate 100
    STATUS_UNTESTED_FONT = "475569"# Slate 600

    thin_border = Border(
        left=Side(style='thin', color=BORDER_LIGHT),
        right=Side(style='thin', color=BORDER_LIGHT),
        top=Side(style='thin', color=BORDER_LIGHT),
        bottom=Side(style='thin', color=BORDER_LIGHT)
    )
    header_border = Border(
        left=Side(style='thin', color='475569'),
        right=Side(style='thin', color='475569'),
        top=Side(style='medium', color='0F172A'),
        bottom=Side(style='medium', color='0F172A')
    )

    # =========================================================================
    # 6 CORE TABS DEFINITIONS (Strictly Core E-commerce - No AI, No Dashboard)
    # =========================================================================
    tabs_data = [
        {
            "sheet_name": "1. Thêm Giỏ Hàng & PDP",
            "tester_code": "Tester 01",
            "tester_name": "Nguyễn Thị Ánh",
            "persona": "Khách Mua Sắm Online (Shopper)",
            "flow_title": "QUY TRÌNH 1: KHÁM PHÁ SẢN PHẨM, BIẾN THỂ PDP, KHÓA HẾT HÀNG & THÊM GIỎ HÀNG NHANH",
            "account_info": "Khách vãng lai & Thành viên: shopper.uat@velura.test / Pass: Velura@2026",
            "url_access": "Storefront: http://localhost:4200 (hoặc https://royalai.dev)",
            "cases": [
                (
                    "TC-CART-01",
                    "Tìm kiếm & Lọc danh mục sản phẩm",
                    "Khách truy cập trang chủ Velura Storefront",
                    "1. Nhập từ khóa 'áo sơ mi lụa' vào thanh tìm kiếm header.\n2. Lọc danh mục: Áo, Khoảng giá 300.000đ - 1.000.000đ, Màu Trắng.\n3. Kiểm tra danh sách kết quả hiển thị.",
                    "Từ khóa: 'áo sơ mi lụa' | Lọc: Áo, 300k-1tr",
                    "Hệ thống trả về danh sách sản phẩm đúng tiêu chí lọc trong < 1s; hiển thị ảnh đại diện, tên, giá bán và badge giảm giá nếu có.",
                    "Untested", "Major"
                ),
                (
                    "TC-CART-02",
                    "Chi tiết sản phẩm (PDP) - Phối hợp biến thể Màu & Size",
                    "User mở trang chi tiết sản phẩm thời trang nhiều biến thể",
                    "1. Mở trang PDP `/products/ao-so-mi-lua-velura-01`.\n2. Lần lượt click chọn các ô Màu sắc: Trắng -> Đen -> Be.\n3. Chọn Kích thước: S -> M -> L.\n4. Quan sát hình ảnh gallery và giá tiền tương ứng.",
                    "Sản phẩm: Áo Sơ Mi Lụa Cao Cấp (SP-001)",
                    "Ảnh sản phẩm chính lập tức đổi theo màu sắc vừa chọn; Giá tiền và thông tin tồn kho cập nhật mượt mà, không giật lag.",
                    "Untested", "Critical"
                ),
                (
                    "TC-CART-03",
                    "Đổi ảnh gallery theo màu sắc đã chọn",
                    "Đang ở trang PDP sản phẩm nhiều màu",
                    "1. Bấm chọn màu 'Be' -> Quan sát bộ ảnh thu nhỏ (thumbnails).\n2. Bấm chọn ảnh thumbnail để phóng to xem chất liệu vải.",
                    "Màu Be | Thumbnails góc chụp",
                    "Toàn bộ gallery ảnh chuyển sang các góc chụp của phiên bản màu Be; Ảnh zoom sắc nét, rõ thớ vải.",
                    "Untested", "Major"
                ),
                (
                    "TC-CART-04",
                    "Kiểm tra khóa thao tác khi biến thể HẾT HÀNG (Out of Stock)",
                    "Sản phẩm có ít nhất 1 biến thể có số lượng tồn kho = 0",
                    "1. Trên trang PDP, chọn biến thể Màu 'Đen' - Size 'XL' (tồn kho = 0).\n2. Kiểm tra giao diện hiển thị của nút Màu/Size và nút hành động.\n3. Thử nhấn vào nút 'Thêm vào giỏ' và 'Mua ngay'.",
                    "Biến thể: Đen - XL (Stock = 0)",
                    "Ô biến thể bị gạch chéo mờ (disabled); Cả hai nút 'Thêm vào giỏ' và 'Mua ngay' đều bị vô hiệu hóa (disabled), hiển thị badge 'Hết hàng'. Chặn hoàn toàn không cho mua.",
                    "Untested", "Blocker"
                ),
                (
                    "TC-CART-05",
                    "Nút 'Thêm nhanh vào giỏ hàng' (Quick Add)",
                    "Sản phẩm còn hàng trong kho",
                    "1. Chọn biến thể còn hàng (Màu Trắng - Size M).\n2. Nhấn nút 'Thêm vào giỏ hàng'.\n3. Quan sát góc trên bên phải màn hình và icon giỏ hàng.",
                    "Biến thể: Trắng - M (Stock = 25)",
                    "Hiển thị Toast thông báo 'Đã thêm vào giỏ hàng thành công!'; Icon giỏ hàng tăng số lượng tức thì; Không bị chuyển hướng trang ngoài ý muốn.",
                    "Untested", "Major"
                ),
                (
                    "TC-CART-06",
                    "Xem Giỏ hàng `/cart` - Kiểm tra thông tin hiển thị",
                    "Đã thêm ít nhất 2 sản phẩm vào giỏ",
                    "1. Nhấn vào icon giỏ hàng trên Header -> Chọn 'Xem giỏ hàng' (`/cart`).\n2. Kiểm tra ảnh thumbnail, tên sản phẩm, biến thể màu/size, đơn giá, số lượng.",
                    "Trang `/cart`",
                    "Danh sách sản phẩm trong giỏ hiển thị rõ ràng, đúng biến thể đã chọn; Hiển thị đúng đơn giá và dòng tạm tính.",
                    "Untested", "Critical"
                ),
                (
                    "TC-CART-07",
                    "Cập nhật số lượng sản phẩm trong giỏ hàng",
                    "Đang ở trang `/cart`",
                    "1. Nhấn nút '+' để tăng số lượng từ 1 lên 3 chiếc.\n2. Nhấn nút '-' để giảm xuống 2 chiếc.\n3. Quan sát tạm tính và tổng tiền.",
                    "Số lượng: 1 -> 3 -> 2",
                    "Tạm tính và tổng tiền tự động tính lại chuẩn xác tức thì theo công thức; Không cần tải lại trang.",
                    "Untested", "Critical"
                ),
                (
                    "TC-CART-08",
                    "Đổi biến thể Màu/Size trực tiếp ngay trong giỏ hàng",
                    "Sản phẩm trong giỏ hàng có nhiều biến thể còn hàng",
                    "1. Tại dòng sản phẩm trong giỏ, bấm vào dropdown chọn Size.\n2. Đổi từ Size 'M' sang Size 'L'.\n3. Kiểm tra biến thể hiển thị sau khi đổi.",
                    "Đổi Size M -> L trong cart",
                    "Biến thể cập nhật ngay lập tức sang Size L; Giá và số lượng được giữ nguyên; Không phải quay lại trang PDP.",
                    "Untested", "Major"
                ),
                (
                    "TC-CART-09",
                    "Xóa sản phẩm khỏi giỏ hàng",
                    "Giỏ hàng có sản phẩm",
                    "1. Bấm vào icon thùng rác (Xóa) tại 1 sản phẩm.\n2. Xác nhận xóa trên modal / toast thông báo.\n3. Thử xóa toàn bộ sản phẩm để kiểm tra giao diện giỏ hàng trống.",
                    "Thao tác Xóa sản phẩm",
                    "Sản phẩm bị gỡ khỏi giỏ hàng; Tổng tiền giảm tương ứng; Khi giỏ trống hiển thị màn hình Empty state đẹp mắt kèm nút 'Tiếp tục mua sắm'.",
                    "Untested", "Major"
                ),
                (
                    "TC-CART-10",
                    "Lưu trữ giỏ hàng (Cart Persistence)",
                    "Giỏ hàng đang có sản phẩm",
                    "1. Đóng trình duyệt hoặc nhấn F5 làm mới trang.\n2. Mở lại trang `/cart` kiểm tra danh sách sản phẩm.",
                    "F5 refresh / mở lại tab",
                    "Toàn bộ sản phẩm và số lượng trong giỏ hàng vẫn được lưu giữ nguyên vẹn qua LocalStorage/Session.",
                    "Untested", "Critical"
                )
            ]
        },
        {
            "sheet_name": "2. Mua Hàng & Thanh Toán",
            "tester_code": "Tester 02",
            "tester_name": "Trần Quốc Bảo",
            "persona": "Khách Mua Ngay & Thanh Toán (Checkout Specialist)",
            "flow_title": "QUY TRÌNH 2: NÚT MUA NGAY, CHECKOUT GUEST (COD) & THÀNH VIÊN (STRIPE CARD), XÁC NHẬN ĐƠN",
            "account_info": "Guest Checkout & Member: shopper.checkout@velura.test / Pass: Velura@2026",
            "url_access": "Storefront: http://localhost:4200/checkout (hoặc /checkout/guest)",
            "cases": [
                (
                    "TC-CHECKOUT-01",
                    "Nút 'Mua ngay' chuyển thẳng Checkout (Buy Now)",
                    "Sản phẩm còn hàng trong kho",
                    "1. Trên trang PDP, chọn biến thể Màu Be - Size S.\n2. Nhấn nút 'Mua ngay'.\n3. Kiểm tra trang đích được chuyển đến và danh sách sản phẩm trong đơn.",
                    "Biến thể: Be - S | Số lượng: 1",
                    "Hệ thống chuyển thẳng lập tức sang trang `/checkout` (hoặc `/checkout/guest`); Đúng sản phẩm và biến thể vừa chọn được nạp sẵn vào tóm tắt đơn.",
                    "Untested", "Critical"
                ),
                (
                    "TC-CHECKOUT-02",
                    "Điền thông tin giao hàng Khách vãng lai (`/checkout/guest`)",
                    "Khách chưa đăng nhập tài khoản",
                    "1. Truy cập màn hình `/checkout/guest`.\n2. Điền Họ tên: 'Lê Minh Anh', SĐT: '0987654321', Email: 'minhanh.guest@gmail.test'.\n3. Chọn Tỉnh/Thành phố: 'TP. Hồ Chí Minh', Quận/Huyện: 'Quận 1', Phường/Xã: 'Bến Nghé', Địa chỉ số nhà.",
                    "Thông tin giao hàng hợp lệ",
                    "Form tự động load danh sách quận huyện theo tỉnh thành; Validate đúng định dạng SĐT (10 số) và email.",
                    "Untested", "Critical"
                ),
                (
                    "TC-CHECKOUT-03",
                    "Đặt hàng COD Khách vãng lai & Nhận mã đơn hàng",
                    "Đã điền thông tin giao hàng ở bước trước",
                    "1. Chọn phương thức 'Thanh toán khi nhận hàng (COD)'.\n2. Nhấn 'Đặt hàng ngay'.\n3. Kiểm tra màn hình đặt hàng thành công `/checkout/confirm`.",
                    "Phương thức: COD",
                    "Đặt hàng thành công; Chuyển hướng sang `/checkout/confirm`; Hiển thị Mã đơn hàng định dạng `VEL-2026-XXXX`; Hiển thị banner mời kích hoạt tài khoản thành viên tích điểm.",
                    "Untested", "Blocker"
                ),
                (
                    "TC-CHECKOUT-04",
                    "Tùy chọn Gói quà tặng cao cấp & Thiệp chúc mừng",
                    "Đang ở màn hình thanh toán",
                    "1. Tích chọn 'Gói quà cao cấp & Thiệp viết tay (+50.000đ)'.\n2. Nhập lời chúc: 'Chúc mừng sinh nhật bạn thân!'.\n3. Kiểm tra bảng tóm tắt chi phí.",
                    "Option Gói quà: +50.000đ",
                    "Tổng tiền thanh toán cộng thêm đúng 50.000đ phí gói quà; Lời nhắn thiệp được ghi nhận vào dữ liệu đơn hàng.",
                    "Untested", "Major"
                ),
                (
                    "TC-CHECKOUT-05",
                    "Yêu cầu Xuất hóa đơn điện tử VAT công ty",
                    "Đang ở màn hình thanh toán",
                    "1. Tích chọn 'Yêu cầu xuất hóa đơn VAT'.\n2. Nhập Tên công ty: 'Công ty Cổ phần Công nghệ Velura', MST: '0316889988', Địa chỉ, Email nhận HĐĐT.\n3. Kiểm tra validate mã số thuế.",
                    "MST: 0316889988",
                    "Thông tin hóa đơn VAT được ghi nhận đầy đủ, không cho phép nhập MST sai định dạng; Thông tin đính kèm vào chi tiết đơn.",
                    "Untested", "Major"
                ),
                (
                    "TC-CHECKOUT-06",
                    "Checkout Thành viên (`/checkout/user`) - Nạp sổ địa chỉ",
                    "Khách đã đăng nhập tài khoản thành viên",
                    "1. Đăng nhập tài khoản `shopper.checkout@velura.test`.\n2. Mở `/checkout/user` -> Kiểm tra thông tin họ tên, SĐT và địa chỉ mặc định được điền tự động.\n3. Thử chuyển đổi giữa 2 địa chỉ đã lưu.",
                    "Tài khoản thành viên đã lưu sổ địa chỉ",
                    "Địa chỉ giao hàng nạp tự động tức thì; Phí vận chuyển được tính chuẩn xác theo vùng địa lý.",
                    "Untested", "Critical"
                ),
                (
                    "TC-CHECKOUT-07",
                    "Thanh toán Thẻ tín dụng Quốc tế Stripe Thành viên",
                    "Tại màn hình `/checkout/user`",
                    "1. Chọn phương thức thanh toán 'Thẻ tín dụng / Ghi nợ quốc tế (Stripe)'.\n2. Nhập thẻ test Stripe: Số thẻ `4242 4242 4242 4242`, Hạn `12/28`, CVC `123`, Zip `70000`.\n3. Nhấn 'Thanh toán ngay'.",
                    "Thẻ Stripe Test: 4242424242424242",
                    "Cổng Stripe xác thực thành công trong 2 giây; Hệ thống ghi nhận trạng thái thanh toán `PAID`; Đơn hàng hoàn tất.",
                    "Untested", "Blocker"
                ),
                (
                    "TC-CHECKOUT-08",
                    "Xử lý ngoại lệ Thẻ Stripe bị từ chối / Hết hạn",
                    "Tại màn hình thanh toán thẻ Stripe",
                    "1. Nhập thẻ test từ chối của Stripe: `4000 0000 0000 0002` (Card declined).\n2. Nhấn 'Thanh toán ngay'.\n3. Quan sát phản hồi của hệ thống.",
                    "Thẻ lỗi: 4000000000000002",
                    "Hệ thống hiển thị thông báo lỗi rõ ràng: 'Thẻ của bạn đã bị từ chối. Vui lòng thử thẻ khác hoặc chọn COD'; Giỏ hàng không bị xóa mất.",
                    "Untested", "Critical"
                ),
                (
                    "TC-CHECKOUT-09",
                    "Kiểm tra trang Xác nhận Đơn hàng `/checkout/confirm`",
                    "Đơn hàng thanh toán thành công",
                    "1. Kiểm tra màn hình `/checkout/confirm`.\n2. Đối chiếu mã đơn, danh sách sản phẩm, số tiền đã trừ, phương thức thanh toán, địa chỉ nhận hàng.\n3. Bấm nút 'Theo dõi đơn hàng'.",
                    "Màn hình xác nhận đơn",
                    "Giao diện chúc mừng đặt hàng thành công chuyên nghiệp, đầy đủ thông tin; Bấm 'Theo dõi đơn hàng' điều hướng đúng trang tra cứu tiến độ.",
                    "Untested", "Major"
                ),
                (
                    "TC-CHECKOUT-10",
                    "Gửi Email Xác nhận Đơn hàng Tự động",
                    "Đơn hàng đặt thành công ở bước trước",
                    "1. Mở hòm thư email của khách hàng đã nhập khi đặt hàng.\n2. Kiểm tra email gửi từ Velura Storefront.\n3. Kiểm tra chi tiết đơn hàng và link tra cứu trong email.",
                    "Email khách hàng",
                    "Email gửi về trong vòng < 30s; Layout email chuẩn nhận diện thương hiệu, thông tin sản phẩm và số tiền chuẩn xác 100%.",
                    "Untested", "Major"
                )
            ]
        },
        {
            "sheet_name": "3. Hủy Đơn & Đổi Trả",
            "tester_code": "Tester 03",
            "tester_name": "Lê Hoàng Châu",
            "persona": "Khách Hậu Mãi & Chuyên Viên RMA CSKH",
            "flow_title": "QUY TRÌNH 3: HỦY ĐƠN HÀNG PENDING, TẠO RMA KÈM ẢNH LỖI, CỐ ĐỊNH TIỀN HOÀN, CSKH DUYỆT & KHO QA",
            "account_info": "User: customer.rma@velura.test / Pass: Velura@2026 | Admin: cskh.rma@velura.vn / Pass: Admin@2026",
            "url_access": "Storefront: http://localhost:4200/account/returns | Admin: http://localhost:4201/returns",
            "cases": [
                (
                    "TC-RMA-01",
                    "Khách tự hủy đơn hàng Chờ xử lý (PENDING)",
                    "Tài khoản có đơn hàng vừa tạo ở trạng thái PENDING",
                    "1. Đăng nhập User -> Vào trang `/account/orders`.\n2. Chọn đơn hàng trạng thái 'Chờ xử lý' -> Bấm 'Xem chi tiết'.\n3. Nhấn nút 'Hủy đơn hàng' -> Chọn lý do 'Muốn đổi mẫu khác'.\n4. Xác nhận hủy đơn.",
                    "Đơn hàng PENDING vừa đặt",
                    "Đơn hàng chuyển trạng thái ngay sang `CANCELLED`; Hệ thống tự động hoàn lại số lượng tồn kho cho các sản phẩm trong đơn.",
                    "Untested", "Critical"
                ),
                (
                    "TC-RMA-02",
                    "Kiểm tra tự động hoàn tồn kho khi hủy đơn",
                    "Sản phẩm có tồn kho ban đầu là 10 chiếc, khách đặt 2 chiếc (còn 8)",
                    "1. Khách thực hiện hủy đơn hàng ở bước TC-RMA-01.\n2. Vào trang sản phẩm kiểm tra lại số lượng tồn kho khả dụng.",
                    "Sản phẩm trong đơn hủy",
                    "Tồn kho của sản phẩm lập tức hồi phục về đúng 10 chiếc; Không bị thất thoát hay âm tồn kho.",
                    "Untested", "Critical"
                ),
                (
                    "TC-RMA-03",
                    "Kiểm tra chặn hủy đơn khi đơn ĐÃ DUYỆT / ĐANG GIAO",
                    "Đơn hàng đã chuyển sang trạng thái CONFIRMED hoặc SHIPPING",
                    "1. Vào chi tiết đơn hàng đã xuất kho hoặc đang giao.\n2. Kiểm tra sự xuất hiện của nút 'Hủy đơn hàng'.",
                    "Đơn hàng trạng thái SHIPPING",
                    "Nút 'Hủy đơn' bị ẩn hoặc vô hiệu hóa; Hiển thị thông báo: 'Đơn hàng đang trên đường giao, vui lòng liên hệ hotline 1900-xxxx nếu cần hỗ trợ'.",
                    "Untested", "Major"
                ),
                (
                    "TC-RMA-04",
                    "Khởi tạo Yêu cầu Đổi trả (RMA) trên đơn đã giao (DELIVERED)",
                    "Đơn hàng đã ở trạng thái DELIVERED trong vòng 30 ngày",
                    "1. Vào `/account/orders` -> Chọn đơn đã giao thành công.\n2. Nhấn nút 'Yêu cầu đổi / trả' -> Mở trang form `/account/returns`.\n3. Chọn sản phẩm trong đơn cần đổi trả.",
                    "Đơn hàng DELIVERED: Áo dạ tweed cao cấp (850.000đ)",
                    "Form đổi trả tải lên thông tin đơn hàng chuẩn xác; Hiển thị quy định chính sách 30 ngày đổi trả miễn phí tận nơi.",
                    "Untested", "Critical"
                ),
                (
                    "TC-RMA-05",
                    "Tải lên hình ảnh bằng chứng sản phẩm lỗi (Upload ảnh RMA)",
                    "User có ảnh chụp chi tiết lỗi bung chỉ / rách vải của áo",
                    "1. Chọn lý do 'Sản phẩm lỗi kỹ thuật / bung chỉ'.\n2. Nhấn chọn tải lên 2 file ảnh chụp lỗi sản phẩm.\n3. Kiểm tra xem trước ảnh (Preview ảnh thumbnail) và thử bấm icon xóa 1 ảnh.\n4. Nhập ghi chú chi tiết mô tả lỗi.",
                    "2 file ảnh JPG lỗi (< 5MB/ảnh)",
                    "Ảnh tải lên hiển thị thumbnail xem trước sắc nét; Xóa ảnh hoạt động tốt; Chặn file > 5MB hoặc file sai định dạng.",
                    "Untested", "Critical"
                ),
                (
                    "TC-RMA-06",
                    "Chọn hình thức HOÀN TIỀN (Refund) & Cố định giá trị",
                    "Đang thao tác tại form tạo yêu cầu đổi trả",
                    "1. Chọn hình thức giải quyết: 'Hoàn tiền vào tài khoản'.\n2. Nhập thông tin STK Ngân hàng, Tên chủ thẻ, Tên ngân hàng.\n3. Kiểm tra ô 'Số tiền hoàn dự kiến'.",
                    "STK: 1903xxx Techcombank | Số tiền: 850.000đ",
                    "Hệ thống khóa cố định số tiền hoàn theo đúng giá trị thanh toán thực tế của sản phẩm trên hóa đơn; Khách hàng không thể sửa đổi số tiền.",
                    "Untested", "Critical"
                ),
                (
                    "TC-RMA-07",
                    "Chọn hình thức ĐỔI HÀNG (Exchange) - Đổi Size/Màu",
                    "Đang thao tác tại form tạo yêu cầu đổi trả",
                    "1. Chọn hình thức: 'Đổi sản phẩm / Đổi kích cỡ'.\n2. Chọn Biến thể mới muốn đổi: Màu 'Đen' - Size 'L'.\n3. Kiểm tra tồn kho của biến thể mới được chọn.\n4. Bấm 'Gửi yêu cầu đổi trả'.",
                    "Sản phẩm đổi: Áo dạ tweed Đen - Size L (còn hàng)",
                    "Yêu cầu đổi trả được tạo thành công với mã `RMA-2026-XXXX`; Trạng thái hiển thị `REQUESTED`; User nhận được email xác nhận.",
                    "Untested", "Critical"
                ),
                (
                    "TC-RMA-08",
                    "Admin CSKH tiếp nhận phiếu RMA & Chuyển 'CONTACTING'",
                    "Admin CSKH đăng nhập trang `/admin/returns`",
                    "1. Mở danh sách đổi trả -> Thấy phiếu RMA vừa tạo.\n2. Bấm nút Thao tác (icon bút chì) -> Chọn 'Liên hệ khách hàng'.\n3. Nhập ghi chú: 'Đã gọi khách xác nhận địa chỉ lấy hàng đổi'.",
                    "Phiếu RMA-2026-XXXX vừa tạo",
                    "Trạng thái phiếu đổi sang `CONTACTING`; Cột Thao tác đổi dropdown menu tương ứng; Không bị xô lệch layout nút bấm.",
                    "Untested", "Major"
                ),
                (
                    "TC-RMA-09",
                    "Admin CSKH phê duyệt Đổi hàng / Hoàn tiền (APPROVED)",
                    "Phiếu RMA đang ở trạng thái CONTACTING",
                    "1. Tại cột Thao tác, click mở Dropdown menu hành động.\n2. Chọn 'Phê duyệt đổi hàng' (hoặc 'Phê duyệt hoàn tiền').\n3. Nhập hướng dẫn gửi hàng cho khách: 'Shipper Velura sẽ đến thu hồi kiện hàng tận nơi trong 24h'.\n4. Xác nhận duyệt.",
                    "Ghi chú phê duyệt CSKH",
                    "Phiếu chuyển trạng thái `APPROVED`; Khách hàng kiểm tra giao diện Storefront `/account/returns` thấy ngay trạng thái đổi sang 'Đã được duyệt'.",
                    "Untested", "Critical"
                ),
                (
                    "TC-RMA-10",
                    "Kho nhận hàng & Kiểm định QA (QA Inspection & Hoàn tiền)",
                    "Kiện hàng khách gửi về kho (Trạng thái RETURNING)",
                    "1. Thủ kho đăng nhập Admin -> Mở chi tiết phiếu RMA.\n2. Bấm 'Tiếp nhận kiện hàng' -> Chuyển sang `RECEIVED`.\n3. Tiến hành kiểm định chất lượng: Chọn 'QA Pass'.\n4. Bấm 'Hoàn tiền cho khách' (Stripe hoàn tự động hoặc xác nhận chuyển khoản COD).",
                    "Kiểm tra tem mác, độ nguyên vẹn vải",
                    "Trạng thái chuyển sang `REFUNDED` / `COMPLETED`; Đơn hàng kết thúc chu trình; Ghi log kiểm định chất lượng vào lịch sử RMA.",
                    "Untested", "Blocker"
                )
            ]
        },
        {
            "sheet_name": "4. Khuyến Mãi & Voucher",
            "tester_code": "Tester 04",
            "tester_name": "Phạm Văn Dũng",
            "persona": "Trưởng Phòng Marketing & Khách Hàng Săn Ưu Đãi",
            "flow_title": "QUY TRÌNH 4: QUẢN TRỊ VOUCHER ADMIN, ĐỒNG BỘ STOREFRONT, VÍ SINH NHẬT & RÀNG BUỘC CHECKOUT",
            "account_info": "Admin MKT: admin.marketing@velura.vn / Pass: Admin@2026 | User: member.promo@velura.test / Pass: Velura@2026",
            "url_access": "Admin: http://localhost:4201/promotions | User: http://localhost:4200/offers & /checkout",
            "cases": [
                (
                    "TC-PROMO-01",
                    "Admin Tạo Chiến Dịch Khuyến Mãi Mới (Campaign Creation)",
                    "Admin Marketing đăng nhập vào trang `/admin/promotions`",
                    "1. Mở tab 'Chiến dịch' (Campaigns) -> Bấm 'Thêm chiến dịch mới'.\n2. Nhập Tên chiến dịch: 'Lễ Hội Thời Trang Mùa Thu Velura 2026'.\n3. Chọn Thời gian: Từ ngày hiện tại đến hết tháng.\n4. Nhập mô tả chiến dịch và bấm 'Lưu chiến dịch'.",
                    "Chiến dịch: Lễ Hội Mùa Thu 2026",
                    "Chiến dịch mới được tạo thành công, xuất hiện ở đầu danh sách chiến dịch đang hoạt động; Ghi nhận nhật ký tạo chiến dịch vào audit log.",
                    "Untested", "Critical"
                ),
                (
                    "TC-PROMO-02",
                    "Admin Tạo Mã Giảm Giá Voucher Theo % (Percentage Voucher)",
                    "Đang ở trang quản lý khuyến mãi `/admin/promotions`",
                    "1. Mở tab 'Mã giảm giá' (Vouchers) -> Bấm 'Tạo mã voucher'.\n2. Nhập Mã: `VELURA20` | Loại: Giảm 20% giá trị đơn hàng.\n3. Thiết lập Ràng buộc: Đơn tối thiểu `500.000đ`, Giảm tối đa `100.000đ`.\n4. Giới hạn: 500 lượt dùng, mỗi user dùng tối đa 1 lần.\n5. Bấm 'Lưu voucher'.",
                    "Mã: VELURA20 | Giảm: 20% | Min: 500k | Max giảm: 100k",
                    "Voucher tạo thành công, hiển thị trạng thái 'Đang hoạt động'; Ràng buộc giá trị đơn tối thiểu và mức giảm tối đa được lưu đúng cơ sở dữ liệu.",
                    "Untested", "Critical"
                ),
                (
                    "TC-PROMO-03",
                    "Admin Cấu hình Voucher Độc Quyền Sinh Nhật Khách Hàng (Birthday Voucher)",
                    "Tạo mã ưu đãi dành riêng cho chương trình quà sinh nhật",
                    "1. Bấm 'Tạo mã voucher' -> Nhập Mã: `HPBD2026`.\n2. Loại giảm giá: Giảm tiền mặt cố định `150.000đ`.\n3. Đơn hàng tối thiểu: `600.000đ`.\n4. Đánh dấu tích chọn: 'Áp dụng cho chương trình Quà tặng Sinh nhật thành viên'.\n5. Lưu voucher.",
                    "Mã: HPBD2026 | Giảm: 150.000đ | Min order: 600.000đ",
                    "Hệ thống lưu cấu hình voucher sinh nhật; Tự động kích hoạt cơ chế đồng bộ cho các khách hàng có sinh nhật trong tháng.",
                    "Untested", "Critical"
                ),
                (
                    "TC-PROMO-04",
                    "Admin Bật / Tắt Trạng Thái & Kiểm tra Nhật Ký Khuyến Mãi (Audit Log)",
                    "Danh sách voucher đã tạo",
                    "1. Tìm mã `VELURA20` -> Bấm nút gạt Tắt trạng thái kích hoạt.\n2. Kiểm tra voucher chuyển sang trạng thái 'Tạm ngưng'.\n3. Chuyển sang tab 'Nhật ký' (Audit logs) của phân hệ khuyến mãi.\n4. Kiểm tra lịch sử ghi lại hành động của admin.",
                    "Voucher VELURA20",
                    "Trạng thái voucher cập nhật tức thì; Tab Nhật ký ghi lại chính xác: 'Admin admin.marketing@velura.vn đã vô hiệu hóa voucher VELURA20 lúc HH:mm:ss'.",
                    "Untested", "Major"
                ),
                (
                    "TC-PROMO-05",
                    "Đồng bộ Chiến dịch & Voucher sang Trang Ưu Đãi Storefront (`/offers`)",
                    "Khách hàng truy cập Storefront",
                    "1. Bật lại voucher `VELURA20` bên Admin.\n2. Mở trình duyệt khách hàng truy cập trang `/offers`.\n3. Quan sát các banner chiến dịch và thẻ mã giảm giá hiển thị.",
                    "Trang Storefront `/offers`",
                    "Các voucher công khai đang hoạt động bên Admin lập tức đồng bộ hiển thị trên trang `/offers`; Khách có thể bấm nút 'Sao chép mã' để lưu vào bộ nhớ tạm.",
                    "Untested", "Critical"
                ),
                (
                    "TC-PROMO-06",
                    "Đồng bộ Tự Động Voucher Sinh Nhật vào Ví Thành Viên (`/account/vouchers`)",
                    "Khách hàng có thông tin ngày sinh nhật trong tháng hiện tại",
                    "1. Đăng nhập tài khoản `member.promo@velura.test` (sinh nhật trong tháng).\n2. Truy cập trang cá nhân -> Mở 'Ví Voucher' (`/account/vouchers`).\n3. Kiểm tra danh sách voucher cá nhân.",
                    "Tài khoản có sinh nhật trong tháng",
                    "Mã ưu đãi sinh nhật `HPBD2026` tự động xuất hiện trong ví với badge 'Quà tặng Sinh nhật'; Hiển thị số tiền giảm 150.000đ và thời hạn sử dụng đến hết tháng.",
                    "Untested", "Critical"
                ),
                (
                    "TC-PROMO-07",
                    "Áp dụng Voucher Thành Công tại màn hình Thanh toán Checkout (`/checkout`)",
                    "Khách hàng có giỏ hàng thỏa mãn điều kiện áp dụng",
                    "1. Mua sản phẩm có tổng giá trị `800.000đ` (> 600.000đ).\n2. Tiến hành vào trang `/checkout`.\n3. Tại ô 'Mã giảm giá', nhập mã `HPBD2026` -> Nhấn nút 'Áp dụng'.\n4. Quan sát bảng tóm tắt chi phí đơn hàng.",
                    "Đơn hàng 800.000đ | Mã: HPBD2026",
                    "Hệ thống xác thực mã hợp lệ; Dòng 'Giảm giá voucher' hiển thị trừ `-150.000đ`; Tổng tiền thanh toán giảm chính xác còn `650.000đ`.",
                    "Untested", "Blocker"
                ),
                (
                    "TC-PROMO-08",
                    "Kiểm tra Chặn Áp Dụng khi Đơn Chưa Đạt Giá Trị Tối Thiểu (Min Order Value)",
                    "Giỏ hàng có giá trị nhỏ hơn điều kiện voucher",
                    "1. Giỏ hàng hiện chỉ có 1 sản phẩm trị giá `400.000đ` (< 600.000đ).\n2. Vào trang `/checkout`, nhập mã `HPBD2026` -> Bấm 'Áp dụng'.\n3. Quan sát thông báo của hệ thống.",
                    "Đơn hàng 400.000đ | Mã: HPBD2026 (yêu cầu min 600k)",
                    "Hệ thống từ chối áp dụng và hiển thị thông báo lỗi rõ ràng: 'Đơn hàng tối thiểu phải từ 600.000đ để áp dụng voucher này'; Không giảm giá.",
                    "Untested", "Critical"
                ),
                (
                    "TC-PROMO-09",
                    "Kiểm tra Chặn Áp Dụng Mã Hết Hạn hoặc Đã Bị Vô Hiệu Hóa",
                    "Mã voucher đã hết hạn hoặc bị Admin tắt",
                    "1. Tại trang Checkout, nhập mã voucher đã hết hạn hoặc mã không tồn tại `EXPIRED2025`.\n2. Thử nhập mã `VELURA20` khi đã bị admin tắt kích hoạt.\n3. Bấm 'Áp dụng'.",
                    "Mã voucher không hợp lệ / hết hạn",
                    "Hệ thống thông báo: 'Mã giảm giá không tồn tại hoặc đã hết hiệu lực'; Không cho phép trừ tiền gian lận.",
                    "Untested", "Critical"
                ),
                (
                    "TC-PROMO-10",
                    "Kiểm tra Báo cáo Hiệu quả Khuyến Mãi bên Admin (`/admin/promotions` -> Stats)",
                    "Đơn hàng có áp dụng mã `HPBD2026` đã được đặt thành công",
                    "1. Admin mở trang `/admin/promotions` -> Bấm tab 'Thống kê' (Stats).\n2. Kiểm tra số lượt đã dùng của mã `HPBD2026`.\n3. Kiểm tra tổng số tiền chiết khấu đã cấp và doanh thu đơn hàng mang lại.",
                    "Tab Thống kê Khuyến mãi",
                    "Số lượt dùng tăng lên đúng 1 lượt; Doanh thu và tiền giảm giá được tổng hợp chính xác vào báo cáo hiệu quả marketing.",
                    "Untested", "Major"
                )
            ]
        },
        {
            "sheet_name": "5. Đánh Giá Sản Phẩm",
            "tester_code": "Tester 05",
            "tester_name": "Đặng Thị Mai",
            "persona": "Khách Đánh Giá & Kiểm Duyệt Review CSKH",
            "flow_title": "QUY TRÌNH 5: ĐÁNH GIÁ SẢN PHẨM ĐƠN ĐÃ GIAO, UPLOAD ẢNH THỰC TẾ, REVIEW GUEST OTP & KIỂM DUYỆT ADMIN",
            "account_info": "User: chau.le@gmail.test / Pass: Velura@2026 | Admin Review: admin.reviews@velura.vn / Pass: Admin@2026",
            "url_access": "Storefront: http://localhost:4200/account/reviews & /guest/reviews | Admin: http://localhost:4201/reviews",
            "cases": [
                (
                    "TC-REV-01",
                    "Khách hàng truy cập trang Đánh giá trên đơn DELIVERED",
                    "Tài khoản thành viên có đơn hàng đã giao thành công",
                    "1. Đăng nhập tài khoản `chau.le@gmail.test`.\n2. Mở 'Đánh giá của tôi' (`/account/reviews`).\n3. Kiểm tra danh sách các sản phẩm đã mua đủ điều kiện để lại đánh giá.",
                    "Đơn hàng DELIVERED: Đầm xòe lụa satin",
                    "Hiển thị danh sách sản phẩm đã giao kèm nút 'Viết đánh giá'; Không hiển thị các sản phẩm chưa giao hoặc đã hủy.",
                    "Untested", "Major"
                ),
                (
                    "TC-REV-02",
                    "Đánh giá số sao (1-5 sao) & Nhận xét chất lượng",
                    "Mở modal/form đánh giá sản phẩm",
                    "1. Chọn xếp hạng 5 sao.\n2. Nhập nhận xét: 'Chất vải lụa mềm mịn, đường may rất tỉ mỉ, mặc đi tiệc ai cũng khen. Form áo chuẩn size M.'\n3. Đánh giá độ vừa vặn: 'Đúng kích thước'.",
                    "Nội dung nhận xét tích cực 5 sao",
                    "Các ngôi sao đổi màu vàng nổi bật; Số ký tự nhập vào hiển thị bộ đếm; Form mượt mà không bị giật lag.",
                    "Untested", "Major"
                ),
                (
                    "TC-REV-03",
                    "Tải lên hình ảnh thực tế sản phẩm (Upload ảnh Review)",
                    "User có ảnh chụp thật khi mặc váy ở nhà",
                    "1. Bấm vào icon máy ảnh 'Thêm hình ảnh thực tế'.\n2. Chọn tải lên 2 file ảnh chụp sản phẩm thực tế.\n3. Kiểm tra ảnh xem trước (Preview thumbnail) sắc nét.\n4. Thử bấm nút xóa 1 ảnh để kiểm tra tính năng gỡ ảnh.",
                    "2 file ảnh JPG thực tế (< 5MB)",
                    "Ảnh thumbnail hiển thị rõ ràng, xem trước đẹp mắt; Nút xóa ảnh hoạt động chuẩn xác; Giới hạn tối đa 5 ảnh / lần đánh giá.",
                    "Untested", "Critical"
                ),
                (
                    "TC-REV-04",
                    "Gửi đánh giá & Nhận điểm tích lũy thành viên",
                    "Form đánh giá đã điền đủ sao, nhận xét và ảnh thực tế",
                    "1. Nhấn nút 'Gửi đánh giá'.\n2. Quan sát thông báo từ hệ thống và điểm thưởng tích lũy.",
                    "Nút Gửi đánh giá",
                    "Hiển thị thông báo thành công: 'Cảm ơn bạn! Đánh giá đã được ghi nhận và đang chờ duyệt'; Tài khoản được cộng 50 điểm thưởng.",
                    "Untested", "Major"
                ),
                (
                    "TC-REV-05",
                    "Luồng Đánh giá Khách vãng lai qua SĐT (`/guest/reviews`)",
                    "Khách mua hàng bằng hình thức Guest không tạo tài khoản",
                    "1. Truy cập trang `/guest/reviews`.\n2. Nhập Số điện thoại đã đặt hàng: `0912345678`.\n3. Nhấn 'Nhận mã xác thực OTP'.",
                    "SĐT khách vãng lai: 0912345678",
                    "Hệ thống gửi mã OTP xác thực về Email/SĐT của đơn hàng tương ứng; Mở màn hình nhập mã OTP 6 chữ số.",
                    "Untested", "Critical"
                ),
                (
                    "TC-REV-06",
                    "Xác thực OTP & Mở danh sách đơn hàng để Review",
                    "Khách nhận được mã OTP (Mã demo kiểm thử: 123456)",
                    "1. Nhập mã OTP `123456` -> Bấm 'Xác nhận'.\n2. Kiểm tra danh sách đơn hàng đã mua hiển thị trên màn hình.",
                    "OTP: 123456",
                    "Xác thực OTP thành công; Hệ thống load đúng các sản phẩm khách vãng lai đã mua; Cho phép đánh giá số sao và upload ảnh bình thường.",
                    "Untested", "Critical"
                ),
                (
                    "TC-REV-07",
                    "Admin Quản lý Đánh giá (`/admin/reviews`) - Danh sách chờ duyệt",
                    "Admin kiểm duyệt đăng nhập trang quản trị",
                    "1. Mở trang `/admin/reviews`.\n2. Kiểm tra tab 'Chờ duyệt' -> Thấy 2 đánh giá vừa gửi từ Member và Guest.\n3. Kiểm tra hiển thị ảnh thực tế khách đã tải lên.",
                    "Trang Admin Reviews",
                    "Đánh giá mới hiển thị đầy đủ: Tên khách, Sản phẩm, Số sao, Nội dung nhận xét và các ảnh đính kèm; Giao diện xem ảnh to (lightbox) sắc nét.",
                    "Untested", "Critical"
                ),
                (
                    "TC-REV-08",
                    "Admin Phê duyệt Đánh giá Hợp lệ (Approved)",
                    "Đánh giá có nội dung lịch sự, ảnh chụp thật rõ ràng",
                    "1. Bấm nút 'Phê duyệt' (hoặc icon tick xanh).\n2. Xác nhận duyệt đánh giá.\n3. Chuyển sang tab 'Đã duyệt' kiểm tra.",
                    "Duyệt review hợp lệ",
                    "Trạng thái đổi sang `APPROVED`; Đánh giá lập tức hiển thị công khai trên trang chi tiết sản phẩm PDP tương ứng bên Storefront.",
                    "Untested", "Critical"
                ),
                (
                    "TC-REV-09",
                    "Admin Từ chối / Ẩn Đánh giá Vi phạm (Spam / Từ ngữ nhạy cảm)",
                    "Có đánh giá chứa quảng cáo hoặc ngôn từ không chuẩn mực",
                    "1. Tại đánh giá vi phạm, bấm nút 'Từ chối' (hoặc 'Ẩn đánh giá').\n2. Chọn lý do: 'Chứa nội dung spam hoặc từ ngữ nhạy cảm'.\n3. Xác nhận ẩn.",
                    "Đánh giá vi phạm tiêu chuẩn cộng đồng",
                    "Đánh giá chuyển sang trạng thái `REJECTED`; Không xuất hiện bên ngoài Storefront; Lưu log lý do ẩn vào hệ thống.",
                    "Untested", "Major"
                ),
                (
                    "TC-REV-10",
                    "Đồng bộ Điểm Đánh Giá Trung Bình & Số lượng trên PDP",
                    "Đánh giá 5 sao vừa được admin duyệt ở bước TC-REV-08",
                    "1. Mở trang PDP sản phẩm đó trên Storefront khách hàng.\n2. Cuộn xuống khu vực Đánh giá khách hàng.\n3. Kiểm tra số sao trung bình (VD: 4.9/5) và số lượng review tăng lên.",
                    "Trang PDP Storefront",
                    "Review hiển thị công khai kèm ảnh chụp thực tế có badge 'Đã mua hàng tại Velura'; Điểm đánh giá trung bình cập nhật chuẩn xác.",
                    "Untested", "Major"
                )
            ]
        },
        {
            "sheet_name": "6. Quản Lý Sản Phẩm & Đơn",
            "tester_code": "Tester 06",
            "tester_name": "Vũ Minh Tuấn",
            "persona": "Quản Trị Viên Catalog & Điều Phối Kho Fulfillment",
            "flow_title": "QUY TRÌNH 6: QUẢN LÝ SẢN PHẨM & BIẾN THỂ TỒN KHO, VẬN HÀNH ĐƠN HÀNG, GÁN 3PL & RBAC",
            "account_info": "Admin Kho & Catalog: admin.operator@velura.vn / Pass: Admin@2026 (Role: admin_operator_sanpham & donhang)",
            "url_access": "Admin Products: http://localhost:4201/products | Admin Orders: http://localhost:4201/orders",
            "cases": [
                (
                    "TC-ADMIN-01",
                    "Admin Quản lý Sản phẩm (`/admin/products`) - Danh sách & Bộ lọc",
                    "Admin Catalog đăng nhập trang quản trị",
                    "1. Mở menu 'Sản phẩm' (`/admin/products`).\n2. Tìm kiếm sản phẩm theo tên hoặc mã SKU.\n3. Lọc theo danh mục và trạng thái còn hàng / hết hàng.",
                    "Trang Admin Products",
                    "Bảng danh sách sản phẩm hiển thị mượt mà; Hiển thị ảnh đại diện, giá bán, tổng tồn kho và các biến thể kích thước.",
                    "Untested", "Major"
                ),
                (
                    "TC-ADMIN-02",
                    "Thêm mới Sản phẩm Đa Biến thể (SKU Matrix)",
                    "Đang ở trang `/admin/products`",
                    "1. Nhấn nút 'Thêm sản phẩm mới'.\n2. Nhập Tên sản phẩm: 'Đầm Dạ Hội Lụa Hoàng Gia Velura'.\n3. Chọn Danh mục: 'Đầm', Chất liệu: 'Lụa Tơ Tằm'.\n4. Tạo ma trận biến thể: Màu (Đen, Đỏ Ruby) x Size (S, M, L).",
                    "Sản phẩm mới với 6 biến thể SKU",
                    "Ma trận biến thể được tự động tạo với 6 mã SKU riêng biệt; Cho phép nhập giá bán và số lượng tồn kho cho từng biến thể.",
                    "Untested", "Critical"
                ),
                (
                    "TC-ADMIN-03",
                    "Thiết lập Biến thể Tồn kho = 0 & Kiểm tra Đồng bộ Storefront",
                    "Đang cấu hình tồn kho cho sản phẩm mới",
                    "1. Thiết lập biến thể Màu Đỏ Ruby - Size S có tồn kho = 0.\n2. Thiết lập biến thể Màu Đỏ Ruby - Size M có tồn kho = 15.\n3. Bấm 'Lưu sản phẩm' -> Mở trang PDP sản phẩm đó bên Storefront.",
                    "Biến thể Đỏ Ruby - S (Stock = 0)",
                    "Bên Storefront, khi khách bấm chọn Màu Đỏ Ruby - Size S: Nút 'Thêm vào giỏ' và 'Mua ngay' lập tức bị vô hiệu hóa (disabled), hiển thị badge 'Hết hàng'.",
                    "Untested", "Blocker"
                ),
                (
                    "TC-ADMIN-04",
                    "Cập nhật Giá Khuyến Mãi & Trạng thái Bán",
                    "Sản phẩm đang hoạt động",
                    "1. Chỉnh sửa giá niêm yết từ 1.200.000đ xuống giá sale 950.000đ.\n2. Lưu thay đổi -> Kiểm tra bên Storefront.",
                    "Giá gốc: 1.200.000đ -> Sale: 950.000đ",
                    "Giá sale cập nhật tức thì trên Storefront; Hiển thị badge giảm giá `-21%` kèm giá gạch mờ chuẩn xác.",
                    "Untested", "Major"
                ),
                (
                    "TC-ADMIN-05",
                    "Admin Quản lý Đơn hàng (`/admin/orders`) - Tiếp nhận Đơn mới",
                    "Đơn hàng mới vừa được đặt từ Tester 02",
                    "1. Mở trang `/admin/orders`.\n2. Kiểm tra đơn hàng mới xuất hiện ở đầu danh sách trạng thái `PENDING`.\n3. Bấm xem chi tiết đơn hàng.",
                    "Đơn hàng mới phát sinh",
                    "Thông tin đơn hàng hiển thị đầy đủ: Mã đơn, Khách hàng, Danh sách sản phẩm, Địa chỉ, Số tiền và phương thức COD/Stripe.",
                    "Untested", "Critical"
                ),
                (
                    "TC-ADMIN-06",
                    "Ghi Log Cuộc gọi Xác nhận Đơn hàng COD có Rủi ro",
                    "Đơn hàng COD giá trị cao (> 2.000.000đ) cần gọi điện xác minh",
                    "1. Tại chi tiết đơn hàng, bấm nút 'Ghi nhận cuộc gọi'.\n2. Chọn kết quả: 'Khách hàng xác nhận lấy hàng đúng hẹn'.\n3. Bấm 'Phê duyệt đơn hàng'.",
                    "Log cuộc gọi xác minh COD",
                    "Hệ thống lưu lại log cuộc gọi kèm nhân viên thực hiện và thời gian; Trạng thái đơn chuyển từ `PENDING` sang `CONFIRMED`.",
                    "Untested", "Major"
                ),
                (
                    "TC-ADMIN-07",
                    "Đóng gói, Xuất kho & Gán Mã Vận Đơn 3PL (ViettelPost)",
                    "Đơn hàng đang ở trạng thái CONFIRMED",
                    "1. Bấm nút 'Xuất kho & Giao hàng'.\n2. Chọn Đơn vị vận chuyển: 'Viettel Post'.\n3. Nhập Mã vận đơn: `VTP-883921094`.\n4. Bấm 'Bàn giao vận chuyển'.",
                    "Đơn vị: Viettel Post | Mã: VTP-883921094",
                    "Trạng thái đơn hàng đổi thành `SHIPPING`; Mã vận đơn 3PL được đồng bộ sang màn hình tra cứu của khách hàng.",
                    "Untested", "Blocker"
                ),
                (
                    "TC-ADMIN-08",
                    "Đồng bộ Tiến trình Giao nhận sang Màn hình Tra cứu Khách hàng",
                    "Đơn hàng đã được gán mã 3PL",
                    "1. Mở trang tra cứu của khách (`/account/track` hoặc `/account/orders`).\n2. Kiểm tra thông tin vận chuyển.",
                    "Màn hình tra cứu Storefront",
                    "Khách hàng thấy ngay trạng thái 'Đang vận chuyển', hiển thị đơn vị Viettel Post và mã vận đơn có link bấm tra cứu trên bưu cục.",
                    "Untested", "Critical"
                ),
                (
                    "TC-ADMIN-09",
                    "Hoàn tất Giao hàng (DELIVERED) & Chốt chu trình đơn",
                    "Đơn hàng giao thành công",
                    "1. Admin cập nhật trạng thái đơn sang 'Đã giao hàng' (`DELIVERED`).\n2. Kiểm tra bên Storefront của khách.",
                    "Chuyển trạng thái DELIVERED",
                    "Đơn hàng chuyển sang `DELIVERED`; Giao diện khách hàng xuất hiện nút 'Đánh giá sản phẩm' và nút 'Yêu cầu đổi / trả' trong 30 ngày.",
                    "Untested", "Blocker"
                ),
                (
                    "TC-ADMIN-10",
                    "Kiểm tra Phân quyền RBAC & Nhật ký Thao tác (Audit Trail)",
                    "Đăng nhập các tài khoản Admin khác nhau",
                    "1. Đăng nhập tài khoản Kho: Thử truy cập trang Quản lý tài khoản (`/admin/accounts`) -> Bị chặn 403.\n2. Mở 'Nhật ký hệ thống' (`/admin/logs`).\n3. Kiểm tra lịch sử thao tác thêm sản phẩm, duyệt đơn, gán mã 3PL.",
                    "Trang `/admin/logs`",
                    "Quyền hạn được kiểm soát nghiêm ngặt theo vai trò; Mọi thao tác quan trọng đều được ghi vết thời gian và người thực hiện rõ ràng.",
                    "Untested", "Critical"
                )
            ]
        }
    ]

    # =========================================================================
    # CREATE THE 6 TESTER TABS (Each tester has 1 dedicated sheet!)
    # =========================================================================
    for tab_info in tabs_data:
        ws = wb.create_sheet(title=tab_info["sheet_name"])
        ws.views.sheetView[0].showGridLines = True
        
        # Row 1: Title Banner
        ws.merge_cells("A1:J1")
        title_cell = ws["A1"]
        title_cell.value = f"{tab_info['flow_title']} | {tab_info['tester_code']}: {tab_info['tester_name']} ({tab_info['persona']})"
        title_cell.font = Font(name=FONT_NAME, size=11.5, bold=True, color="FFFFFF")
        title_cell.fill = PatternFill(start_color=GOLD_BROWN, end_color=GOLD_BROWN, fill_type="solid")
        title_cell.alignment = Alignment(horizontal="left", vertical="center", indent=1)
        ws.row_dimensions[1].height = 30

        # Row 2: Access & Credentials Info
        ws.merge_cells("A2:D2")
        ws["A2"].value = f"Tài khoản Test: {tab_info['account_info']}"
        ws["A2"].font = Font(name=FONT_NAME, size=9.5, bold=True, color="1E293B")
        ws["A2"].fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")
        ws["A2"].alignment = Alignment(horizontal="left", vertical="center", indent=1)

        ws.merge_cells("E2:G2")
        ws["E2"].value = f"URL Truy cập: {tab_info['url_access']}"
        ws["E2"].font = Font(name=FONT_NAME, size=9.5, bold=False, color="0284C7")
        ws["E2"].fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")
        ws["E2"].alignment = Alignment(horizontal="left", vertical="center", indent=1)

        ws["H2"].value = "Tổng Test Cases:"
        ws["H2"].font = Font(name=FONT_NAME, size=9.5, bold=True, color="475569")
        ws["H2"].alignment = Alignment(horizontal="right", vertical="center")
        ws["H2"].fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")

        ws["I2"].value = "=COUNTA(A4:A13)"
        ws["I2"].font = Font(name=FONT_NAME, size=11, bold=True, color=GOLD_BROWN)
        ws["I2"].alignment = Alignment(horizontal="center", vertical="center")
        ws["I2"].fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")

        ws["J2"].value = f"Mục tiêu: Đạt 100%"
        ws["J2"].font = Font(name=FONT_NAME, size=9, italic=True, color="64748B")
        ws["J2"].alignment = Alignment(horizontal="center", vertical="center")
        ws["J2"].fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")
        ws.row_dimensions[2].height = 24

        # Row 3: Headers
        headers = [
            ("Mã TC", 14),
            ("Tên Kịch Bản", 28),
            ("Tiền Điều Kiện", 26),
            ("Các Bước Thực Hiện (Test Steps)", 45),
            ("Dữ Liệu Test", 25),
            ("Kết Quả Mong Đợi", 42),
            ("Kết Quả Thực Tế", 30),
            ("Trạng Thái", 15),
            ("Mức Độ", 14),
            ("Ghi Chú / Bug ID", 20)
        ]
        
        for col_idx, (hdr_text, col_width) in enumerate(headers, 1):
            cell = ws.cell(row=3, column=col_idx, value=hdr_text)
            cell.font = Font(name=FONT_NAME, size=10, bold=True, color="FFFFFF")
            cell.fill = PatternFill(start_color=NAVY_DARK, end_color=NAVY_DARK, fill_type="solid")
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            cell.border = header_border
            col_letter = get_column_letter(col_idx)
            ws.column_dimensions[col_letter].width = col_width
            
        ws.row_dimensions[3].height = 26

        # Row 4 to 13: Test Cases
        for row_offset, case_tuple in enumerate(tab_info["cases"]):
            curr_row = 4 + row_offset
            tc_code, tc_title, tc_pre, tc_steps, tc_data, tc_expected, tc_status, tc_severity = case_tuple
            
            row_data = [
                tc_code,
                tc_title,
                tc_pre,
                tc_steps,
                tc_data,
                tc_expected,
                "",             # Actual result (empty for tester to enter)
                tc_status,      # Untested
                tc_severity,    # Blocker / Critical / Major / Minor
                ""              # Bug ID
            ]
            
            for col_idx, val in enumerate(row_data, 1):
                cell = ws.cell(row=curr_row, column=col_idx, value=val)
                cell.font = Font(name=FONT_NAME, size=9.5)
                cell.border = thin_border
                
                # Alignments
                if col_idx in [1, 8, 9]:
                    cell.alignment = Alignment(horizontal="center", vertical="top")
                elif col_idx in [4, 6, 7]:
                    cell.alignment = Alignment(horizontal="left", vertical="top", wrap_text=True)
                else:
                    cell.alignment = Alignment(horizontal="left", vertical="top", wrap_text=True)
                    
                # Status styling
                if col_idx == 8:
                    cell.font = Font(name=FONT_NAME, size=10, bold=True, color=STATUS_UNTESTED_FONT)
                    cell.fill = PatternFill(start_color=STATUS_UNTESTED_FILL, end_color=STATUS_UNTESTED_FILL, fill_type="solid")
                elif col_idx == 9:
                    sev_color = "991B1B" if val == "Blocker" else ("B45309" if val == "Critical" else ("1D4ED8" if val == "Major" else "475569"))
                    cell.font = Font(name=FONT_NAME, size=9.5, bold=True, color=sev_color)
                elif col_idx == 1:
                    cell.font = Font(name=FONT_NAME, size=9.5, bold=True, color=GOLD_BROWN)

            ws.row_dimensions[curr_row].height = 55

        # Freeze pane at row 4
        ws.freeze_panes = "A4"

    # =========================================================================
    # CREATE TAB 1: TỔNG QUAN & PHÂN CÔNG (Summary & Assignee Matrix)
    # =========================================================================
    default_sheet = wb["Sheet"] if "Sheet" in wb.sheetnames else None
    ws1 = wb.create_sheet(title="Tổng quan & Phân công", index=0)
    if default_sheet:
        wb.remove(default_sheet)
    ws1.views.sheetView[0].showGridLines = True

    # Main Title
    ws1.merge_cells("A1:K1")
    ws1["A1"].value = "KẾ HOẠCH & MA TRẬN PHÂN CÔNG UAT CÁC QUY TRÌNH CORE VELURA E-COMMERCE"
    ws1["A1"].font = Font(name=FONT_NAME, size=14, bold=True, color="FFFFFF")
    ws1["A1"].fill = PatternFill(start_color=GOLD_BROWN, end_color=GOLD_BROWN, fill_type="solid")
    ws1["A1"].alignment = Alignment(horizontal="center", vertical="center")
    ws1.row_dimensions[1].height = 36

    ws1.merge_cells("A2:K2")
    ws1["A2"].value = "Phạm vi: 6 Quy trình Kinh doanh Cốt lõi (Core Storefront & Backoffice) | 6 Testers - 60 Kịch bản | Zero Formula Errors"
    ws1["A2"].font = Font(name=FONT_NAME, size=10, italic=True, color="475569")
    ws1["A2"].fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")
    ws1["A2"].alignment = Alignment(horizontal="center", vertical="center")
    ws1.row_dimensions[2].height = 22

    # KPI Stat Cards (Rows 4 to 6)
    kpis = [
        ("B4", "C4", "B5", "C5", "B6", "C6", "TỔNG TEST CASES", 
         "='1. Thêm Giỏ Hàng & PDP'!I2 + '2. Mua Hàng & Thanh Toán'!I2 + '3. Hủy Đơn & Đổi Trả'!I2 + '4. Khuyến Mãi & Voucher'!I2 + '5. Đánh Giá Sản Phẩm'!I2 + '6. Quản Lý Sản Phẩm & Đơn'!I2", 
         "6 Quy trình Core E2E", "1E293B", "F8FAFC", "0F172A", False),
         
        ("E4", "F4", "E5", "F5", "E6", "F6", "ĐẠT (PASS)", 
         "=COUNTIF('1. Thêm Giỏ Hàng & PDP'!H4:H13, \"Pass\") + COUNTIF('2. Mua Hàng & Thanh Toán'!H4:H13, \"Pass\") + COUNTIF('3. Hủy Đơn & Đổi Trả'!H4:H13, \"Pass\") + COUNTIF('4. Khuyến Mãi & Voucher'!H4:H13, \"Pass\") + COUNTIF('5. Đánh Giá Sản Phẩm'!H4:H13, \"Pass\") + COUNTIF('6. Quản Lý Sản Phẩm & Đơn'!H4:H13, \"Pass\")", 
         "Kịch bản vượt qua", "166534", "DCFCE7", "166534", False),
         
        ("H4", "I4", "H5", "I5", "H6", "I6", "LỖI (FAIL)", 
         "=COUNTIF('1. Thêm Giỏ Hàng & PDP'!H4:H13, \"Fail\") + COUNTIF('2. Mua Hàng & Thanh Toán'!H4:H13, \"Fail\") + COUNTIF('3. Hủy Đơn & Đổi Trả'!H4:H13, \"Fail\") + COUNTIF('4. Khuyến Mãi & Voucher'!H4:H13, \"Fail\") + COUNTIF('5. Đánh Giá Sản Phẩm'!H4:H13, \"Fail\") + COUNTIF('6. Quản Lý Sản Phẩm & Đơn'!H4:H13, \"Fail\")", 
         "Cần DEV xử lý", "991B1B", "FEE2E2", "991B1B", False),
         
        ("J4", "K4", "J5", "K5", "J6", "K6", "TỶ LỆ ĐẠT (PASS RATE)", 
         "=IF(B5>0, E5/B5, 0)", 
         "Mục tiêu: >= 95%", "7D562D", "FEF3C7", "B45309", True)
    ]

    for c_start, c_end, val_start, val_end, sub_start, sub_end, title, formula, subtitle, text_col, bg_col, num_col, is_pct in kpis:
        ws1.merge_cells(f"{c_start}:{c_end}")
        ws1[c_start].value = title
        ws1[c_start].font = Font(name=FONT_NAME, size=9.5, bold=True, color=text_col)
        ws1[c_start].fill = PatternFill(start_color=bg_col, end_color=bg_col, fill_type="solid")
        ws1[c_start].alignment = Alignment(horizontal="center", vertical="center")

        ws1.merge_cells(f"{val_start}:{val_end}")
        ws1[val_start].value = formula
        ws1[val_start].font = Font(name=FONT_NAME, size=18, bold=True, color=num_col)
        ws1[val_start].fill = PatternFill(start_color=bg_col, end_color=bg_col, fill_type="solid")
        ws1[val_start].alignment = Alignment(horizontal="center", vertical="center")
        if is_pct:
            ws1[val_start].number_format = '0.0%'

        ws1.merge_cells(f"{sub_start}:{sub_end}")
        ws1[sub_start].value = subtitle
        ws1[sub_start].font = Font(name=FONT_NAME, size=8.5, italic=True, color="64748B")
        ws1[sub_start].fill = PatternFill(start_color=bg_col, end_color=bg_col, fill_type="solid")
        ws1[sub_start].alignment = Alignment(horizontal="center", vertical="center")

    ws1.row_dimensions[4].height = 20
    ws1.row_dimensions[5].height = 32
    ws1.row_dimensions[6].height = 18

    # Section 1: Tester Assignment Table
    ws1.cell(row=8, column=1, value="1. MA TRẬN PHÂN CÔNG 6 NHÂN SỰ UAT & TÀI KHOẢN TRUY CẬP (MỖI NGƯỜI 1 TAB CORE)").font = Font(name=FONT_NAME, size=11, bold=True, color="1E293B")
    
    assign_headers = [
        ("Mã Tester", 12),
        ("Họ và Tên", 18),
        ("Vai Trò (Persona)", 25),
        ("Tab Quy Trình Phụ Trách", 26),
        ("Tài Khoản Đăng Nhập", 26),
        ("Mật Khẩu Mặc Định", 16),
        ("Số Lượng TC", 14),
        ("Số TC Đạt", 12),
        ("Số TC Lỗi", 12),
        ("Tỷ Lệ Đạt", 14),
        ("Trạng Thái Tiến Độ", 18)
    ]
    for col_idx, (h_text, h_width) in enumerate(assign_headers, 1):
        cell = ws1.cell(row=9, column=col_idx, value=h_text)
        cell.font = Font(name=FONT_NAME, size=10, bold=True, color="FFFFFF")
        cell.fill = PatternFill(start_color=NAVY_DARK, end_color=NAVY_DARK, fill_type="solid")
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = header_border
        col_letter = get_column_letter(col_idx)
        ws1.column_dimensions[col_letter].width = h_width
    ws1.row_dimensions[9].height = 26

    testers = [
        ("Tester 01", "Nguyễn Thị Ánh", "Khách Shopper Online", "1. Thêm Giỏ Hàng & PDP", "shopper.uat@velura.test", "Velura@2026", "='1. Thêm Giỏ Hàng & PDP'!I2", "=COUNTIF('1. Thêm Giỏ Hàng & PDP'!H4:H13, \"Pass\")", "=COUNTIF('1. Thêm Giỏ Hàng & PDP'!H4:H13, \"Fail\")", "=IF(G10>0, H10/G10, 0)"),
        ("Tester 02", "Trần Quốc Bảo", "Khách Mua Ngay & Checkout", "2. Mua Hàng & Thanh Toán", "shopper.checkout@velura.test", "Velura@2026", "='2. Mua Hàng & Thanh Toán'!I2", "=COUNTIF('2. Mua Hàng & Thanh Toán'!H4:H13, \"Pass\")", "=COUNTIF('2. Mua Hàng & Thanh Toán'!H4:H13, \"Fail\")", "=IF(G11>0, H11/G11, 0)"),
        ("Tester 03", "Lê Hoàng Châu", "Khách Hậu Mãi & CSKH RMA", "3. Hủy Đơn & Đổi Trả", "customer.rma@velura.test", "Velura@2026", "='3. Hủy Đơn & Đổi Trả'!I2", "=COUNTIF('3. Hủy Đơn & Đổi Trả'!H4:H13, \"Pass\")", "=COUNTIF('3. Hủy Đơn & Đổi Trả'!H4:H13, \"Fail\")", "=IF(G12>0, H12/G12, 0)"),
        ("Tester 04", "Phạm Văn Dũng", "Trưởng Phòng MKT & Săn Sale", "4. Khuyến Mãi & Voucher", "admin.marketing@velura.vn", "Admin@2026", "='4. Khuyến Mãi & Voucher'!I2", "=COUNTIF('4. Khuyến Mãi & Voucher'!H4:H13, \"Pass\")", "=COUNTIF('4. Khuyến Mãi & Voucher'!H4:H13, \"Fail\")", "=IF(G13>0, H13/G13, 0)"),
        ("Tester 05", "Đặng Thị Mai", "Khách Review & CSKH Duyệt", "5. Đánh Giá Sản Phẩm", "chau.le@gmail.test", "Velura@2026", "='5. Đánh Giá Sản Phẩm'!I2", "=COUNTIF('5. Đánh Giá Sản Phẩm'!H4:H13, \"Pass\")", "=COUNTIF('5. Đánh Giá Sản Phẩm'!H4:H13, \"Fail\")", "=IF(G14>0, H14/G14, 0)"),
        ("Tester 06", "Vũ Minh Tuấn", "Quản Trị Catalog & Vận Hành", "6. Quản Lý Sản Phẩm & Đơn", "admin.operator@velura.vn", "Admin@2026", "='6. Quản Lý Sản Phẩm & Đơn'!I2", "=COUNTIF('6. Quản Lý Sản Phẩm & Đơn'!H4:H13, \"Pass\")", "=COUNTIF('6. Quản Lý Sản Phẩm & Đơn'!H4:H13, \"Fail\")", "=IF(G15>0, H15/G15, 0)")
    ]

    for idx, t in enumerate(testers, 10):
        t_code, t_name, t_role, t_tab, t_user, t_pass, f_total, f_pass, f_fail, f_rate = t
        ws1.cell(row=idx, column=1, value=t_code).alignment = Alignment(horizontal="center", vertical="center")
        ws1.cell(row=idx, column=1).font = Font(name=FONT_NAME, size=10, bold=True, color=GOLD_BROWN)
        ws1.cell(row=idx, column=2, value=t_name).font = Font(name=FONT_NAME, size=10, bold=True)
        ws1.cell(row=idx, column=3, value=t_role).font = Font(name=FONT_NAME, size=9.5)
        ws1.cell(row=idx, column=4, value=t_tab).font = Font(name=FONT_NAME, size=9.5, bold=True, color=ACCENT_BLUE)
        ws1.cell(row=idx, column=5, value=t_user).font = Font(name=FONT_NAME, size=9.5)
        ws1.cell(row=idx, column=6, value=t_pass).font = Font(name=FONT_NAME, size=9.5, color="475569")
        
        ws1.cell(row=idx, column=7, value=f_total).font = Font(name=FONT_NAME, size=10, bold=True)
        ws1.cell(row=idx, column=7).alignment = Alignment(horizontal="center", vertical="center")

        ws1.cell(row=idx, column=8, value=f_pass).font = Font(name=FONT_NAME, size=10, bold=True, color="166534")
        ws1.cell(row=idx, column=8).alignment = Alignment(horizontal="center", vertical="center")

        ws1.cell(row=idx, column=9, value=f_fail).font = Font(name=FONT_NAME, size=10, bold=True, color="991B1B")
        ws1.cell(row=idx, column=9).alignment = Alignment(horizontal="center", vertical="center")

        ws1.cell(row=idx, column=10, value=f_rate).font = Font(name=FONT_NAME, size=10, bold=True)
        ws1.cell(row=idx, column=10).alignment = Alignment(horizontal="center", vertical="center")
        ws1.cell(row=idx, column=10).number_format = '0.0%'

        ws1.cell(row=idx, column=11, value=f'=IF(J{idx}>=0.95, "Sẵn sàng Release", IF(I{idx}>0, "Đang có Bug chặn", "Đang kiểm thử"))')
        ws1.cell(row=idx, column=11).font = Font(name=FONT_NAME, size=9.5, italic=True)
        ws1.cell(row=idx, column=11).alignment = Alignment(horizontal="center", vertical="center")

        for c in range(1, 12):
            ws1.cell(row=idx, column=c).border = thin_border
        ws1.row_dimensions[idx].height = 24

    # Summary Row 16
    ws1.merge_cells("A16:F16")
    ws1["A16"].value = "TỔNG CỘNG 6 QUY TRÌNH CORE"
    ws1["A16"].font = Font(name=FONT_NAME, size=10, bold=True, color="1E293B")
    ws1["A16"].alignment = Alignment(horizontal="right", vertical="center")
    ws1["A16"].fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")

    ws1["G16"].value = "=SUM(G10:G15)"
    ws1["G16"].font = Font(name=FONT_NAME, size=11, bold=True, color=GOLD_BROWN)
    ws1["G16"].alignment = Alignment(horizontal="center", vertical="center")
    ws1["G16"].fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")

    ws1["H16"].value = "=SUM(H10:H15)"
    ws1["H16"].font = Font(name=FONT_NAME, size=11, bold=True, color="166534")
    ws1["H16"].alignment = Alignment(horizontal="center", vertical="center")
    ws1["H16"].fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")

    ws1["I16"].value = "=SUM(I10:I15)"
    ws1["I16"].font = Font(name=FONT_NAME, size=11, bold=True, color="991B1B")
    ws1["I16"].alignment = Alignment(horizontal="center", vertical="center")
    ws1["I16"].fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")

    ws1["J16"].value = "=IF(G16>0, H16/G16, 0)"
    ws1["J16"].font = Font(name=FONT_NAME, size=11, bold=True, color=GOLD_BROWN)
    ws1["J16"].alignment = Alignment(horizontal="center", vertical="center")
    ws1["J16"].fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")
    ws1["J16"].number_format = '0.0%'

    ws1["K16"].value = '=IF(J16>=0.95, "ĐẠT NGHIỆM THU", "CHƯA ĐẠT")'
    ws1["K16"].font = Font(name=FONT_NAME, size=10, bold=True, color="1E293B")
    ws1["K16"].alignment = Alignment(horizontal="center", vertical="center")
    ws1["K16"].fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")

    for c in range(1, 12):
        ws1.cell(row=16, column=c).border = thin_border
    ws1.row_dimensions[16].height = 26

    # Section 2: Severity Standard & SLA
    ws1.cell(row=18, column=1, value="2. QUY CHUẨN ĐÁNH GIÁ MỨC ĐỘ LỖI (DEFECT SEVERITY) & CAM KẾT XỬ LÝ (SLA)").font = Font(name=FONT_NAME, size=11, bold=True, color="1E293B")
    
    sev_headers = [("Mức độ", 12), ("Định nghĩa kỹ thuật", 35), ("Tác động nghiệp vụ", 28), ("Ví dụ thực tế trong Velura", 35), ("Cam kết SLA Fix", 18)]
    for c_idx, (sh_text, sh_w) in enumerate(sev_headers, 1):
        cell = ws1.cell(row=19, column=c_idx, value=sh_text)
        cell.font = Font(name=FONT_NAME, size=10, bold=True, color="FFFFFF")
        cell.fill = PatternFill(start_color=NAVY_DARK, end_color=NAVY_DARK, fill_type="solid")
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = header_border
    ws1.row_dimensions[19].height = 24

    sevs = [
        ("Blocker", "Lỗi sập luồng (Crash/500), dừng toàn bộ quy trình, không có cách giải quyết thay thế (No Workaround).", "Khách không thể thanh toán, mất doanh thu lập tức.", "Lỗi thanh toán Stripe 500; Hết hàng tồn nhưng nút Mua ngay vẫn không khóa; Kho không nhận được hàng.", "Khắc phục <= 2h"),
        ("Critical", "Chức năng chính bị hỏng nặng, sai lệch tiền tệ, tính sai giá trị hoàn trả hoặc sai tồn kho.", "Ảnh hưởng dữ liệu tài chính, thất thoát doanh thu hoặc tiền hoàn.", "Số tiền hoàn đổi trả cho phép sửa tay; Voucher áp dụng sai chiết khấu; Đơn hàng không cập nhật tồn kho.", "Khắc phục <= 6h"),
        ("Major", "Chức năng quan trọng không đúng thiết kế nhưng có phương án giải quyết tạm thời.", "Gây trải nghiệm xấu cho người dùng, làm gián đoạn nhưng vẫn hoàn tất được đơn.", "Dropdown menu thao tác đổi trả bị vỡ giao diện; Không tải được ảnh review; Voucher sinh nhật không tự nạp.", "Khắc phục <= 24h"),
        ("Minor", "Lỗi giao diện (UI), sai chính tả, lệch khoảng cách padding, thiếu tooltip thông tin.", "Không ảnh hưởng đến logic nghiệp vụ cốt lõi.", "Icon căn lệch 2px; Màu sắc badge chưa chuẩn token thiết kế; Thiếu placeholder hướng dẫn.", "Khắc phục Sprint tới")
    ]

    for s_idx, (s_name, s_def, s_imp, s_ex, s_sla) in enumerate(sevs, 20):
        c1 = ws1.cell(row=s_idx, column=1, value=s_name)
        c1.alignment = Alignment(horizontal="center", vertical="center")
        c1.font = Font(name=FONT_NAME, size=10, bold=True, 
                       color="991B1B" if s_name=="Blocker" else ("B45309" if s_name=="Critical" else ("1D4ED8" if s_name=="Major" else "475569")))
        
        ws1.cell(row=s_idx, column=2, value=s_def).alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
        ws1.cell(row=s_idx, column=3, value=s_imp).alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
        ws1.cell(row=s_idx, column=4, value=s_ex).alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
        c5 = ws1.cell(row=s_idx, column=5, value=s_sla)
        c5.alignment = Alignment(horizontal="center", vertical="center")
        c5.font = Font(name=FONT_NAME, size=9.5, bold=True, color="1E293B")

        for c in range(1, 6):
            ws1.cell(row=s_idx, column=c).border = thin_border
            ws1.cell(row=s_idx, column=c).font = Font(name=FONT_NAME, size=9.5)
            if c == 1:
                ws1.cell(row=s_idx, column=c).font = Font(name=FONT_NAME, size=10, bold=True, color="991B1B" if s_name=="Blocker" else ("B45309" if s_name=="Critical" else ("1D4ED8" if s_name=="Major" else "475569")))
        ws1.row_dimensions[s_idx].height = 36

    # =========================================================================
    # CREATE TAB 8: NHẬT KÝ BÁO CÁO BUG UAT (Defect Tracking Sheet)
    # =========================================================================
    ws_bug = wb.create_sheet(title="Nhật ký Báo cáo Bug UAT")
    ws_bug.views.sheetView[0].showGridLines = True

    ws_bug.merge_cells("A1:K1")
    ws_bug["A1"].value = "NHẬT KÝ THEO DÕI VÀ BÁO CÁO LỖI PHÁT SINH TRONG QUÁ TRÌNH UAT (DEFECT LOG)"
    ws_bug["A1"].font = Font(name=FONT_NAME, size=12, bold=True, color="FFFFFF")
    ws_bug["A1"].fill = PatternFill(start_color="991B1B", end_color="991B1B", fill_type="solid")
    ws_bug["A1"].alignment = Alignment(horizontal="center", vertical="center")
    ws_bug.row_dimensions[1].height = 32

    bug_headers = [
        ("Bug ID", 12),
        ("Quy Trình / Tab", 24),
        ("Mã TC Liên Quan", 14),
        ("Tóm Tắt Lỗi (Defect Summary)", 38),
        ("Mức Độ", 12),
        ("Các Bước Tái Hiện (Steps to Reproduce)", 40),
        ("Kết Quả Thực Tế Bị Lỗi", 32),
        ("Người Báo Lỗi", 16),
        ("Trạng Thái Fix", 16),
        ("Dev Phụ Trách", 16),
        ("Ghi Chú / Link PR Fix", 22)
    ]

    for col_idx, (bh_text, bh_width) in enumerate(bug_headers, 1):
        cell = ws_bug.cell(row=2, column=col_idx, value=bh_text)
        cell.font = Font(name=FONT_NAME, size=10, bold=True, color="FFFFFF")
        cell.fill = PatternFill(start_color=NAVY_DARK, end_color=NAVY_DARK, fill_type="solid")
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = header_border
        col_letter = get_column_letter(col_idx)
        ws_bug.column_dimensions[col_letter].width = bh_width
    ws_bug.row_dimensions[2].height = 26

    sample_bugs = [
        ("BUG-001", "1. Thêm Giỏ Hàng & PDP", "TC-CART-04", "Biến thể hết hàng tồn kho nhưng nút Mua ngay không bị vô hiệu hóa", "Blocker", "1. Chọn sản phẩm SP-001.\n2. Chọn Màu Đen, Size XL (Stock = 0).\n3. Nút Mua ngay vẫn bấm được và chuyển sang Checkout.", "Cho phép đặt hàng sản phẩm không còn trong kho dẫn đến âm tồn kho.", "Nguyễn Thị Ánh", "Fixed", "Dev Core", "PR #142 (Closed)"),
        ("BUG-002", "3. Hủy Đơn & Đổi Trả", "TC-RMA-06", "Số tiền hoàn đổi trả cho phép sửa tay dẫn đến nguy cơ sai lệch kế toán", "Critical", "1. Mở form yêu cầu đổi trả `/account/returns`.\n2. Chọn hình thức hoàn tiền.\n3. Ô số tiền cho phép gõ số tiền lớn hơn hóa đơn gốc.", "Khách hàng có thể gian lận sửa số tiền hoàn cao hơn thực tế.", "Lê Hoàng Châu", "Fixed", "Dev Core", "PR #145 (Closed)"),
        ("BUG-003", "4. Khuyến Mãi & Voucher", "TC-PROMO-08", "Voucher không kiểm tra điều kiện giá trị đơn hàng tối thiểu tại Checkout", "Critical", "1. Giỏ hàng 300.000đ.\n2. Nhập mã VELURA20 (yêu cầu min 500k).\n3. Hệ thống vẫn trừ tiền 20% bình thường.", "Sai lệch chính sách marketing, vi phạm biên lợi nhuận công ty.", "Phạm Văn Dũng", "Fixed", "Dev Core", "PR #148 (Closed)"),
        ("BUG-004", "5. Đánh Giá Sản Phẩm", "TC-REV-03", "Tải ảnh đánh giá bị lỗi tràn màn hình khi upload 3 ảnh cùng lúc", "Major", "1. Tại form đánh giá chọn tải lên 3 ảnh JPG.\n2. Thumbnails preview bị tràn ra khỏi modal không xem được nút xóa.", "Giao diện bị vỡ trên màn hình tablet/mobile.", "Đặng Thị Mai", "Fixed", "Dev Frontend", "PR #150 (Closed)")
    ]

    for b_idx, bug_row in enumerate(sample_bugs, 3):
        for col_idx, b_val in enumerate(bug_row, 1):
            cell = ws_bug.cell(row=b_idx, column=col_idx, value=b_val)
            cell.font = Font(name=FONT_NAME, size=9.5)
            cell.border = thin_border
            if col_idx in [1, 3, 5, 8, 9, 10]:
                cell.alignment = Alignment(horizontal="center", vertical="top")
            else:
                cell.alignment = Alignment(horizontal="left", vertical="top", wrap_text=True)
            if col_idx == 1:
                cell.font = Font(name=FONT_NAME, size=9.5, bold=True, color="991B1B")
            elif col_idx == 5:
                cell.font = Font(name=FONT_NAME, size=9.5, bold=True, color="991B1B" if b_val=="Blocker" else "B45309")
            elif col_idx == 9:
                cell.font = Font(name=FONT_NAME, size=9.5, bold=True, color="166534" if b_val=="Fixed" else "B45309")
        ws_bug.row_dimensions[b_idx].height = 42

    # Blank rows for logging new defects
    for empty_idx in range(len(sample_bugs) + 3, len(sample_bugs) + 20):
        b_code = f"BUG-{empty_idx-2:03d}"
        c = ws_bug.cell(row=empty_idx, column=1, value=b_code)
        c.font = Font(name=FONT_NAME, size=9.5, color="94A3B8")
        c.alignment = Alignment(horizontal="center", vertical="center")
        c.border = thin_border
        for col_idx in range(2, 12):
            ws_bug.cell(row=empty_idx, column=col_idx).border = thin_border
        ws_bug.row_dimensions[empty_idx].height = 24

    ws_bug.freeze_panes = "A3"

    # Save workbook to both paths
    output_dir = os.path.join("docs", "ba")
    os.makedirs(output_dir, exist_ok=True)
    
    core_file = os.path.join(output_dir, "Velura_UAT_Core_Workflows_6_Testers.xlsx")
    wb.save(core_file)
    print(f"UAT Core Workbook created successfully at: {core_file}")

    # Also update the canonical name if available
    alt_file = os.path.join(output_dir, "Velura_UAT_E2E_Workflows_6_Testers.xlsx")
    try:
        wb.save(alt_file)
        print(f"Also updated: {alt_file}")
    except PermissionError:
        print(f"Note: {alt_file} is locked by Excel.")

    alt_file_orig = os.path.join(output_dir, "Velura_UAT_Test_Plan_Core_Workflows_6_Testers.xlsx")
    try:
        wb.save(alt_file_orig)
        print(f"Also updated: {alt_file_orig}")
    except PermissionError:
        print(f"Note: {alt_file_orig} is locked by Excel.")

if __name__ == "__main__":
    build_core_uat_workbook()
