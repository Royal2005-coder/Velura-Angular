# -*- coding: utf-8 -*-
"""
Script to generate the complete, standardized Velura End-to-End UAT Excel workbook:
File output: docs/ba/Velura_UAT_Toan_Bo_He_Thong_User_Admin.xlsx
Also copy to: docs/ba/Velura_UAT_Doi_chieu_Quy_trinh_BA_3.1.x.xlsx

Key features:
1. Sheet 00_Tong_Quan_PCCV: Overall project info, assignment matrix for 6 members with 2:1 ratio
   (Khai: 4 tabs, Han: 4 tabs, Ninh: 4 tabs; Gia: 2 tabs, Quynh: 2 tabs, Uyen: 2 tabs).
   Progress rollup with live COUNTIF formulas linking to all functional tabs.
2. Sheet 01_Huong_Dan_UAT: Test environment URLs, credentials per role, Stripe test cards,
   detailed 6-step testing workflow, FE/BE inspection guide (DevTools Network/Console).
3. Sheet 02_Mau_Bao_Cao_Issue_GitHub: Official GitHub bug issue template, syntax rules, labels,
   realistic FE & BE examples with link to repo https://github.com/Royal2005-coder/Velura-Angular.
4. Sheet 03_Nhat_Ky_Issue_Feedback: Central bug tracking log for the whole team.
5. 16 Functional UAT Tabs: Each with metadata banner, standardized 17-column framework,
   dropdown data validations, conditional formatting, 3-5 prefilled sample test cases
   based directly on the BA ADVANCE document, and empty formatted rows for testers to fill.
"""

import os
import shutil
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import CellIsRule

OUTPUT_DIR = os.path.join("docs", "ba")
os.makedirs(OUTPUT_DIR, exist_ok=True)
FILE_MAIN = os.path.join(OUTPUT_DIR, "Velura_UAT_Toan_Bo_He_Thong_User_Admin.xlsx")
FILE_COMPAT = os.path.join(OUTPUT_DIR, "Velura_UAT_Doi_chieu_Quy_trinh_BA_3.1.x.xlsx")

# ----------------------------------------------------------------------------------------
# Visual Design System (Velura Brand Colors)
# ----------------------------------------------------------------------------------------
MAROON_DARK = "4A1523"
MAROON = "7A283C"
ROSE = "C94F70"
BLUSH_LIGHT = "FBEFF3"
BLUSH_BG = "FFF9FB"
GRAY_LIGHT = "F3F4F6"
GRAY_BORDER = "D1D5DB"
WHITE = "FFFFFF"

# Status colors
PASS_BG = "DEF7EC"
PASS_TEXT = "03543F"
FAIL_BG = "FDE8E8"
FAIL_TEXT = "9B1C1C"
BLOCK_BG = "FEF08A"
BLOCK_TEXT = "854D0E"

# Fonts
font_title = Font(name="Segoe UI", size=14, bold=True, color=WHITE)
font_tbl_header = Font(name="Segoe UI", size=9.5, bold=True, color=WHITE)
font_sec_header = Font(name="Segoe UI", size=11, bold=True, color=WHITE)
font_bold_maroon = Font(name="Segoe UI", size=9.5, bold=True, color=MAROON)
font_bold = Font(name="Segoe UI", size=9.5, bold=True, color="111827")
font_normal = Font(name="Segoe UI", size=9, color="1F2937")
font_small = Font(name="Segoe UI", size=8.5, color="4B5563")
font_code = Font(name="Consolas", size=8.5, color="1F2937")

# Fills
fill_maroon = PatternFill(start_color=MAROON, end_color=MAROON, fill_type="solid")
fill_maroon_dark = PatternFill(start_color=MAROON_DARK, end_color=MAROON_DARK, fill_type="solid")
fill_rose = PatternFill(start_color=ROSE, end_color=ROSE, fill_type="solid")
fill_blush = PatternFill(start_color=BLUSH_LIGHT, end_color=BLUSH_LIGHT, fill_type="solid")
fill_zebra = PatternFill(start_color=BLUSH_BG, end_color=BLUSH_BG, fill_type="solid")
fill_gray_header = PatternFill(start_color="374151", end_color="374151", fill_type="solid")
fill_gray_light = PatternFill(start_color=GRAY_LIGHT, end_color=GRAY_LIGHT, fill_type="solid")
fill_white = PatternFill(start_color=WHITE, end_color=WHITE, fill_type="solid")

# Borders
thin_border = Side(style="thin", color=GRAY_BORDER)
border_cell = Border(left=thin_border, right=thin_border, top=thin_border, bottom=thin_border)
border_header = Border(left=thin_border, right=thin_border, top=thin_border, bottom=Side(style="medium", color=MAROON_DARK))

# Alignments
align_center = Alignment(horizontal="center", vertical="center", wrap_text=True)
align_left = Alignment(horizontal="left", vertical="center", wrap_text=True)
align_right = Alignment(horizontal="right", vertical="center")
align_top_left = Alignment(horizontal="left", vertical="top", wrap_text=True)

# ----------------------------------------------------------------------------------------
# Members Assignment (6 Members, 2:1 Ratio)
# Khai (4), Han (4), Ninh (4) = 12 tabs
# Gia (2), Quynh (2), Uyen (2) = 6 tabs
# ----------------------------------------------------------------------------------------
MEMBERS = [
    {"name": "Khải", "role": "Tester Lead / Fullstack UAT", "tabs_count": 4, "ratio": "Gấp đôi (4 tab)", "note": "Phụ trách Sản phẩm, Khuyến mãi, Thành viên, Dashboard"},
    {"name": "Hân", "role": "Tester Lead / User Experience UAT", "tabs_count": 4, "ratio": "Gấp đôi (4 tab)", "note": "Phụ trách Style Quiz, Tìm kiếm/Lens AI, Theo dõi đơn, Reviews"},
    {"name": "Ninh", "role": "Tester Lead / AI & Tech UAT", "tabs_count": 4, "ratio": "Gấp đôi (4 tab)", "note": "Phụ trách AI Stylist, CSKH Ticket, Thử đồ ảo VTO, Security/Audit"},
    {"name": "Gia", "role": "Core Developer / Focused UAT", "tabs_count": 2, "ratio": "Tiêu chuẩn (2 tab)", "note": "Phụ trách Auth/Đăng nhập, Quản lý tài khoản Admin (Backend Core)"},
    {"name": "Quỳnh", "role": "Core Developer / Focused UAT", "tabs_count": 2, "ratio": "Tiêu chuẩn (2 tab)", "note": "Phụ trách Đặt hàng Checkout, Quản lý Đơn hàng Admin (Fullstack Core)"},
    {"name": "Uyên", "role": "Core Developer / Focused UAT", "tabs_count": 2, "ratio": "Tiêu chuẩn (2 tab)", "note": "Phụ trách Đổi trả User, Quản lý Đổi trả & CSKH Admin (Frontend/RMA Core)"},
]

# ----------------------------------------------------------------------------------------
# 16 Functional Tabs Definitions
# ----------------------------------------------------------------------------------------
FUNCTIONAL_TABS = [
    {
        "code": "3.1.1",
        "sheet": "3.1.1_DangKy_DangNhap",
        "name": "Đăng ký, Đăng nhập & Xác thực OTP",
        "owner": "Gia",
        "side": "User + Admin",
        "scope": "3.1.1.1 Mô tả (BPMN Hình 3.1 & 3.2: Luồng chủ động · Luồng tạo tài khoản khi đặt hàng) · 3.1.1.2 Quy tắc AUTH-01…AUTH-08 · 3.1.1.3 Ngoại lệ: 4 tình huống",
        "screens": "User: /auth/signup, /auth/signin, /auth/forgot-password, /auth/reset-password, /auth/activate, /checkout/otp | Admin: /login, /register, /change-password",
        "accounts": "Tạo mới: SĐT/email tester. Member có sẵn: shopper.uat@velura.test (Velura@2026). Admin: admin.operator@velura.vn (Admin@2026)",
        "focus": "• Kiểm tra cả 2 luồng: Đăng ký/đăng nhập chủ động và Luồng tự động khi Guest Checkout.\n• Nhập sai mật khẩu 5 lần liên tiếp -> Khóa đăng nhập 15 phút (AUTH-02).\n• OTP SMS hết hạn trong 1 phút, nhập sai quá 5 lần vô hiệu hóa phiên (AUTH-07).\n• Mã Referral Code khi đăng ký mới -> ghi nhận trạng thái Pending và cấp voucher (AUTH-08).",
        "notes": "Kiểm tra cả phản hồi API Backend (/api/v1/auth/...) và lưu session token. Chụp màn hình khi có thông báo lỗi.",
        "sample_cases": [
            {
                "id": "TC_AUTH_01", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Đăng ký tài khoản Member mới thành công", "rule": "AUTH-01, AUTH-04",
                "pre": "SĐT và Email chưa từng đăng ký trong hệ thống",
                "steps": "1. Mở trang /auth/signup\n2. Nhập Họ tên, Email, SĐT, Mật khẩu (đủ chữ hoa, số, ký tự đặc biệt)\n3. Nhấn 'Đăng ký'\n4. Nhập mã OTP xác thực được gửi về",
                "data": "Email: uat_test_01@velura.test, Pass: Velura@2026, SĐT: 0912345678",
                "expected": "Tài khoản chuyển trạng thái Active, tự động đăng nhập và điều hướng về Trang chủ. Database tạo bản ghi user hợp lệ.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Gia", "date": "", "note": ""
            },
            {
                "id": "TC_AUTH_02", "subsys": "Backend", "group": "Quy tắc nghiệp vụ",
                "feature": "Khóa đăng nhập 15 phút khi nhập sai pass 5 lần", "rule": "AUTH-02",
                "pre": "Tài khoản Member đã tồn tại trong hệ thống",
                "steps": "1. Mở /auth/signin\n2. Nhập Email đúng, nhập sai Mật khẩu 5 lần liên tiếp\n3. Quan sát thông báo hệ thống ở lần thứ 5 và lần thứ 6",
                "data": "Email: shopper.uat@velura.test, Pass: WrongPass123!",
                "expected": "Hệ thống báo lỗi 'Tài khoản bị tạm khóa trong 15 phút do nhập sai quá 5 lần'. Lần thứ 6 API trả HTTP 423 Locked và từ chối xử lý.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Gia", "date": "", "note": ""
            },
            {
                "id": "TC_AUTH_03", "subsys": "Frontend", "group": "Tình huống ngoại lệ",
                "feature": "Guest checkout dùng SĐT đã liên kết Member", "rule": "3.1.1.3 TH2",
                "pre": "SĐT 0909999888 đã có tài khoản Member chính thức",
                "steps": "1. Dùng trình duyệt ẩn danh, thêm sản phẩm vào giỏ, đến Checkout\n2. Nhập SĐT 0909999888 và xác thực OTP thành công",
                "data": "SĐT: 0909999888, OTP: Nhập mã nhận được",
                "expected": "Hệ thống cho phép tiếp tục đặt hàng luồng Guest, KHÔNG tự động đăng nhập vào Member, KHÔNG lộ thông tin tài khoản cá nhân của Member đó.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Gia", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.2",
        "sheet": "3.1.2_StyleQuiz_AIColor",
        "name": "Style Quiz & AI Personal Color",
        "owner": "Hân",
        "side": "User",
        "scope": "3.1.2.1 Mô tả (Style Quiz + AI Personal Color BPMN Hình 3.3) · 3.1.2.2 Quy tắc QUIZ-01…07, PC-01…30 · 3.1.2.3 Ngoại lệ: 20 tình huống",
        "screens": "User: /ai/style-quiz, /account/profile (hồ sơ phong cách, màu sắc cá nhân), /ai/suggestions",
        "accounts": "Member: shopper.uat@velura.test (Velura@2026). Guest: Cửa sổ ẩn danh.",
        "focus": "• Guest: Lưu Style Profile tạm trong Session; khi thoát trang có popup cảnh báo đăng ký để lưu vào DB (QUIZ-03).\n• Member: Dữ liệu đồng bộ trực tiếp vào database tài khoản.\n• AI Personal Color: Upload ảnh chân dung, kiểm tra định dạng JPG/PNG/WEBP <= 5MB, AI phân tích tone màu (Warm/Cool/Neutral), lưu palette màu phù hợp.\n• Cho phép bỏ qua hoặc thực hiện lại bất kỳ lúc nào từ Hồ sơ cá nhân.",
        "notes": "Nếu AI worker phản hồi chậm quá 15s hoặc báo quá tải, ghi nhận trạng thái 'Bị chặn' kèm thời gian test.",
        "sample_cases": [
            {
                "id": "TC_QUIZ_01", "subsys": "Frontend", "group": "Luồng chính (Happy Path)",
                "feature": "Hoàn thành bài khảo sát Style Quiz đầy đủ", "rule": "QUIZ-01..05",
                "pre": "Đã đăng nhập tài khoản Member chưa có Style Profile",
                "steps": "1. Mở /ai/style-quiz\n2. Nhập số đo chiều cao (165cm), cân nặng (52kg)\n3. Chọn phong cách, tone màu yêu thích, ngân sách\n4. Nhấn 'Hoàn thành'",
                "data": "Cao: 165, Nặng: 52, Vóc dáng: Đồng hồ cát, Style: Thanh lịch",
                "expected": "Hệ thống hiển thị kết quả hồ sơ phong cách, lưu vào /account/profile, gợi ý trang phục phù hợp ở trang chủ.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Hân", "date": "", "note": ""
            },
            {
                "id": "TC_QUIZ_02", "subsys": "Fullstack", "group": "Quy tắc nghiệp vụ",
                "feature": "Phân tích màu sắc cá nhân bằng AI (Personal Color)", "rule": "PC-01..15",
                "pre": "Có sẵn ảnh chụp rõ khuôn mặt dưới ánh sáng tự nhiên",
                "steps": "1. Tại bước Personal Color, chọn 'Phân tích bằng AI'\n2. Tải ảnh chân dung hợp lệ lên\n3. Xem trước ảnh và nhấn 'Phân tích'",
                "data": "File: portrait_valid.jpg (1.8MB, rõ mặt, không kính râm)",
                "expected": "AI trả về kết quả nhóm màu (Ví dụ: True Autumn / Cool Summer) kèm bảng mã màu khuyến nghị. Kết quả hiển thị trực quan.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Hân", "date": "", "note": ""
            },
            {
                "id": "TC_QUIZ_03", "subsys": "Frontend", "group": "Tình huống ngoại lệ",
                "feature": "Từ chối ảnh tải lên không đúng quy chuẩn", "rule": "PC-18, TH7",
                "pre": "Chuẩn bị file ảnh phong cảnh hoặc file dung lượng > 5MB",
                "steps": "1. Tải lên file ảnh cảnh vật landscape.jpg hoặc file 6MB\n2. Quan sát phản hồi giao diện",
                "data": "File: landscape_non_face.png (hoặc file > 5MB)",
                "expected": "Hệ thống từ chối ảnh ngay tại giao diện, hiển thị thông báo rõ ràng yêu cầu tải ảnh chân dung rõ mặt, không gửi request sang AI worker.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Hân", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.3",
        "sheet": "3.1.3_TimKiem_BoLoc_Lens",
        "name": "Tìm kiếm, Bộ lọc & Lens AI",
        "owner": "Hân",
        "side": "User",
        "scope": "3.1.3.1 Mô tả (4 BPMN Hình 3.4-3.7: Tìm kiếm/lọc/thêm giỏ · Chọn & kiểm tra ảnh · Phân tích ảnh & so khớp · Tối ưu theo Style Quiz) · 3.1.3.2 Quy tắc SHOP-01…SHOP-13 · 3.1.3.3 Ngoại lệ: 11 tình huống",
        "screens": "User: Header search box, /products (catalog + filter + sort), /products/:id (chi tiết sản phẩm, chọn size/màu, Thêm giỏ), /cart",
        "accounts": "Guest (cửa sổ ẩn danh) và Member: shopper.uat@velura.test",
        "focus": "• Tìm kiếm từ khóa + kết hợp bộ lọc (Danh mục, Giá, Màu sắc, Kích cỡ, Dáng người).\n• Bộ lọc 'Dáng người' (SHOP-02): Khóa hoặc làm mờ nếu chưa làm Style Quiz, hiện popup nhắc nhở.\n• Tìm kiếm bằng hình ảnh Lens AI (SHOP-06..13): Upload/chụp ảnh trang phục, crop vùng tìm kiếm, so khớp vector embedding, hiển thị sản phẩm tương đồng.\n• Thêm vào giỏ: Sản phẩm hết hàng tồn kho (stock=0) thì disable nút 'Thêm vào giỏ', đổi nhãn 'Tạm hết hàng' (SHOP-05).",
        "notes": "Kiểm tra kỹ badge số lượng giỏ hàng ở header cập nhật theo thời gian thực.",
        "sample_cases": [
            {
                "id": "TC_SHOP_01", "subsys": "Frontend", "group": "Luồng chính (Happy Path)",
                "feature": "Tìm kiếm sản phẩm theo từ khóa và áp dụng bộ lọc", "rule": "SHOP-01",
                "pre": "Đang ở trang chủ hoặc /products",
                "steps": "1. Gõ từ khóa 'Váy lụa' vào thanh tìm kiếm và Enter\n2. Lọc theo khoảng giá 500.000đ - 1.500.000đ, chọn màu 'Đỏ'\n3. Sắp xếp theo 'Giá giảm dần'",
                "data": "Keyword: 'Váy', Giá: 500k-1.5M, Màu: Đỏ",
                "expected": "Danh sách sản phẩm hiển thị đúng các mặt hàng thỏa mãn tất cả tiêu chí lọc, sắp xếp đúng thứ tự giá.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Hân", "date": "", "note": ""
            },
            {
                "id": "TC_SHOP_02", "subsys": "Fullstack", "group": "Quy tắc nghiệp vụ",
                "feature": "Tìm kiếm trang phục bằng hình ảnh (Lens AI)", "rule": "SHOP-06..10",
                "pre": "Có sẵn ảnh chụp chiếc đầm dạ hội",
                "steps": "1. Nhấn biểu tượng camera trên thanh tìm kiếm\n2. Tải ảnh đầm dạ hội lên, chọn vùng cần tìm\n3. Nhấn 'Tìm sản phẩm'",
                "data": "File: dam_da_hoi_sample.jpg (< 5MB)",
                "expected": "AI trích xuất thuộc tính (đầm, dài, đỏ, dạ hội) và trả về danh sách các sản phẩm tương đồng cao nhất trong kho đang bán.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Hân", "date": "", "note": ""
            },
            {
                "id": "TC_SHOP_03", "subsys": "Frontend", "group": "Quy tắc nghiệp vụ",
                "feature": "Chặn thêm vào giỏ khi biến thể hết hàng (Stock = 0)", "rule": "SHOP-05",
                "pre": "Sản phẩm có biến thể Size M - Màu Trắng có tồn kho = 0",
                "steps": "1. Mở trang chi tiết sản phẩm\n2. Chọn Màu Trắng, Size M\n3. Quan sát trạng thái nút 'Thêm vào giỏ'",
                "data": "SKU biến thể tồn kho = 0",
                "expected": "Nút 'Thêm vào giỏ' chuyển sang trạng thái disabled, nhãn hiển thị 'Tạm hết hàng' hoặc 'Hết hàng'.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Hân", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.4",
        "sheet": "3.1.4_DatHang_ThanhToan",
        "name": "Đặt hàng & Thanh toán (User)",
        "owner": "Quỳnh",
        "side": "User",
        "scope": "3.1.4.1 Mô tả (Guest checkout + Member checkout) · 3.1.4.3 Quy tắc PAY-01…PAY-15 · 3.1.4.4 Ngoại lệ: 8 tình huống",
        "screens": "User: /cart, /checkout/shipping, /checkout/payment, /checkout/otp, /checkout/confirm, nút Mua ngay tại /products/:id, /account/vouchers",
        "accounts": "Member: shopper.checkout@velura.test (Velura@2026). Guest: Trình duyệt ẩn danh. Thẻ Stripe Test: 4242 4242 4242 4242 (12/28, 123). Thẻ lỗi: 4000 0000 0000 0002",
        "focus": "• Cả 2 luồng: Từ Giỏ hàng và luồng 'Mua ngay' (không làm mất giỏ hàng cũ).\n• Tự động chọn Voucher giảm sâu nhất thỏa mãn điều kiện đơn (PAY-05).\n• Tiến trình ưu đãi khuyến mãi: 'Mua thêm x đ để nhận ưu đãi y%'.\n• Thanh toán đa phương thức: COD, Thẻ tín dụng quốc tế (Stripe), VNPay/VietQR, MoMo.\n• Xử lý hết hàng ngay lúc bấm thanh toán, voucher hết lượt, OTP Guest hết hạn.",
        "notes": "Đặt tên người nhận có tiền tố 'UAT-Quynh' để dễ truy vết đơn hàng. Chú ý số tiền tổng thanh toán = Tiền hàng - Giảm giá + Phí ship.",
        "sample_cases": [
            {
                "id": "TC_PAY_01", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Đặt hàng thanh toán COD cho khách vãng lai (Guest)", "rule": "PAY-01, PAY-02",
                "pre": "Trình duyệt ẩn danh, giỏ hàng có 1 sản phẩm còn hàng",
                "steps": "1. Nhấn 'Tiến hành thanh toán'\n2. Nhập SĐT, xác thực OTP thành công\n3. Nhập Họ tên, Địa chỉ nhận hàng\n4. Chọn phương thức COD và nhấn 'Đặt hàng'",
                "data": "SĐT: 0918111222, Người nhận: UAT-Quynh Test COD, Địa chỉ: 123 Lê Lợi, Q1, TP.HCM",
                "expected": "Đơn hàng tạo thành công, chuyển sang màn hình Xác nhận đặt hàng với mã đơn. Trạng thái đơn: PENDING (hoặc WAITING_CONFIRMATION).",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Quỳnh", "date": "", "note": ""
            },
            {
                "id": "TC_PAY_02", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Thanh toán trực tuyến bằng Thẻ qua Stripe thành công", "rule": "PAY-03, PAY-04",
                "pre": "Đăng nhập Member shopper.checkout@velura.test",
                "steps": "1. Tiến hành Checkout từ giỏ hàng\n2. Chọn thanh toán 'Thẻ tín dụng / Ghi nợ (Stripe)'\n3. Nhập thông tin thẻ test Stripe\n4. Nhấn 'Thanh toán'",
                "data": "Thẻ: 4242 4242 4242 4242, Exp: 12/28, CVC: 123",
                "expected": "Giao dịch thành công, trừ tiền thẻ test, đơn hàng chuyển trạng thái PROCESSING / PAID, hiển thị thông báo thành công.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Quỳnh", "date": "", "note": ""
            },
            {
                "id": "TC_PAY_03", "subsys": "Fullstack", "group": "Quy tắc nghiệp vụ",
                "feature": "Tự động áp dụng Voucher có giá trị giảm cao nhất", "rule": "PAY-05",
                "pre": "Tài khoản có 2 voucher: GIAM10% (tối đa 50k) và GIAM50K cho đơn từ 400k",
                "steps": "1. Mua đơn hàng có giá trị 600.000đ\n2. Mở màn hình thanh toán Checkout\n3. Kiểm tra mục Mã giảm giá",
                "data": "Đơn hàng: 600.000đ, Voucher có sẵn trong ví",
                "expected": "Hệ thống tự động chọn áp dụng voucher có số tiền giảm thực tế cao nhất, cập nhật ngay vào bảng tạm tính.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Quỳnh", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.5",
        "sheet": "3.1.5_TheoDoi_HuyDon",
        "name": "Theo dõi đơn hàng & Hủy đơn (User)",
        "owner": "Hân",
        "side": "User",
        "scope": "3.1.5.1 Mô tả (3 BPMN: Theo dõi Member · Theo dõi Guest · Hủy đơn) · 3.1.5.2 Quy tắc TRK-STATUS-01, TRK-AUTH-02…04, TRK-OTP-01…02, TRK-NOTI-01…03, TRK-CSKH-01 · 3.1.5.3 Ngoại lệ: 8 tình huống",
        "screens": "User: /account/orders (Đơn của tôi), /account/orders/:id (Chi tiết đơn, nút Hủy), /guest/orders (Guest tra cứu theo mã hoặc SĐT + OTP)",
        "accounts": "Member: shopper.checkout@velura.test. Guest: Tra cứu bằng mã đơn đã tạo ở luồng 3.1.4.",
        "focus": "• Tra cứu đơn Guest: Bằng Mã đơn hàng HOẶC Số điện thoại + OTP (phiên làm việc 15 phút sau OTP).\n• Chuỗi trạng thái đơn hàng 1 chiều: Pending -> Confirmed -> Processing -> Shipping -> Delivered.\n• Nút 'Hủy đơn hàng': Chỉ xuất hiện ở trạng thái Pending / Confirmed; chuyển sang Processing (Đang chuẩn bị hàng) thì ẩn nút Hủy.\n• Hủy đơn COD khác đơn đã thanh toán online (tạo yêu cầu hoàn tiền tự động).",
        "notes": "Phối hợp với Quỳnh (3.1.11 Admin) để đổi trạng thái đơn sang Processing / Shipping để test điều kiện ẩn nút Hủy.",
        "sample_cases": [
            {
                "id": "TC_TRK_01", "subsys": "Frontend", "group": "Luồng chính (Happy Path)",
                "feature": "Member theo dõi danh sách và chi tiết đơn hàng", "rule": "TRK-STATUS-01",
                "pre": "Tài khoản Member đã có ít nhất 2 đơn hàng ở các trạng thái khác nhau",
                "steps": "1. Đăng nhập tài khoản Member\n2. Vào 'Tài khoản' -> 'Đơn hàng của tôi'\n3. Nhấn vào 1 đơn hàng để xem chi tiết",
                "data": "Tài khoản: shopper.checkout@velura.test",
                "expected": "Hiển thị đầy đủ timeline tiến trình giao hàng, danh sách sản phẩm, địa chỉ, phương thức thanh toán và số tiền.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Hân", "date": "", "note": ""
            },
            {
                "id": "TC_TRK_02", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Khách hủy đơn hàng thành công khi đơn ở trạng thái Chờ xử lý", "rule": "TRK-AUTH-04",
                "pre": "Đơn hàng đang ở trạng thái Chờ xử lý (Pending)",
                "steps": "1. Mở chi tiết đơn hàng\n2. Nhấn nút 'Hủy đơn hàng'\n3. Chọn lý do hủy đơn và xác nhận",
                "data": "Lý do: 'Đổi ý không muốn mua nữa'",
                "expected": "Đơn hàng chuyển ngay sang trạng thái CANCELLED, hoàn trả số lượng tồn kho cho sản phẩm, gửi email/thông báo xác nhận hủy.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Hân", "date": "", "note": ""
            },
            {
                "id": "TC_TRK_03", "subsys": "Frontend", "group": "Quy tắc nghiệp vụ",
                "feature": "Khóa chức năng tự hủy đơn khi đơn đã chuyển sang Đang chuẩn bị hàng", "rule": "TRK-AUTH-04",
                "pre": "Đơn hàng đã được Admin xác nhận và chuyển sang 'Processing'",
                "steps": "1. Mở chi tiết đơn hàng đang ở trạng thái Processing\n2. Quan sát giao diện các nút thao tác",
                "data": "Đơn hàng trạng thái PROCESSING",
                "expected": "Nút 'Hủy đơn hàng' hoàn toàn biến mất hoặc bị vô hiệu hóa; có hướng dẫn khách liên hệ CSKH nếu có nhu cầu thay đổi.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Hân", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.6",
        "sheet": "3.1.6_DoiTra_HoanTien_User",
        "name": "Yêu cầu Đổi trả & Hoàn tiền (User)",
        "owner": "Uyên",
        "side": "User",
        "scope": "3.1.6.1 Mô tả (Đổi/trả hàng, hoàn tiền, đổi size/màu) · 3.1.6.3 Quy tắc RET-01…RET-15 · 3.1.6.4 Ngoại lệ: 9 tình huống",
        "screens": "User: /account/orders/:id (nút 'Yêu cầu Đổi/Trả'), /account/returns (danh sách yêu cầu), /account/returns/:id (chi tiết tiến trình), /guest/returns",
        "accounts": "Member: customer.rma@velura.test (Velura@2026). Cần đơn hàng có trạng thái DELIVERED trong vòng 7 ngày.",
        "focus": "• Điều kiện tạo yêu cầu: Đơn hàng đã 'Giao thành công' trong vòng 7 ngày (RETURN_WINDOW_DAYS = 7).\n• Tối đa 2 lượt đổi trả cho mỗi sản phẩm (RET-02).\n• 2 luồng: Trả hàng - Hoàn tiền (COD cần nhập thông tin tài khoản ngân hàng thụ hưởng Napas B2C) và Đổi hàng (chọn variant mới cùng mẫu).\n• Upload ảnh/video bằng chứng sản phẩm lỗi (tùy chọn theo BA, không bắt buộc cứng chặn).\n• Khách hủy yêu cầu trước khi bàn giao cho bưu tá.",
        "notes": "Uyên phụ trách cả 3.1.6 (User) và 3.1.12 (Admin RMA) -> hãy test luồng liên thông đầu-cuối giữa Khách và CSKH.",
        "sample_cases": [
            {
                "id": "TC_RET_01", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Tạo yêu cầu Trả hàng - Hoàn tiền cho đơn COD", "rule": "RET-01..05",
                "pre": "Đơn hàng DELIVERED trong vòng 7 ngày",
                "steps": "1. Mở chi tiết đơn hàng -> Nhấn 'Yêu cầu Đổi/Trả'\n2. Chọn sản phẩm cần trả, chọn lý do 'Hàng lỗi đường may'\n3. Chọn hình thức 'Trả hàng & Hoàn tiền'\n4. Nhập thông tin tài khoản ngân hàng thụ hưởng (Ngân hàng, Số TK, Tên chủ TK)\n5. Gửi yêu cầu",
                "data": "Vietcombank, STK: 0123456789, Chủ TK: NGUYEN VAN A",
                "expected": "Yêu cầu đổi trả được tạo ở trạng thái REQUESTED. Hiển thị mã phiếu RMA, có thông báo CSKH sẽ liên hệ trong 24h.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Uyên", "date": "", "note": ""
            },
            {
                "id": "TC_RET_02", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Tạo yêu cầu Đổi size sản phẩm", "rule": "RET-06..10",
                "pre": "Đơn hàng DELIVERED, sản phẩm còn các variant size khác trong kho",
                "steps": "1. Chọn 'Yêu cầu Đổi/Trả' -> Chọn lý do 'Không vừa size'\n2. Chọn hình thức 'Đổi sản phẩm'\n3. Chọn Size mới muốn đổi (Ví dụ từ M sang L)\n4. Gửi yêu cầu",
                "data": "Size cũ: M -> Size mới: L",
                "expected": "Hệ thống kiểm tra tồn kho Size L còn hàng, ghi nhận yêu cầu đổi hàng ở trạng thái REQUESTED.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Uyên", "date": "", "note": ""
            },
            {
                "id": "TC_RET_03", "subsys": "Frontend", "group": "Quy tắc nghiệp vụ",
                "feature": "Chặn tạo yêu cầu đổi trả khi quá hạn 7 ngày", "rule": "RET-01",
                "pre": "Đơn hàng đã hoàn thành giao hàng cách đây hơn 7 ngày",
                "steps": "1. Mở chi tiết đơn hàng đã giao quá 7 ngày\n2. Quan sát giao diện nút 'Yêu cầu Đổi/Trả'",
                "data": "Đơn hoàn tất cách đây 10 ngày",
                "expected": "Nút 'Yêu cầu Đổi/Trả' bị ẩn hoặc disabled kèm chú thích 'Đã quá thời hạn đổi trả 7 ngày theo chính sách'.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Uyên", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.7",
        "sheet": "3.1.7_Chatbot_AI_Stylist",
        "name": "Tư vấn Chatbot AI Stylist (User)",
        "owner": "Ninh",
        "side": "User",
        "scope": "3.1.7.1 Mô tả · 3.1.7.2 Phản ứng 4 cấp độ L0-L3 và trạng thái rủi ro (Xanh/Vàng/Cam/Đỏ) · 3.1.7.3 Quy tắc CHAT-01…CHAT-30 · 3.1.7.4 Ngoại lệ: 24 tình huống",
        "screens": "User: Widget Chatbot nổi ở góc phải màn hình, trang /chatbot",
        "accounts": "Member: chau.le@gmail.test (Velura@2026). Guest: Cửa sổ ẩn danh.",
        "focus": "• Cấp độ phản ứng L0-L3: L0 (AI tự động tư vấn thời trang), L1 (Tra cứu đơn hàng - Guest cần xác thực OTP), L2 (Cảnh báo tiêu cực/rủi ro), L3 (Chuyển giao cho nhân viên CSKH).\n• Chức năng gợi ý outfit theo vóc dáng, màu sắc cá nhân và sự kiện (đi tiệc, đi làm, dạo phố).\n• Chặn ngôn từ quấy rối/độc hại, che thông tin nhạy cảm (SĐT, số thẻ, địa chỉ cá nhân).\n• Nút 'Gặp nhân viên hỗ trợ' khi AI không giải quyết được vấn đề.",
        "notes": "Kiểm tra tốc độ phản hồi streaming text của Chatbot và card sản phẩm đính kèm tin nhắn.",
        "sample_cases": [
            {
                "id": "TC_CHAT_01", "subsys": "Frontend", "group": "Luồng chính (Happy Path)",
                "feature": "Tư vấn phối đồ theo dịp sự kiện qua Chatbot", "rule": "CHAT-01..05",
                "pre": "Mở widget Chatbot trên giao diện Storefront",
                "steps": "1. Mở khung chat\n2. Gõ câu hỏi: 'Gợi ý cho tôi set đồ đi tiệc cưới ngoài trời mùa thu sang trọng'\n3. Quan sát câu trả lời của AI Stylist",
                "data": "Prompt: Gợi ý set đồ tiệc cưới ngoài trời mùa thu",
                "expected": "Chatbot phản hồi lịch sự, đưa ra gợi ý chi tiết về phom dáng, chất liệu, màu sắc và kèm theo các thẻ sản phẩm cụ thể có thể bấm vào mua ngay.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Ninh", "date": "", "note": ""
            },
            {
                "id": "TC_CHAT_02", "subsys": "Fullstack", "group": "Quy tắc nghiệp vụ",
                "feature": "Yêu cầu gặp nhân viên tư vấn trực tiếp (Chuyển CSKH L3)", "rule": "CHAT-10..15",
                "pre": "Đang trong phiên chat với Chatbot",
                "steps": "1. Gõ tin nhắn: 'Tôi muốn khiếu nại về đơn hàng bị rách, hãy cho tôi gặp nhân viên'\n2. Hoặc nhấn nút 'Gặp nhân viên CSKH'",
                "data": "Nhu cầu: Khiếu nại dịch vụ",
                "expected": "Chatbot tạo Ticket hỗ trợ, thông báo khách chờ kết nối và chuyển phiên chat sang hàng đợi CSKH phía Admin.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Ninh", "date": "", "note": ""
            },
            {
                "id": "TC_CHAT_03", "subsys": "Backend", "group": "Bảo mật & Phân quyền",
                "feature": "Lọc ngôn từ tiêu cực và che thông tin nhạy cảm", "rule": "CHAT-20..25",
                "pre": "Đang trong phiên chat",
                "steps": "1. Gửi tin nhắn chứa số thẻ tín dụng hoặc số điện thoại\n2. Quan sát hiển thị nội dung trên màn hình chat",
                "data": "Tin nhắn chứa SĐT 0912345678 và số thẻ 4242-xxxx",
                "expected": "Hệ thống tự động che/mask các ký tự nhạy cảm (ví dụ 091****678) để bảo vệ dữ liệu người dùng.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Ninh", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.7b",
        "sheet": "3.1.7b_QL_Ticket_CSKH",
        "name": "Quản lý Phiếu hỗ trợ & CSKH (Admin)",
        "owner": "Ninh",
        "side": "Admin",
        "scope": "3.1.7.1 Mô tả luồng CSKH · Tiếp nhận phiên chat L3 · Quản lý danh sách Ticket hỗ trợ · Gán nhân viên xử lý",
        "screens": "Admin: /returns -> Tab 'Chat trực tuyến' và Tab 'Phiếu hỗ trợ' (Service Desk Tickets)",
        "accounts": "CSKH Operator: cskh.rma@velura.vn (Admin@2026). Super Admin: admin.operator@velura.vn",
        "focus": "• Tiếp nhận tin nhắn trực tiếp từ khách hàng chuyển qua từ Chatbot.\n• Quản lý danh sách Ticket: Trạng thái Open, In Progress, Resolved, Closed.\n• Nút 'Nhận xử lý' (Assign to me) cho nhân viên CSKH tiếp quản phiếu.\n• Gửi phản hồi tin nhắn/email cho khách hàng từ giao diện Admin.",
        "notes": "Kiểm tra xem 2 nhân viên CSKH cùng nhận 1 phiếu có bị xung đột không (concurrency control).",
        "sample_cases": [
            {
                "id": "TC_TICK_01", "subsys": "Frontend", "group": "Luồng chính (Happy Path)",
                "feature": "Xem danh sách và lọc Ticket theo trạng thái", "rule": "AD-CSKH-01",
                "pre": "Đăng nhập cskh.rma@velura.vn vào Admin",
                "steps": "1. Vào menu 'Đổi trả & CSKH' -> Chọn tab 'Phiếu hỗ trợ'\n2. Lọc danh sách theo trạng thái 'Chờ xử lý (Open)'",
                "data": "Filter: Status = OPEN",
                "expected": "Hiển thị danh sách các phiếu hỗ trợ đang chờ nhân viên tiếp nhận, sắp xếp theo thời gian mới nhất.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Ninh", "date": "", "note": ""
            },
            {
                "id": "TC_TICK_02", "subsys": "Fullstack", "group": "Quy tắc nghiệp vụ",
                "feature": "Nhân viên CSKH nhận xử lý phiếu hỗ trợ (Assign)", "rule": "AD-CSKH-02",
                "pre": "Có phiếu hỗ trợ chưa gán người phụ trách",
                "steps": "1. Mở chi tiết phiếu hỗ trợ\n2. Nhấn nút 'Nhận xử lý'\n3. Kiểm tra thông tin người xử lý",
                "data": "Ticket ID đang Open",
                "expected": "Phiếu chuyển sang trạng thái IN_PROGRESS, trường 'Người xử lý' cập nhật tên tài khoản cskh.rma@velura.vn.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Ninh", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.8",
        "sheet": "3.1.8_PhongThuDoAo_VTO",
        "name": "Phòng thử đồ ảo 3D / AI Virtual Try-On",
        "owner": "Ninh",
        "side": "User",
        "scope": "3.1.8.1 Mô tả · Bảng quy tắc VTO-01…VTO-24 · 3.1.8.3 Ngoại lệ: 12 tình huống",
        "screens": "User: /products/:id (Hộp thoại Thử đồ ảo 3D Try-On tại trang chi tiết sản phẩm)",
        "accounts": "Member: chau.le@gmail.test hoặc Guest.",
        "focus": "• Sản phẩm được bật hỗ trợ VTO (có nút 'Thử đồ ảo AI 3D').\n• Upload ảnh người mẫu cá nhân hoặc chọn người mẫu mẫu (Studio Model).\n• Quy chuẩn ảnh: Rõ toàn thân/bán thân, định dạng JPG/PNG <= 10MB.\n• Thao tác xoay 3D / tương tác góc nhìn sản phẩm trên người mẫu sau khi AI render hoàn tất.\n• Nút 'So sánh trước/sau' và nút 'Thêm vào giỏ' ngay từ kết quả thử đồ.",
        "notes": "Kiểm tra xem các icon AI/sparkle đã được dọn sạch thay bằng line SVG tinh tế chuẩn thương hiệu Velura chưa.",
        "sample_cases": [
            {
                "id": "TC_VTO_01", "subsys": "Frontend", "group": "Luồng chính (Happy Path)",
                "feature": "Mở phòng thử đồ ảo và chọn người mẫu mẫu Studio", "rule": "VTO-01..05",
                "pre": "Mở trang chi tiết sản phẩm có hỗ trợ tính năng VTO",
                "steps": "1. Nhấn nút 'AI 3D Try-On' trên trang chi tiết sản phẩm\n2. Chọn tab 'Người mẫu Studio'\n3. Chọn 1 người mẫu có vóc dáng phù hợp\n4. Nhấn 'Thử đồ ngay'",
                "data": "Sản phẩm: Đầm dạ hội lụa, Model: Studio Nữ 1m65",
                "expected": "Hộp thoại mở mượt mà, preview rõ nét, AI tiến hành render và hiển thị trang phục khớp với form người mẫu.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Ninh", "date": "", "note": ""
            },
            {
                "id": "TC_VTO_02", "subsys": "Fullstack", "group": "Quy tắc nghiệp vụ",
                "feature": "Tải ảnh cá nhân để thử đồ ảo AI", "rule": "VTO-06..12",
                "pre": "Chuẩn bị ảnh toàn thân đứng thẳng rõ nét",
                "steps": "1. Tại popup VTO, chọn tab 'Ảnh của tôi'\n2. Tải file ảnh cá nhân lên\n3. Xác nhận điều khoản xử lý hình ảnh và nhấn 'Tiến hành thử đồ'",
                "data": "File: my_photo_fullbody.jpg (2.5MB)",
                "expected": "Hệ thống kiểm tra hợp lệ, hiển thị thanh tiến trình render AI, trả về ảnh đã mặc trang phục mới với độ chân thực cao.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Ninh", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.9",
        "sheet": "3.1.9_QL_TaiKhoan_Admin",
        "name": "Quản lý Tài khoản & Phân quyền RBAC (Admin)",
        "owner": "Gia",
        "side": "Admin",
        "scope": "3.1.9.1 Mô tả (BPMN Hình 3.11) · 3.1.9.2 Quy tắc AD-ACCOUNT-01…15 · 3.1.9.3 Ngoại lệ: 3 tình huống",
        "screens": "Admin: /accounts (tab Tất cả, Thành viên, Quản trị viên, Bị khóa, Chờ duyệt), /logs (Nhật ký hệ thống)",
        "accounts": "Super Admin: admin.operator@velura.vn (Admin@2026). Test phân quyền: uat.sanpham@velura.vn, uat.donhang@velura.vn, cskh.rma@velura.vn, admin.marketing@velura.vn, admin.viewer@velura.vn",
        "focus": "• Super Admin có toàn quyền quản trị, các role chuyên môn chỉ thấy menu được phân quyền.\n• Khóa / Mở khóa tài khoản: Bắt buộc nhập lý do (tối thiểu 10 ký tự) (AD-ACCOUNT-05).\n• Đổi vai trò (Role): Super Admin mới có quyền đổi vai trò quản trị; yêu cầu nâng quyền qua quy trình duyệt.\n• Mọi thao tác thay đổi trạng thái tài khoản phải được ghi nhận đầy đủ vào /logs (Audit Trail).",
        "notes": "CHÚ Ý: Không khóa các tài khoản UAT dùng chung. Chỉ test chức năng khóa trên tài khoản tự tạo riêng.",
        "sample_cases": [
            {
                "id": "TC_ACC_01", "subsys": "Frontend", "group": "Bảo mật & Phân quyền",
                "feature": "Kiểm tra phân quyền hiển thị menu Admin theo vai trò (RBAC)", "rule": "AD-ACCOUNT-01",
                "pre": "Đăng nhập bằng tài khoản uat.sanpham@velura.vn",
                "steps": "1. Đăng nhập vào hệ thống Admin\n2. Quan sát thanh menu điều hướng bên trái\n3. Thử gõ trực tiếp URL /orders trên thanh địa chỉ trình duyệt",
                "data": "Role: admin_operator_sanpham",
                "expected": "Menu chỉ hiển thị mục 'Quản lý sản phẩm'. Khi gõ URL /orders, hệ thống chặn truy cập và chuyển hướng về trang 403 Forbidden.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Gia", "date": "", "note": ""
            },
            {
                "id": "TC_ACC_02", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Khóa tài khoản người dùng vi phạm kèm lý do bắt buộc", "rule": "AD-ACCOUNT-05",
                "pre": "Tài khoản test 'uat_lock_target@velura.test' đang Active",
                "steps": "1. Tìm tài khoản trong danh sách /accounts\n2. Nhấn nút 'Khóa tài khoản'\n3. Nhập lý do khóa: 'Tài khoản spam đơn hàng ảo nhiều lần'\n4. Xác nhận khóa",
                "data": "Lý do: 'Tài khoản spam đơn hàng ảo nhiều lần' (>= 10 ký tự)",
                "expected": "Tài khoản chuyển sang trạng thái LOCKED. Người dùng này không thể đăng nhập được nữa. Hệ thống ghi 1 log vào /logs.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Gia", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.10",
        "sheet": "3.1.10_QL_SanPham_TonKho",
        "name": "Quản lý Sản phẩm, Biến thể & Tồn kho (Admin)",
        "owner": "Khải",
        "side": "Admin + User",
        "scope": "3.1.10.1 Mô tả · 3.1.10.2 Quy tắc AD-PRODUCT-01…18 · 3.1.10.3 Ngoại lệ: 6 tình huống",
        "screens": "Admin: /products (tab Danh sách sản phẩm, Nhập CSV, Nhật ký sản phẩm), modal Thêm/Sửa sản phẩm, Điều chỉnh tồn kho, Đổi trạng thái | User: /products, /products/:id",
        "accounts": "QL Sản phẩm: uat.sanpham@velura.vn (Admin@2026). QL Giá/KM: admin.marketing@velura.vn",
        "focus": "• Thêm mới, chỉnh sửa sản phẩm: Ma trận biến thể Màu x Size (SKU duy nhất toàn hệ thống).\n• Điều chỉnh tồn kho: Bắt buộc qua RPC có audit, nhập lý do điều chỉnh >= 10 ký tự (AD-PRODUCT-06).\n• Cập nhật trạng thái: Nháp (Draft) -> Đang bán (On Sale) -> Ẩn (Hidden) -> Ngừng bán (Discontinued).\n• Nhập sản phẩm hàng loạt qua file CSV (kiểm tra validate lỗi trước khi lưu DB).\n• AI Studio: Tự động sinh mô tả sản phẩm SEO, gợi ý từ khóa.",
        "notes": "Sản phẩm test hãy đặt tên có tiền tố 'UAT-Khai' để không ảnh hưởng dữ liệu sản phẩm mẫu.",
        "sample_cases": [
            {
                "id": "TC_PROD_01", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Tạo mới sản phẩm hoàn chỉnh có nhiều biến thể Màu x Size", "rule": "AD-PRODUCT-01..04",
                "pre": "Đăng nhập tài khoản uat.sanpham@velura.vn",
                "steps": "1. Vào /products -> Nhấn 'Thêm sản phẩm mới'\n2. Nhập Tên sản phẩm, Danh mục, Giá bán, Mô tả\n3. Thiết lập thuộc tính: Màu (Đen, Be) x Size (S, M, L) -> Tạo 6 SKU\n4. Nhập tồn kho ban đầu cho từng biến thể\n5. Nhấn 'Lưu & Đăng bán'",
                "data": "Tên: UAT-Khai Đầm Maxi Họa Tiết, 6 biến thể, Giá 850.000đ",
                "expected": "Sản phẩm lưu thành công, sinh đúng 6 mã SKU, xuất hiện trên danh sách Admin và hiển thị chính xác ngoài Storefront.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Khải", "date": "", "note": ""
            },
            {
                "id": "TC_PROD_02", "subsys": "Fullstack", "group": "Quy tắc nghiệp vụ",
                "feature": "Điều chỉnh tồn kho biến thể bắt buộc có lý do", "rule": "AD-PRODUCT-06",
                "pre": "Sản phẩm biến thể đang có tồn kho = 10",
                "steps": "1. Nhấn nút 'Điều chỉnh kho' tại biến thể\\n2. Thay đổi số lượng thành 25\\n3. Nhập lý do: 'Nhập bổ sung từ xưởng may đợt 2'\\n4. Nhấn 'Xác nhận'",
                "data": "Delta: +15, Lý do: 'Nhập bổ sung từ xưởng may đợt 2'",
                "expected": "Tồn kho cập nhật lên 25, hệ thống ghi bản ghi audit vào Nhật ký kho với đúng người thực hiện và lý do.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Khải", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.11",
        "sheet": "3.1.11_QL_DonHang_VanDon",
        "name": "Quản lý Đơn hàng & Vận đơn (Admin)",
        "owner": "Quỳnh",
        "side": "Admin",
        "scope": "3.1.11.1 Mô tả (BPMN Quản lý đơn hàng) · 3.1.11.2 Quy tắc AD-ORDER-01…22 · 3.1.11.3 Ngoại lệ: 8 tình huống",
        "screens": "Admin: /orders (Danh sách đơn hàng, bộ lọc, xem chi tiết đơn, chuyển trạng thái đơn, in vận đơn) | User đối chiếu: /account/orders",
        "accounts": "QL Đơn hàng: uat.donhang@velura.vn (Admin@2026). Super Admin: admin.operator@velura.vn",
        "focus": "• Chuỗi trạng thái đơn hàng nghiêm ngặt: PENDING -> CONFIRMED -> PROCESSING -> SHIPPING -> DELIVERED (hoặc CANCELLED).\n• COD Guard (AD-ORDER-03/04): Đơn COD >= 1.000.000đ của Guest bắt buộc phải có bước 'Xác nhận cuộc gọi' trước khi duyệt đơn.\n• Tự động trừ tồn kho khi đơn được duyệt; hoàn tồn kho khi hủy đơn.\n• Thao tác Bàn giao vận chuyển: Bắt buộc chọn Đơn vị vận chuyển (GHTK, GHN, Viettel Post) và sinh Mã vận đơn.",
        "notes": "Phối hợp với Gia, Uyên để chuyển trạng thái các đơn hàng test của các bạn theo yêu cầu.",
        "sample_cases": [
            {
                "id": "TC_ORD_01", "subsys": "Fullstack", "group": "Quy tắc nghiệp vụ",
                "feature": "Guard xác nhận cuộc gọi cho đơn COD Guest từ 1.000.000đ", "rule": "AD-ORDER-03, 04",
                "pre": "Đơn hàng COD của khách Guest có giá trị 1.200.000đ ở trạng thái Pending",
                "steps": "1. Mở chi tiết đơn hàng trong Admin /orders\n2. Nhấn nút 'Xác nhận đơn hàng' khi chưa ghi nhận cuộc gọi\n3. Quan sát thông báo\n4. Nhấn 'Ghi nhận cuộc gọi thành công', sau đó nhấn 'Xác nhận đơn'",
                "data": "Đơn Guest COD 1.2M",
                "expected": "Bước 2 bị chặn với thông báo yêu cầu xác nhận cuộc gọi. Sau bước 4, đơn được duyệt thành công sang CONFIRMED.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Quỳnh", "date": "", "note": ""
            },
            {
                "id": "TC_ORD_02", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Chuyển đơn hàng sang Đang giao và gán mã vận đơn ĐVVC", "rule": "AD-ORDER-06..10",
                "pre": "Đơn hàng ở trạng thái Đang chuẩn bị hàng (Processing)",
                "steps": "1. Mở chi tiết đơn hàng\n2. Nhấn 'Bàn giao vận chuyển'\n3. Chọn ĐVVC: 'Giao Hàng Tiết Kiệm (GHTK)', nhập Mã vận đơn: 'GHTK12345678'\n4. Xác nhận bàn giao",
                "data": "ĐVVC: GHTK, Mã vận đơn: GHTK12345678",
                "expected": "Đơn chuyển sang trạng thái SHIPPING. Khách hàng ngoài Storefront nhận được thông báo đơn đang được giao kèm mã tra cứu vận đơn.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Quỳnh", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.12",
        "sheet": "3.1.12_QL_DoiTra_CSKH_Admin",
        "name": "Quản lý Đổi trả, CSKH & Đối soát hoàn tiền (Admin)",
        "owner": "Uyên",
        "side": "Admin",
        "scope": "3.1.12.1 Mô tả (Quản lý đổi trả & CSKH) · 3.1.12.2 Quy tắc 28 mã: AD-REQ 01-05, AD-CSKH 01-03, AD-RECEIVE 01-03, AD-REFUND 01-05, AD-EXCHANGE 01-04, AD-STATUS 01-03, AD-AUDIT 01-03 · 3.1.12.3 Ngoại lệ: 7 tình huống",
        "screens": "Admin: /returns (tab Yêu cầu đổi trả, Chi tiết yêu cầu, Đối soát hoàn tiền COD Napas B2C, Nhật ký xử lý)",
        "accounts": "CSKH RMA: cskh.rma@velura.vn (Admin@2026). Super Admin: admin.operator@velura.vn",
        "focus": "• Nối đầu-cuối với 3.1.6 User: CSKH liên hệ khách trong vòng 24h -> Duyệt/Từ chối từng sản phẩm.\n• Kho nhận hàng: Chỉ xác nhận số lượng nhận thực tế (đúng / thiếu / không khớp), không chặn cứng checklist hình ảnh.\n• Nhận hàng một phần (Partial Receive): Phần đã nhận tiếp tục hoàn tiền, phần thiếu tách bản ghi riêng xử lý tiếp.\n• Đối soát hoàn tiền COD (Napas B2C payout): Dropdown chọn ngân hàng Việt Nam, nút 'Tự động tạo lệnh chi & Đối soát 1-click', sinh mã giao dịch và file biên nhận ủy nhiệm chi điện tử.\n• SLA hoàn tiền 4-5 ngày làm việc, hiển thị huy hiệu hạn/quá hạn.",
        "notes": "Kiểm tra kỹ tab Đối soát hoàn tiền COD xem danh sách ngân hàng Việt Nam đã chuẩn hóa dạng dropdown chưa.",
        "sample_cases": [
            {
                "id": "TC_RMA_01", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Duyệt yêu cầu đổi trả và phát hành hướng dẫn gửi hàng", "rule": "AD-REQ-01..05",
                "pre": "Có yêu cầu đổi trả ở trạng thái REQUESTED từ tab 3.1.6",
                "steps": "1. Mở danh sách /returns -> Chọn phiếu yêu cầu\n2. Ghi nhận cuộc gọi tư vấn với khách\n3. Nhấn 'Duyệt yêu cầu'",
                "data": "Phiếu RMA hợp lệ",
                "expected": "Phiếu chuyển sang WAITING_RETURN. Hệ thống gửi email hướng dẫn đóng gói và địa chỉ gửi hàng cho khách hàng.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Uyên", "date": "", "note": ""
            },
            {
                "id": "TC_RMA_02", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Thực hiện đối soát hoàn tiền COD tự động (Napas B2C payout)", "rule": "AD-REFUND-01..05",
                "pre": "Phiếu đổi trả COD đã nhận hàng thành công tại kho",
                "steps": "1. Mở chi tiết phiếu cần hoàn tiền\n2. Kiểm tra thông tin tài khoản ngân hàng thụ hưởng\n3. Nhấn nút 'Tự động chi & Đối soát ngân hàng (1-click)'\n4. Quan sát mã giao dịch và file chứng từ biên nhận",
                "data": "Ngân hàng: Vietcombank, STK: 0123456789",
                "expected": "Lệnh hoàn tiền được xác nhận, sinh mã đối soát Napas PAY-COD-xxxx, tự động tạo file biên nhận điện tử và gửi thông báo hoàn tất cho khách.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Uyên", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.13",
        "sheet": "3.1.13_Dashboard_Insights",
        "name": "Dashboard Insights & Phân tích Vận hành OLAP (Admin)",
        "owner": "Khải",
        "side": "Admin",
        "scope": "3.1.13.1 Mô tả (Phân quyền tác nhân & Luồng công việc) · 3.1.13.2 Quy tắc AD-DB-01…09 (Doanh thu, Điểm nghẽn đơn SLA, Sản phẩm than phiền, Tỷ lệ đổi trả, Giữ chân khách hàng) · 3.1.13.3 Ngoại lệ & cảnh báo: 8 tình huống",
        "screens": "Admin: /dashboard (Tổng quan kinh doanh, Cảnh báo vận hành, Tab Insight quản trị 9 thẻ AD_DB_01..09)",
        "accounts": "Super Admin: admin.operator@velura.vn. Admin Viewer: admin.viewer@velura.vn (Chỉ xem)",
        "focus": "• 9 thẻ Insight quản trị (AD_DB_01..09): Hiển thị đầy đủ 4 phần (Hiện tượng, Phạm vi, Mức độ tác động, Hệ quả) kèm nút điều hướng đến màn hình đích.\n• Thẻ thiếu dữ liệu bị làm mờ và ghi rõ lý do, không hiển thị số 0 giả tạo.\n• Nút 'Làm mới' gọi POST /admin/dashboard/refresh, khóa nút 10 giây chống spam (429 Too Many Requests).\n• Admin Viewer: Chỉ xem số liệu, không có quyền thao tác update/thay đổi dữ liệu.",
        "notes": "Kiểm tra tính nhất quán giữa số liệu KPI trên Dashboard và số liệu thực tế ở các trang Đơn hàng, Đổi trả, Sản phẩm.",
        "sample_cases": [
            {
                "id": "TC_DB_01", "subsys": "Frontend", "group": "Luồng chính (Happy Path)",
                "feature": "Xem 9 thẻ Insight quản trị và điều hướng đến màn hình đích", "rule": "AD-DB-01..09",
                "pre": "Đăng nhập Super Admin vào /dashboard",
                "steps": "1. Mở trang /dashboard -> Chọn tab 'Insight quản trị'\n2. Kiểm tra cấu trúc 9 thẻ phân tích (AD_DB_01 đến 09)\n3. Nhấn nút 'Xử lý ngay' trên thẻ 'Điểm nghẽn đơn hàng'",
                "data": "9 thẻ Insight quản trị",
                "expected": "Hiển thị đầy đủ 9 thẻ với nội dung phân tích rõ ràng. Nút điều hướng dẫn chính xác về trang /orders với bộ lọc đơn cần xử lý.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Khải", "date": "", "note": ""
            },
            {
                "id": "TC_DB_02", "subsys": "Fullstack", "group": "Bảo mật & Phân quyền",
                "feature": "Kiểm tra quyền hạn của vai trò Admin Viewer trên Dashboard", "rule": "AD-DB-TH4",
                "pre": "Đăng nhập bằng tài khoản admin.viewer@velura.vn",
                "steps": "1. Mở /dashboard\n2. Quan sát hiển thị số liệu doanh thu và KPI\n3. Thử thực hiện các thao tác sửa đổi hoặc gọi API POST /admin/dashboard/refresh",
                "data": "Tài khoản: admin.viewer@velura.vn",
                "expected": "Admin Viewer xem được các chỉ số tổng quan nhưng tất cả các nút sửa đổi/thao tác ghi dữ liệu đều bị ẩn hoặc trả lỗi 403 Forbidden.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Khải", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.14",
        "sheet": "3.1.14_QL_KhuyenMai_Voucher",
        "name": "Quản lý Khuyến mãi, Voucher & Ngân sách (Admin + User)",
        "owner": "Khải",
        "side": "Admin + User",
        "scope": "3.1.14.1 Mô tả (5 BPMN Hình 3.17-3.21: Thiết lập chiến dịch · Phát hành mã · Ví voucher & chọn mã · Chốt tiền khi đặt đơn · Giám sát ngân sách) · Quy tắc 20 mã: AD-PROMO 01-07, AD-VOUCHER 01-06, AD-ORDER 01-04, AD-STATS 01-02 · Ngoại lệ: 7 tình huống",
        "screens": "Admin: /promotions (tab Chiến dịch, Mã giảm giá, Nhật ký, Thống kê), Modal Thêm chiến dịch / Sinh mã hàng loạt | User: /offers, /account/vouchers, /checkout",
        "accounts": "Admin Giá/KM: admin.marketing@velura.vn (Admin@2026). Member: member.promo@velura.test",
        "focus": "• Chuỗi: Tạo chiến dịch -> Kích hoạt -> Sinh mã voucher hàng loạt -> Hiển thị ở /offers & ví khách -> Áp mã tại Checkout -> Tự động trừ ngân sách.\n• Giám sát ngân sách: Khi ngân sách cạn (Budget Exhausted), hệ thống tự động tạm dừng chiến dịch và khóa mã, không cho áp dụng tiếp (AD-PROMO-03).\n• Xuất danh sách mã ra file CSV có format an toàn, chống chèn mã độc (CSV Injection).\n• Client gửi kèm quoted_voucher_id tại Checkout để tránh thay đổi giá bất ngờ.",
        "notes": "Tạo chiến dịch và mã voucher test có tiền tố 'UAT-Khai' (Ví dụ: UAT-KHAI-SUMMER).",
        "sample_cases": [
            {
                "id": "TC_PROMO_01", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Tạo chiến dịch và sinh mã voucher hàng loạt thành công", "rule": "AD-PROMO-01, AD-VOUCHER-01",
                "pre": "Đăng nhập admin.marketing@velura.vn",
                "steps": "1. Vào /promotions -> 'Tạo chiến dịch mới' với ngân sách 5.000.000đ\n2. Nhấn 'Sinh mã voucher'\n3. Chọn số lượng sinh 50 mã, giảm 20% tối đa 100.000đ cho đơn từ 300.000đ\n4. Kích hoạt chiến dịch",
                "data": "Ngân sách: 5M, 50 mã, Giảm 20% max 100k đơn từ 300k",
                "expected": "Chiến dịch và 50 mã voucher được tạo thành công, mã ở trạng thái ACTIVE, có thể copy mã hoặc tải file CSV về.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Khải", "date": "", "note": ""
            },
            {
                "id": "TC_PROMO_02", "subsys": "Fullstack", "group": "Quy tắc nghiệp vụ",
                "feature": "Tự động khóa áp mã khi chiến dịch hết ngân sách", "rule": "AD-PROMO-03, 04",
                "pre": "Chiến dịch có ngân sách còn lại chỉ đủ cho 1 đơn hàng",
                "steps": "1. Khách hàng 1 đặt đơn và áp mã thành công, trừ hết phần ngân sách còn lại\n2. Khách hàng 2 thử nhập mã đó tại Checkout\n3. Quan sát thông báo",
                "data": "Voucher của chiến dịch vừa cạn ngân sách",
                "expected": "Hệ thống từ chối áp dụng voucher cho khách hàng 2 với thông báo 'Chương trình khuyến mãi đã hết ngân sách hoặc lượt sử dụng'.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Khải", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.15",
        "sheet": "3.1.15_ThanhVien_Loyalty",
        "name": "Quản lý Thành viên, Ví Loyalty & Giới thiệu Referral (Admin + User)",
        "owner": "Khải",
        "side": "Admin + User",
        "scope": "3.1.15.1 Mô tả (Quy trình tích điểm · Quy trình giới thiệu bạn bè) · 3.1.15.2 Quy tắc AD-MBR-01…09, AD-REF-01…05 · 3.1.15.3 Ngoại lệ: 7 tình huống",
        "screens": "Admin: /members (Danh sách thành viên, cấp độ thẻ, lịch sử điểm, khóa/mở khóa tích điểm) | User: /account/loyalty, /account/profile (Mã giới thiệu Referral)",
        "accounts": "Super Admin: admin.operator@velura.vn. Member: shopper.uat@velura.test",
        "focus": "• Tích điểm thành viên: 1 điểm = 1.000đ chi tiêu. Đơn hàng hoàn tất Giao thành công (DELIVERED) mới kích hoạt cộng điểm vào ví (AD-MBR-01).\n• Hoàn trả / Hủy đơn: Tự động thu hồi số điểm đã tích tương ứng (AD-MBR-04).\n• Giới thiệu bạn bè (Referral): Chia sẻ mã giới thiệu, người được giới thiệu tạo tài khoản thành công -> cấp voucher cho cả 2 người theo chính sách (AD-REF-01..05).\n• Admin có quyền điều chỉnh điểm kèm lý do bắt buộc và nhật ký đối soát.",
        "notes": "Kiểm tra số dư điểm Point cập nhật tức thời khi đơn hàng chuyển sang Delivered.",
        "sample_cases": [
            {
                "id": "TC_MBR_01", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Tích điểm tự động vào ví khi đơn hàng giao thành công", "rule": "AD-MBR-01, 02",
                "pre": "Member có đơn hàng giá trị 1.000.000đ vừa chuyển sang DELIVERED",
                "steps": "1. Đơn hàng chuyển sang trạng thái DELIVERED\n2. Mở /account/loyalty kiểm tra số dư điểm\n3. Kiểm tra lịch sử giao dịch điểm",
                "data": "Đơn 1.000.000đ -> Tích 1.000 Point (tỷ lệ 1:1000)",
                "expected": "Ví điểm cộng thêm 1.000 Point, hiển thị dòng lịch sử 'Tích điểm từ đơn hàng #xxxx', hạng thành viên cập nhật tiến trình.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Khải", "date": "", "note": ""
            },
            {
                "id": "TC_MBR_02", "subsys": "Fullstack", "group": "Quy tắc nghiệp vụ",
                "feature": "Giới thiệu bạn bè nhận Voucher thưởng thành công", "rule": "AD-REF-01..05",
                "pre": "Member A có mã giới thiệu 'REF-HAN-2026'",
                "steps": "1. Người dùng B mở trang đăng ký, nhập mã giới thiệu 'REF-HAN-2026'\n2. Hoàn tất đăng ký và kích hoạt tài khoản Member B\n3. Kiểm tra ví voucher của cả 2 tài khoản A và B",
                "data": "Referral Code: REF-HAN-2026",
                "expected": "Tài khoản B nhận voucher giảm giá chào mừng; Tài khoản A nhận voucher thưởng giới thiệu sau khi tài khoản B hoàn tất đơn hàng đầu tiên.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Khải", "date": "", "note": ""
            }
        ]
    },
    {
        "code": "3.1.16",
        "sheet": "3.1.16_QL_DanhGia_Reviews",
        "name": "Quản lý Đánh giá sản phẩm & Reviews (Admin + User)",
        "owner": "Hân",
        "side": "Admin + User",
        "scope": "Đánh giá đơn hàng đã mua (1-5 sao, hình ảnh/video, nhận xét) · Quản trị duyệt đánh giá Admin · Lọc từ ngữ tiêu cực/spam · Gợi ý đánh giá bằng AI",
        "screens": "Admin: /reviews (Danh sách đánh giá, Duyệt, Ẩn, Phản hồi khách hàng) | User: /account/reviews, /account/orders/:id, /products/:id (Khối đánh giá khách hàng)",
        "accounts": "QL Đánh giá: admin.reviews@velura.vn (Admin@2026). Member: customer.rma@velura.test",
        "focus": "• Chỉ khách hàng đã mua và nhận hàng thành công (DELIVERED) mới được quyền đánh giá sản phẩm đó.\n• Đánh giá gồm: Số sao (1-5), nội dung nhận xét, ảnh/video thực tế trên tay.\n• AI Moderation: Tự động phát hiện và gắn cờ cảnh báo các đánh giá chứa từ ngữ thô tục, quấy rối hoặc spam quảng cáo.\n• Admin có thể duyệt hiển thị công khai, ẩn đánh giá vi phạm, hoặc gửi phản hồi chính thức từ nhãn hàng.",
        "notes": "Kiểm tra xem sau khi Admin duyệt, đánh giá có lập tức xuất hiện ở trang chi tiết sản phẩm ngoài Storefront không.",
        "sample_cases": [
            {
                "id": "TC_REV_01", "subsys": "Fullstack", "group": "Luồng chính (Happy Path)",
                "feature": "Khách hàng viết đánh giá sản phẩm kèm hình ảnh thực tế", "rule": "REV-USER-01",
                "pre": "Member đã nhận hàng thành công cho sản phẩm Đầm dạ hội",
                "steps": "1. Vào 'Đơn hàng của tôi' -> Nhấn 'Đánh giá sản phẩm'\n2. Chọn 5 sao, viết nhận xét: 'Chất vải lụa cực kỳ mịn, phom váy rất đẹp chuẩn size'\n3. Tải lên 1 ảnh thực tế và gửi đánh giá",
                "data": "5 sao, Kèm ảnh chụp thực tế",
                "expected": "Đánh giá gửi thành công, chuyển sang trạng thái PENDING chờ kiểm duyệt, điểm thưởng đánh giá (nếu có) được ghi nhận tạm thời.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Hân", "date": "", "note": ""
            },
            {
                "id": "TC_REV_02", "subsys": "Frontend", "group": "Luồng chính (Happy Path)",
                "feature": "Admin kiểm duyệt và phê duyệt hiển thị đánh giá", "rule": "REV-ADMIN-01",
                "pre": "Đăng nhập tài khoản admin.reviews@velura.vn",
                "steps": "1. Mở trang Admin /reviews\n2. Xem đánh giá đang ở trạng thái 'Chờ duyệt'\n3. Nhấn 'Duyệt hiển thị'\n4. Mở trang sản phẩm ngoài Storefront kiểm tra",
                "data": "Review ID đang Pending",
                "expected": "Đánh giá chuyển trạng thái APPROVED trong Admin và lập tức hiển thị công khai trên khối đánh giá của trang chi tiết sản phẩm ngoài Storefront.",
                "actual": "", "status": "Chưa test (Untested)", "sev": "", "issue": "", "tester": "Hân", "date": "", "note": ""
            }
        ]
    }
]

# ----------------------------------------------------------------------------------------
# Build Sheet 00: Overview & Assignment (PCCV)
# ----------------------------------------------------------------------------------------
def build_overview_sheet(wb):
    ws = wb.create_sheet(title="00_Tong_Quan_PCCV", index=0)
    ws.views.sheetView[0].showGridLines = True
    
    # Banner
    ws.merge_cells("A1:N2")
    c = ws["A1"]
    c.value = "  VELURA E-COMMERCE - BẢNG ĐIỀU PHỐI VÀ THEO DÕI TIẾN ĐỘ UAT TOÀN DIỆN (USER & ADMIN)\n   Hạn chót hoàn thành UAT: 23:59 05/11/2026  ·  Repository: https://github.com/Royal2005-coder/Velura-Angular"
    c.font = font_title
    c.fill = fill_maroon
    c.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
    ws.row_dimensions[1].height = 26
    ws.row_dimensions[2].height = 22

    # Project Links & Instructions
    ws.row_dimensions[4].height = 20
    ws.cell(row=4, column=1, value="Mục tiêu UAT:").font = font_bold_maroon
    ws.merge_cells("B4:N4")
    ws.cell(row=4, column=2, value="Kiểm thử nghiệm thu toàn diện (End-to-End) cả Giao diện Frontend và Nghiệp vụ Backend của toàn bộ phân hệ Khách hàng (User Storefront) và Quản trị doanh nghiệp (Admin ERP).").font = font_normal

    ws.row_dimensions[5].height = 20
    ws.cell(row=5, column=1, value="Quy chuẩn phân công:").font = font_bold_maroon
    ws.merge_cells("B5:N5")
    ws.cell(row=5, column=2, value="6 thành viên tham gia UAT. Trong đó: Khải, Hân, Ninh phụ trách số lượng tab GẤP ĐÔI (4 tab/người) so với Gia, Quỳnh, Uyên (2 tab/người vì phụ trách Core Fullstack/Backend dev).").font = font_normal

    ws.row_dimensions[6].height = 20
    ws.cell(row=6, column=1, value="Báo cáo Issue Bug:").font = font_bold_maroon
    ws.merge_cells("B6:N6")
    ws.cell(row=6, column=2, value="Mọi lỗi phát hiện (Frontend / Backend / Sai lệch tài liệu BA) bắt buộc phải tạo Issue trên GitHub https://github.com/Royal2005-coder/Velura-Angular/issues theo đúng mẫu tại Sheet 02.").font = font_normal

    # Table 1: Assignment by Member (PCCV Matrix)
    r = 8
    ws.merge_cells(f"A{r}:N{r}")
    sec1 = ws.cell(row=r, column=1, value="1. MA TRẬN PHÂN CÔNG CÔNG VIỆC UAT 6 THÀNH VIÊN (TỶ LỆ 2:1)")
    sec1.font = font_sec_header
    sec1.fill = fill_maroon_dark
    sec1.alignment = align_left
    ws.row_dimensions[r].height = 24
    
    r += 1
    m_headers = [("STT", 6), ("Thành viên", 14), ("Vai trò trong nhóm UAT", 26), ("Số tab phụ trách", 16), ("Tỷ lệ phân công", 16), ("Ghi chú phạm vi phụ trách", 45)]
    ws.row_dimensions[r].height = 24
    for c_idx, (h_text, h_w) in enumerate(m_headers, 1):
        cell = ws.cell(row=r, column=c_idx, value=h_text)
        cell.font = font_tbl_header
        cell.fill = fill_gray_header
        cell.border = border_header
        cell.alignment = align_center

    r_start_mem = r + 1
    for idx, mem in enumerate(MEMBERS, 1):
        r += 1
        ws.row_dimensions[r].height = 22
        fill_row = fill_white if idx % 2 != 0 else fill_zebra
        ws.cell(row=r, column=1, value=idx).alignment = align_center
        ws.cell(row=r, column=2, value=mem["name"]).alignment = align_center
        ws.cell(row=r, column=2).font = font_bold
        ws.cell(row=r, column=3, value=mem["role"]).alignment = align_left
        ws.cell(row=r, column=4, value=mem["tabs_count"]).alignment = align_center
        ws.cell(row=r, column=4).font = font_bold_maroon
        ws.cell(row=r, column=5, value=mem["ratio"]).alignment = align_center
        ws.cell(row=r, column=6, value=mem["note"]).alignment = align_left
        for col_i in range(1, 7):
            cell = ws.cell(row=r, column=col_i)
            cell.fill = fill_row
            cell.border = border_cell
            if col_i not in (2, 4): cell.font = font_normal

    # Table 2: Functional Tabs Rollup Matrix (Live Formulas)
    r += 3
    ws.merge_cells(f"A{r}:N{r}")
    sec2 = ws.cell(row=r, column=1, value="2. THEO DÕI TIẾN ĐỘ UAT TỪNG TAB QUY TRÌNH (SỐ LIỆU TỰ ĐỘNG TÍNH BẰNG CÔNG THỨC EXCEL TỪ CÁC SHEET CON)")
    sec2.font = font_sec_header
    sec2.fill = fill_maroon_dark
    sec2.alignment = align_left

    r += 1
    t_headers = [
        ("STT", 6), ("Mã", 8), ("Tên quy trình / Chức năng", 32), ("Phân hệ", 14),
        ("Người phụ trách", 14), ("Tên Sheet UAT", 25), ("Tổng TC", 10),
        ("Đạt (Pass)", 10), ("Không đạt", 10), ("Bị chặn", 10), ("Chưa test", 10),
        ("Tiến độ %", 12), ("Trạng thái Tab", 16), ("Hạn chót", 12)
    ]
    ws.row_dimensions[r].height = 26
    for c_idx, (h_text, h_w) in enumerate(t_headers, 1):
        cell = ws.cell(row=r, column=c_idx, value=h_text)
        cell.font = font_tbl_header
        cell.fill = fill_maroon
        cell.border = border_header
        cell.alignment = align_center

    r_start_tabs = r + 1
    for idx, tab in enumerate(FUNCTIONAL_TABS, 1):
        r += 1
        ws.row_dimensions[r].height = 22
        fill_row = fill_white if idx % 2 != 0 else fill_zebra
        sheet_ref = f"'{tab['sheet']}'"
        
        ws.cell(row=r, column=1, value=idx).alignment = align_center
        ws.cell(row=r, column=2, value=tab["code"]).alignment = align_center
        ws.cell(row=r, column=3, value=tab["name"]).alignment = align_left
        ws.cell(row=r, column=4, value=tab["side"]).alignment = align_center
        
        c_owner = ws.cell(row=r, column=5, value=tab["owner"])
        c_owner.alignment = align_center
        c_owner.font = font_bold
        
        c_link = ws.cell(row=r, column=6, value=tab["sheet"])
        c_link.alignment = align_left
        c_link.hyperlink = f"#{tab['sheet']}!A1"
        c_link.font = Font(name="Consolas", size=9, color="1D4ED8", underline="single")
        
        # Formulas linking to sheet data rows (row 9 to 50)
        # Column L in functional tabs is Trạng thái UAT
        # Column B is Mã Test Case
        ws.cell(row=r, column=7, value=f'=COUNTA({sheet_ref}!$B$9:$B$50)').alignment = align_center # Total TC
        ws.cell(row=r, column=8, value=f'=COUNTIF({sheet_ref}!$L$9:$L$50, "Đạt (Pass)")').alignment = align_center # Pass
        ws.cell(row=r, column=9, value=f'=COUNTIF({sheet_ref}!$L$9:$L$50, "Không đạt (Fail)")').alignment = align_center # Fail
        ws.cell(row=r, column=10, value=f'=COUNTIF({sheet_ref}!$L$9:$L$50, "Bị chặn (Blocked)")').alignment = align_center # Blocked
        ws.cell(row=r, column=11, value=f'=COUNTIF({sheet_ref}!$L$9:$L$50, "Chưa test (Untested)")').alignment = align_center # Untested
        c_pct = ws.cell(row=r, column=12, value=f'=IF(G{r}=0, 0, (H{r}+I{r}+J{r})/G{r})')
        c_pct.alignment = align_center
        c_pct.number_format = "0.0%"
        c_pct.font = font_bold_maroon
        
        c_status = ws.cell(row=r, column=13, value="Đang thực hiện")
        c_status.alignment = align_center
        c_status.font = font_normal
        
        ws.cell(row=r, column=14, value="05/11/2026").alignment = align_center
        
        for col_i in range(1, 15):
            cell = ws.cell(row=r, column=col_i)
            cell.fill = fill_row
            cell.border = border_cell
            if col_i not in (5, 12): cell.font = font_normal

    r_end_tabs = r
    # Total summary row
    r += 1
    ws.row_dimensions[r].height = 24
    ws.merge_cells(f"A{r}:F{r}")
    c_tot = ws.cell(row=r, column=1, value="TỔNG CỘNG TIẾN ĐỘ UAT TOÀN HỆ THỐNG:")
    c_tot.font = font_tbl_header
    c_tot.fill = fill_gray_header
    c_tot.alignment = Alignment(horizontal="right", vertical="center")
    
    ws.cell(row=r, column=7, value=f"=SUM(G{r_start_tabs}:G{r_end_tabs})").alignment = align_center
    ws.cell(row=r, column=8, value=f"=SUM(H{r_start_tabs}:H{r_end_tabs})").alignment = align_center
    ws.cell(row=r, column=9, value=f"=SUM(I{r_start_tabs}:I{r_end_tabs})").alignment = align_center
    ws.cell(row=r, column=10, value=f"=SUM(J{r_start_tabs}:J{r_end_tabs})").alignment = align_center
    ws.cell(row=r, column=11, value=f"=SUM(K{r_start_tabs}:K{r_end_tabs})").alignment = align_center
    
    c_tot_pct = ws.cell(row=r, column=12, value=f"=IF(G{r}=0, 0, (H{r}+I{r}+J{r})/G{r})")
    c_tot_pct.alignment = align_center
    c_tot_pct.number_format = "0.0%"
    c_tot_pct.font = font_bold
    
    ws.merge_cells(f"M{r}:N{r}")
    ws.cell(row=r, column=13, value="Target: 100% 05/11").alignment = align_center
    ws.cell(row=r, column=13).font = font_bold
    
    for col_i in range(1, 15):
        cell = ws.cell(row=r, column=col_i)
        cell.fill = fill_gray_light
        cell.border = border_cell
        cell.font = font_bold

    # Set column widths
    col_widths = [6, 8, 34, 14, 14, 26, 11, 11, 11, 11, 11, 13, 16, 13]
    for idx, w in enumerate(col_widths, 1):
        ws.column_dimensions[get_column_letter(idx)].width = w

    # Dropdown validation for Tab Status
    dv_tab_status = DataValidation(type="list", formula1='"Chưa bắt đầu,Đang thực hiện,Chờ BA xác nhận,Hoàn thành"', allow_blank=True)
    ws.add_data_validation(dv_tab_status)
    dv_tab_status.add(f"M{r_start_tabs}:M{r_end_tabs}")

# ----------------------------------------------------------------------------------------
# Build Sheet 01: Test Environment & Instructions
# ----------------------------------------------------------------------------------------
def build_guide_sheet(wb):
    ws = wb.create_sheet(title="01_Huong_Dan_UAT", index=1)
    ws.views.sheetView[0].showGridLines = True
    
    # Banner
    ws.merge_cells("A1:K2")
    c = ws["A1"]
    c.value = "  HƯỚNG DẪN THỰC HIỆN UAT, MÔI TRƯỜNG KIỂM THỬ VÀ TÀI KHOẢN MẪU\n   Đọc kỹ tài liệu này trước khi tiến hành kiểm thử trên Storefront và Admin ERP"
    c.font = font_title
    c.fill = fill_maroon
    c.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
    ws.row_dimensions[1].height = 26
    ws.row_dimensions[2].height = 22

    # Section 1: URLs
    r = 4
    ws.merge_cells(f"A{r}:K{r}")
    s1 = ws.cell(row=r, column=1, value="1. ĐỊA CHỈ HỆ THỐNG KIỂM THỬ (TEST ENVIRONMENTS)")
    s1.font = font_sec_header
    s1.fill = fill_maroon_dark
    ws.row_dimensions[r].height = 22

    env_data = [
        ("Phân hệ Khách hàng (User Storefront):", "https://velura.royalai.dev", "Dành cho khách vãng lai (Guest) và Thành viên (Member) mua sắm"),
        ("Phân hệ Quản trị (Admin ERP):", "https://admin.royalai.dev", "Dành cho các vai trò quản trị viên, nhân viên vận hành, CSKH, kho"),
        ("API Backend & Health Check:", "https://velura.royalai.dev/api/health", "Kiểm tra trạng thái uptime của dịch vụ backend Node.js"),
        ("GitHub Repository & Issues:", "https://github.com/Royal2005-coder/Velura-Angular", "Nơi quản lý mã nguồn và ghi nhận toàn bộ Bug / Issue phát hiện"),
    ]
    for row_data in env_data:
        r += 1
        ws.row_dimensions[r].height = 22
        ws.cell(row=r, column=1, value=row_data[0]).font = font_bold_maroon
        ws.cell(row=r, column=1).alignment = align_left
        ws.cell(row=r, column=1).fill = fill_blush
        ws.cell(row=r, column=1).border = border_cell
        
        ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=5)
        c_val = ws.cell(row=r, column=2, value=row_data[1])
        c_val.font = font_bold
        c_val.alignment = align_left
        for col in range(2, 6): ws.cell(row=r, column=col).border = border_cell
        
        ws.merge_cells(start_row=r, start_column=6, end_row=r, end_column=11)
        c_desc = ws.cell(row=r, column=6, value=row_data[2])
        c_desc.font = font_normal
        c_desc.alignment = align_left
        for col in range(6, 12): ws.cell(row=r, column=col).border = border_cell

    # Section 2: Test Accounts
    r += 2
    ws.merge_cells(f"A{r}:K{r}")
    s2 = ws.cell(row=r, column=1, value="2. DANH SÁCH TÀI KHOẢN TEST THEO VAI TRÒ (CREDENTIALS)")
    s2.font = font_sec_header
    s2.fill = fill_maroon_dark
    ws.row_dimensions[r].height = 22

    acc_headers = [("STT", 6), ("Vai trò / Phân hệ", 22), ("Tài khoản (Email / SĐT)", 28), ("Mật khẩu", 16), ("Phạm vi sử dụng (Tab)", 24), ("Ghi chú quyền hạn & bảo mật", 35)]
    r += 1
    ws.row_dimensions[r].height = 24
    for c_idx, (h_text, h_w) in enumerate(acc_headers, 1):
        cell = ws.cell(row=r, column=c_idx, value=h_text)
        cell.font = font_tbl_header
        cell.fill = fill_gray_header
        cell.border = border_header
        cell.alignment = align_center

    accounts = [
        ("Super Admin", "admin.operator@velura.vn", "Admin@2026", "3.1.9, 3.1.11, 3.1.13", "Toàn quyền hệ thống, phân quyền, xem log"),
        ("Quản lý sản phẩm", "uat.sanpham@velura.vn", "Admin@2026", "3.1.10", "Thêm/sửa sản phẩm, điều chỉnh kho, import CSV"),
        ("Quản lý đơn hàng", "uat.donhang@velura.vn", "Admin@2026", "3.1.11", "Xác nhận COD, chuyển trạng thái đơn, in vận đơn"),
        ("CSKH & Đổi trả RMA", "cskh.rma@velura.vn", "Admin@2026", "3.1.12, 3.1.7b", "Xử lý yêu cầu RMA, đối soát hoàn tiền Napas B2C"),
        ("Giá & Khuyến mãi", "admin.marketing@velura.vn", "Admin@2026", "3.1.14, 3.1.10", "Tạo chiến dịch, sinh voucher, điều chỉnh giá bán"),
        ("Quản lý Đánh giá", "admin.reviews@velura.vn", "Admin@2026", "3.1.16", "Duyệt đánh giá, ẩn đánh giá vi phạm, trả lời review"),
        ("Admin Viewer (Chỉ xem)", "admin.viewer@velura.vn", "Admin@2026", "3.1.13", "Chỉ xem Dashboard và báo cáo, không có quyền sửa"),
        ("Member Mua sắm mẫu", "shopper.uat@velura.test", "Velura@2026", "3.1.1, 3.1.2, 3.1.3", "Thành viên đã có sẵn Style Profile và địa chỉ"),
        ("Member Checkout mẫu", "shopper.checkout@velura.test", "Velura@2026", "3.1.4, 3.1.5", "Dùng để đặt hàng, test voucher và hủy đơn"),
        ("Member Đổi trả mẫu", "customer.rma@velura.test", "Velura@2026", "3.1.6, 3.1.12", "Có đơn hàng đã giao thành công để test RMA"),
        ("Khách vãng lai (Guest)", "Không cần tài khoản", "-", "3.1.1, 3.1.3, 3.1.4, 3.1.5", "Mở trình duyệt ẩn danh (Incognito), dùng SĐT thật để test OTP"),
        ("Thẻ Stripe Test (Thành công)", "4242 4242 4242 4242", "Exp: 12/28, CVC: 123", "3.1.4", "Thanh toán thẻ quốc tế thành công ngay"),
        ("Thẻ Stripe Test (Thất bại)", "4000 0000 0000 0002", "Exp: 12/28, CVC: 123", "3.1.4", "Test tình huống thẻ bị ngân hàng từ chối thanh toán")
    ]
    for idx, acc in enumerate(accounts, 1):
        r += 1
        ws.row_dimensions[r].height = 22
        fill_row = fill_white if idx % 2 != 0 else fill_zebra
        ws.cell(row=r, column=1, value=idx).alignment = align_center
        ws.cell(row=r, column=2, value=acc[0]).alignment = align_left
        ws.cell(row=r, column=2).font = font_bold
        ws.cell(row=r, column=3, value=acc[1]).alignment = align_left
        ws.cell(row=r, column=3).font = font_code
        ws.cell(row=r, column=4, value=acc[2]).alignment = align_center
        ws.cell(row=r, column=5, value=acc[3]).alignment = align_left
        ws.cell(row=r, column=6, value=acc[4]).alignment = align_left
        for col_i in range(1, 7):
            cell = ws.cell(row=r, column=col_i)
            cell.fill = fill_row
            cell.border = border_cell
            if col_i not in (2,): cell.font = font_normal

    # Section 3: 6-Step Workflow
    r += 2
    ws.merge_cells(f"A{r}:K{r}")
    s3 = ws.cell(row=r, column=1, value="3. QUY TRÌNH 6 BƯỚC THỰC HIỆN KIỂM THỬ UAT CHUẨN")
    s3.font = font_sec_header
    s3.fill = fill_maroon_dark
    ws.row_dimensions[r].height = 22

    steps = [
        ("Bước 1: Mở Tab quy trình được phân công", "Đọc kỹ phần Thông tin quy trình ở đầu sheet: Phạm vi kiểm thử, màn hình URL, tài khoản test và các lưu ý trọng tâm."),
        ("Bước 2: Đối chiếu tài liệu BA ADVANCE", "Đọc kỹ mục quy trình tương ứng (Mô tả BPMN, bảng Quy tắc nghiệp vụ, các Tình huống ngoại lệ) để nắm rõ kết quả mong đợi chuẩn."),
        ("Bước 3: Thực hiện kiểm thử trên Web", "Thực hiện đúng từng bước thao tác trên giao diện Storefront hoặc Admin ERP. Nhập đúng dữ liệu kiểm thử (Test Data)."),
        ("Bước 4: Kiểm tra kết hợp Frontend & Backend", "Mở F12 DevTools -> Tab Network (Fetch/XHR) để kiểm tra mã trạng thái HTTP (200, 201, 400, 422...) và response JSON trả về. Đảm bảo dữ liệu hiển thị trên FE đồng nhất với dữ liệu lưu trong Database."),
        ("Bước 5: Ghi nhận kết quả vào Sheet UAT", "Chọn 'Trạng thái UAT' (Đạt / Không đạt / Bị chặn). Ghi rõ Kết quả thực tế gặp phải. Nếu Đạt -> Hoàn thành. Nếu Không đạt -> Chuyển sang Bước 6."),
        ("Bước 6: Tạo Issue trên GitHub & Đính kèm link", "Nếu phát hiện Bug hoặc sai khác với BA: Lập tức tạo Issue trên GitHub theo mẫu chuẩn ở Sheet 02. Dán link Issue vào cột 'Link GitHub Issue' trong sheet UAT.")
    ]
    for s_idx, (s_title, s_desc) in enumerate(steps, 1):
        r += 1
        ws.row_dimensions[r].height = 24
        ws.cell(row=r, column=1, value=f"{s_idx}").alignment = align_center
        ws.cell(row=r, column=1).font = font_bold_maroon
        ws.cell(row=r, column=1).fill = fill_blush
        ws.cell(row=r, column=1).border = border_cell
        
        ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=4)
        c_st = ws.cell(row=r, column=2, value=s_title)
        c_st.font = font_bold
        c_st.alignment = align_left
        for col in range(2, 5): ws.cell(row=r, column=col).border = border_cell
        
        ws.merge_cells(start_row=r, start_column=5, end_row=r, end_column=11)
        c_sd = ws.cell(row=r, column=5, value=s_desc)
        c_sd.font = font_normal
        c_sd.alignment = align_left
        for col in range(5, 12): ws.cell(row=r, column=col).border = border_cell

    # Column widths
    col_w = [6, 24, 28, 18, 22, 20, 15, 15, 15, 15, 15]
    for idx, w in enumerate(col_w, 1):
        ws.column_dimensions[get_column_letter(idx)].width = w

# ----------------------------------------------------------------------------------------
# Build Sheet 02: GitHub Issue Bug Reporting Template
# ----------------------------------------------------------------------------------------
def build_issue_template_sheet(wb):
    ws = wb.create_sheet(title="02_Mau_Bao_Cao_Issue_GitHub", index=2)
    ws.views.sheetView[0].showGridLines = True
    
    # Banner
    ws.merge_cells("A1:K2")
    c = ws["A1"]
    c.value = "  QUY CHUẨN BÁO CÁO BUG / ISSUE LÊN GITHUB CHO DEVELOPER FIX NHANH\n   Repository: https://github.com/Royal2005-coder/Velura-Angular/issues"
    c.font = font_title
    c.fill = fill_maroon
    c.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
    ws.row_dimensions[1].height = 26
    ws.row_dimensions[2].height = 22

    # Section 1: Syntax
    r = 4
    ws.merge_cells(f"A{r}:K{r}")
    s1 = ws.cell(row=r, column=1, value="1. QUY CHUẨN ĐẶT TIÊU ĐỀ ISSUE GITHUB (TITLE SYNTAX)")
    s1.font = font_sec_header
    s1.fill = fill_maroon_dark
    ws.row_dimensions[r].height = 22

    r += 1
    ws.row_dimensions[r].height = 26
    ws.merge_cells(f"A{r}:K{r}")
    c_syn = ws.cell(row=r, column=1, value="CÚ PHÁP CHUẨN: [Phân hệ][Vị trí][Tên Module] Tóm tắt lỗi ngắn gọn, chính xác")
    c_syn.font = Font(name="Consolas", size=11, bold=True, color=MAROON)
    c_syn.fill = fill_blush
    c_syn.alignment = align_center

    examples = [
        ("[FE][User][Checkout]", "Nút 'Đặt hàng' không bị disabled khi chưa chọn phương thức thanh toán", "Lỗi giao diện Storefront"),
        ("[BE][Admin][Returns]", "API approve return-item trả lỗi HTTP 500 khi thiếu thông tin đơn vị vận chuyển", "Lỗi API / Logic Backend"),
        ("[FE][Admin][Products]", "Modal sửa biến thể Màu x Size bị vỡ layout ở độ phân giải 1366x768", "Lỗi Responsive giao diện Admin"),
        ("[BE][User][Auth]", "Không gửi mã OTP qua SMS khi số điện thoại có đầu số 03x", "Lỗi Service xác thực OTP"),
        ("[BA-Gap][User][Pricing]", "Giá sản phẩm hiển thị trên giỏ hàng khác với giá tại bước Checkout", "Lỗi chênh lệch logic nghiệp vụ")
    ]
    for ex in examples:
        r += 1
        ws.row_dimensions[r].height = 22
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=3)
        c_pfx = ws.cell(row=r, column=1, value=ex[0])
        c_pfx.font = font_code
        c_pfx.alignment = align_center
        for col in range(1, 4): ws.cell(row=r, column=col).border = border_cell
        
        ws.merge_cells(start_row=r, start_column=4, end_row=r, end_column=9)
        c_title = ws.cell(row=r, column=4, value=ex[1])
        c_title.font = font_bold
        c_title.alignment = align_left
        for col in range(4, 10): ws.cell(row=r, column=col).border = border_cell
        
        ws.merge_cells(start_row=r, start_column=10, end_row=r, end_column=11)
        c_type = ws.cell(row=r, column=10, value=ex[2])
        c_type.font = font_normal
        c_type.alignment = align_left
        for col in range(10, 12): ws.cell(row=r, column=col).border = border_cell

    # Section 2: Labels Mapping
    r += 2
    ws.merge_cells(f"A{r}:K{r}")
    s2 = ws.cell(row=r, column=1, value="2. BẢNG TRA CỨU NHÃN GITHUB (GITHUB LABELS)")
    s2.font = font_sec_header
    s2.fill = fill_maroon_dark
    ws.row_dimensions[r].height = 22

    labels = [
        ("Phân hệ (Subsystem):", "user-storefront (Web khách), admin-erp (Web quản trị), api-backend (Dịch vụ Node API), database (Postgres/Supabase)"),
        ("Loại vấn đề (Type):", "bug (Lỗi chức năng), different-from-ba (Web khác tài liệu BA), ba-gap (BA thiếu hoặc mâu thuẫn), enhancement (Góp ý cải tiến)"),
        ("Mức độ nghiêm trọng (Severity):", "severity:blocker (Chặn hoàn toàn luồng chính), severity:critical (Sai tiền/dữ liệu/bảo mật), severity:major (Lỗi chức năng có đường vòng), severity:minor (Lỗi chữ/giao diện nhẹ)"),
        ("Độ ưu tiên xử lý (Priority):", "p0-urgent (Cần fix ngay trong ngày), p1-high (Fix trước khi chốt UAT), p2-medium (Fix trong sprint hiện tại), p3-low (Xem xét cải tiến sau)")
    ]
    for lbl in labels:
        r += 1
        ws.row_dimensions[r].height = 24
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=3)
        ws.cell(row=r, column=1, value=lbl[0]).font = font_bold_maroon
        ws.cell(row=r, column=1).alignment = align_left
        ws.cell(row=r, column=1).fill = fill_blush
        for col in range(1, 4): ws.cell(row=r, column=col).border = border_cell
        
        ws.merge_cells(start_row=r, start_column=4, end_row=r, end_column=11)
        c_val = ws.cell(row=r, column=4, value=lbl[1])
        c_val.font = font_normal
        c_val.alignment = align_left
        for col in range(4, 12): ws.cell(row=r, column=col).border = border_cell

    # Section 3: Markdown Template
    r += 2
    ws.merge_cells(f"A{r}:K{r}")
    s3 = ws.cell(row=r, column=1, value="3. MẪU NỘI DUNG MARKDOWN ĐỂ COPY-PASTE LÊN GITHUB ISSUE")
    s3.font = font_sec_header
    s3.fill = fill_maroon_dark
    ws.row_dimensions[r].height = 22

    md_template = (
        "## 1. Mô tả tóm tắt lỗi (Bug Summary)\n"
        "[Mô tả ngắn gọn điều gì đang xảy ra bất thường]\n\n"
        "## 2. Môi trường kiểm thử (Environment)\n"
        "- Phân hệ: [User Storefront / Admin ERP]\n"
        "- URL màn hình: [Ví dụ: https://velura.royalai.dev/checkout/payment]\n"
        "- Tài khoản test: [Ví dụ: shopper.checkout@velura.test]\n"
        "- Trình duyệt: [Chrome bản 130 / Cửa sổ ẩn danh]\n\n"
        "## 3. Các bước tái hiện lỗi (Steps to Reproduce)\n"
        "1. Bước 1: ...\n"
        "2. Bước 2: ...\n"
        "3. Bước 3: ...\n\n"
        "## 4. Kết quả mong đợi theo BA (Expected Result)\n"
        "[Trích dẫn quy tắc BA hoặc hành vi chuẩn phải xảy ra]\n\n"
        "## 5. Kết quả thực tế gặp phải (Actual Result)\n"
        "[Hành vi lỗi trên web: Thông báo lỗi, nút bị treo, tiền tính sai...]\n\n"
        "## 6. Minh chứng lỗi (Evidence)\n"
        "- Ảnh chụp màn hình: [Dán link ảnh hoặc kéo thả ảnh vào đây]\n"
        "- Log DevTools / API Response:\n"
        "```json\n"
        "// Dán mã lỗi Console hoặc payload Network lỗi tại đây\n"
        "```\n\n"
        "## 7. Mã quy tắc BA liên quan (Rule ID)\n"
        "[Ví dụ: 3.1.4.3-PAY-05 / AD-ORDER-03]"
    )
    r += 1
    ws.row_dimensions[r].height = 160
    ws.merge_cells(f"A{r}:K{r}")
    c_md = ws.cell(row=r, column=1, value=md_template)
    c_md.font = Font(name="Consolas", size=9, color="1F2937")
    c_md.fill = fill_gray_light
    c_md.alignment = Alignment(horizontal="left", vertical="top", wrap_text=True)
    for col in range(1, 12): ws.cell(row=r, column=col).border = border_cell

    # Column widths
    col_w = [6, 12, 16, 16, 16, 16, 16, 16, 16, 18, 18]
    for idx, w in enumerate(col_w, 1):
        ws.column_dimensions[get_column_letter(idx)].width = w

# ----------------------------------------------------------------------------------------
# Build Sheet 03: Central Team Bug Tracking Log
# ----------------------------------------------------------------------------------------
def build_issue_log_sheet(wb):
    ws = wb.create_sheet(title="03_Nhat_Ky_Issue_Feedback", index=3)
    ws.views.sheetView[0].showGridLines = True
    
    # Banner
    ws.merge_cells("A1:N2")
    c = ws["A1"]
    c.value = "  NHẬT KÝ THEO DÕI LỖI & FEEDBACK TẬP TRUNG TOÀN HỆ THỐNG\n   Dùng chung cho cả 6 thành viên theo dõi tiến độ sửa bug của team Dev"
    c.font = font_title
    c.fill = fill_maroon
    c.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
    ws.row_dimensions[1].height = 26
    ws.row_dimensions[2].height = 22

    headers = [
        ("Mã Issue", 12), ("Ngày báo", 12), ("Người báo", 12), ("Phân hệ", 12),
        ("Tab quy trình", 16), ("Tiêu đề tóm tắt lỗi", 35), ("Mã quy tắc BA", 15),
        ("Mức độ lỗi", 14), ("Link GitHub Issue", 26), ("Trạng thái fix", 16),
        ("Người xử lý", 14), ("Ngày đóng", 12), ("Ghi chú giải pháp", 30), ("Minh chứng", 20)
    ]
    r = 4
    ws.row_dimensions[r].height = 26
    for c_idx, (h_text, h_w) in enumerate(headers, 1):
        cell = ws.cell(row=r, column=c_idx, value=h_text)
        cell.font = font_tbl_header
        cell.fill = fill_maroon
        cell.border = border_header
        cell.alignment = align_center

    # 30 prefilled rows
    for i in range(1, 31):
        r += 1
        ws.row_dimensions[r].height = 22
        fill_row = fill_white if i % 2 != 0 else fill_zebra
        ws.cell(row=r, column=1, value=f"ISSUE-{i:03d}").alignment = align_center
        ws.cell(row=r, column=1).font = font_bold
        ws.cell(row=r, column=10, value="Mới").alignment = align_center
        for col_i in range(1, 15):
            cell = ws.cell(row=r, column=col_i)
            cell.fill = fill_row
            cell.border = border_cell
            if col_i != 1: cell.font = font_normal

    for idx, (h_text, h_w) in enumerate(headers, 1):
        ws.column_dimensions[get_column_letter(idx)].width = h_w

    # Validations
    dv_log_status = DataValidation(type="list", formula1='"Mới,Đang sửa,Đã sửa - Chờ test lại,Đã chốt BA,Không sửa (Wontfix)"', allow_blank=True)
    ws.add_data_validation(dv_log_status)
    dv_log_status.add(f"J5:J35")

    dv_log_sev = DataValidation(type="list", formula1='"Blocker,Critical,Major,Minor,Góp ý"', allow_blank=True)
    ws.add_data_validation(dv_log_sev)
    dv_log_sev.add(f"H5:H35")

# ----------------------------------------------------------------------------------------
# Build 16 Functional UAT Tabs
# ----------------------------------------------------------------------------------------
def build_functional_tabs(wb):
    for tab in FUNCTIONAL_TABS:
        ws = wb.create_sheet(title=tab["sheet"])
        ws.views.sheetView[0].showGridLines = True
        
        # Banner
        ws.merge_cells("A1:Q2")
        c = ws["A1"]
        c.value = f"  QUY TRÌNH {tab['code']}: {tab['name'].upper()} ({tab['side'].upper()})\n   Người phụ trách UAT: {tab['owner']}  ·  Hạn chót: 23:59 05/11/2026"
        c.font = font_title
        c.fill = fill_maroon
        c.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
        ws.row_dimensions[1].height = 26
        ws.row_dimensions[2].height = 22

        # Metadata Box (Rows 3 to 6)
        meta_rows = [
            ("Mã & Tên quy trình:", f"{tab['code']} - {tab['name']}", "Người test (Tester):", tab["owner"], "Phân hệ:", tab["side"]),
            ("Màn hình kiểm thử (URL):", tab["screens"], "Tài khoản test:", tab["accounts"], "Thời hạn:", "05/11/2026"),
            ("Mục tiêu trọng tâm UAT:", tab["focus"], "", "", "Trạng thái:", "Đang thực hiện"),
            ("Lưu ý nghiệp vụ đặc thù:", tab["notes"], "", "", "Issue GitHub:", "https://github.com/Royal2005-coder/Velura-Angular/issues")
        ]
        for r_idx, row_data in enumerate(meta_rows, 3):
            ws.row_dimensions[r_idx].height = 24
            
            # Label 1 (Col A)
            c_l1 = ws.cell(row=r_idx, column=1, value=row_data[0])
            c_l1.font = font_bold_maroon
            c_l1.fill = fill_blush
            c_l1.border = border_cell
            c_l1.alignment = align_left
            
            # Val 1 (Col B..G)
            ws.merge_cells(start_row=r_idx, start_column=2, end_row=r_idx, end_column=7)
            c_v1 = ws.cell(row=r_idx, column=2, value=row_data[1])
            c_v1.font = font_normal
            c_v1.alignment = align_top_left
            for c_i in range(2, 8): ws.cell(row=r_idx, column=c_i).border = border_cell
            
            # Label 2 (Col H)
            c_l2 = ws.cell(row=r_idx, column=8, value=row_data[2])
            c_l2.font = font_bold_maroon
            c_l2.fill = fill_blush
            c_l2.border = border_cell
            c_l2.alignment = align_left
            
            # Val 2 (Col I..M)
            ws.merge_cells(start_row=r_idx, start_column=9, end_row=r_idx, end_column=13)
            c_v2 = ws.cell(row=r_idx, column=9, value=row_data[3])
            c_v2.font = font_normal
            c_v2.alignment = align_top_left
            for c_i in range(9, 14): ws.cell(row=r_idx, column=c_i).border = border_cell
            
            # Label 3 (Col N)
            c_l3 = ws.cell(row=r_idx, column=14, value=row_data[4])
            c_l3.font = font_bold_maroon
            c_l3.fill = fill_blush
            c_l3.border = border_cell
            c_l3.alignment = align_left
            
            # Val 3 (Col O..Q)
            ws.merge_cells(start_row=r_idx, start_column=15, end_row=r_idx, end_column=17)
            c_v3 = ws.cell(row=r_idx, column=15, value=row_data[5])
            c_v3.font = font_bold
            c_v3.alignment = align_center
            for c_i in range(15, 18): ws.cell(row=r_idx, column=c_i).border = border_cell

        # Section Table Header (Row 8)
        r_head = 8
        headers = [
            ("STT", 6, align_center),
            ("Mã Test Case", 15, align_center),
            ("Phân hệ", 12, align_center),
            ("Nhóm luồng", 20, align_left),
            ("Tên chức năng / Tiêu chí kiểm thử", 30, align_left),
            ("Mã quy tắc BA", 15, align_center),
            ("Điều kiện tiên quyết (Preconditions)", 28, align_left),
            ("Các bước thực hiện (Test Steps)", 36, align_left),
            ("Dữ liệu kiểm thử (Test Data)", 24, align_left),
            ("Kết quả mong đợi (Expected Result)", 36, align_left),
            ("Kết quả thực tế (Actual Result)", 32, align_left),
            ("Trạng thái UAT", 16, align_center),
            ("Mức độ lỗi", 14, align_center),
            ("Link GitHub Issue", 24, align_left),
            ("Người test", 12, align_center),
            ("Ngày test", 12, align_center),
            ("Bằng chứng & Ghi chú (Evidence)", 30, align_left),
        ]
        ws.row_dimensions[r_head].height = 28
        for col_idx, (text, width, align) in enumerate(headers, 1):
            cell = ws.cell(row=r_head, column=col_idx, value=text)
            cell.font = font_tbl_header
            cell.fill = fill_maroon
            cell.border = border_header
            cell.alignment = align_center
            col_letter = get_column_letter(col_idx)
            ws.column_dimensions[col_letter].width = max(width, 10)

        # Populate sample cases
        cur_row = r_head + 1
        samples = tab.get("sample_cases", [])
        for idx, tc in enumerate(samples, 1):
            ws.row_dimensions[cur_row].height = 30
            row_fill = fill_white if idx % 2 != 0 else fill_zebra
            row_vals = [
                idx, tc.get("id", f"TC_{idx:02d}"), tc.get("subsys", "Frontend"),
                tc.get("group", "Luồng chính (Happy Path)"), tc.get("feature", ""),
                tc.get("rule", ""), tc.get("pre", ""), tc.get("steps", ""),
                tc.get("data", ""), tc.get("expected", ""), tc.get("actual", ""),
                tc.get("status", "Chưa test (Untested)"), tc.get("sev", ""),
                tc.get("issue", ""), tc.get("tester", tab["owner"]), tc.get("date", ""),
                tc.get("note", "")
            ]
            for c_idx, val in enumerate(row_vals, 1):
                cell = ws.cell(row=cur_row, column=c_idx, value=val)
                cell.font = font_normal if c_idx not in (1, 2) else font_bold
                cell.fill = row_fill
                cell.border = border_cell
                cell.alignment = headers[c_idx - 1][2]
            cur_row += 1

        # Populate formatted empty rows up to row 40
        start_empty = len(samples) + 1
        for idx in range(start_empty, 31):
            ws.row_dimensions[cur_row].height = 24
            row_fill = fill_white if idx % 2 != 0 else fill_zebra
            for c_idx in range(1, 18):
                cell = ws.cell(row=cur_row, column=c_idx)
                if c_idx == 1:
                    cell.value = idx
                    cell.font = font_bold
                    cell.alignment = align_center
                elif c_idx == 2:
                    cell.value = f"TC_{tab['code'].replace('.', '_')}_{idx:02d}"
                    cell.font = font_code
                    cell.alignment = align_center
                elif c_idx == 12:
                    cell.value = "Chưa test (Untested)"
                    cell.alignment = align_center
                    cell.font = font_small
                elif c_idx == 15:
                    cell.value = tab["owner"]
                    cell.alignment = align_center
                    cell.font = font_normal
                else:
                    cell.alignment = headers[c_idx - 1][2]
                cell.fill = row_fill
                cell.border = border_cell
            cur_row += 1

        end_row_val = cur_row - 1

        # Data Validations
        dv_status = DataValidation(type="list", formula1='"Đạt (Pass),Không đạt (Fail),Bị chặn (Blocked),Chưa test (Untested),N/A"', allow_blank=True)
        ws.add_data_validation(dv_status)
        dv_status.add(f"L9:L{end_row_val}")

        dv_subsys = DataValidation(type="list", formula1='"Frontend,Backend,Fullstack,Giao diện,API/DB"', allow_blank=True)
        ws.add_data_validation(dv_subsys)
        dv_subsys.add(f"C9:C{end_row_val}")

        dv_group = DataValidation(type="list", formula1='"Luồng chính (Happy Path),Quy tắc nghiệp vụ,Tình huống ngoại lệ,Phân quyền & Dữ liệu,Giao diện & Trải nghiệm"', allow_blank=True)
        ws.add_data_validation(dv_group)
        dv_group.add(f"D9:D{end_row_val}")

        dv_sev = DataValidation(type="list", formula1='"Blocker,Critical,Major,Minor,Góp ý (Cosmetic)"', allow_blank=True)
        ws.add_data_validation(dv_sev)
        dv_sev.add(f"M9:M{end_row_val}")

        dv_tester = DataValidation(type="list", formula1='"Hân,Khải,Gia,Uyên,Quỳnh,Ninh"', allow_blank=True)
        ws.add_data_validation(dv_tester)
        dv_tester.add(f"O9:O{end_row_val}")
        # Conditional Formatting for Status column L
        rule_pass = CellIsRule(operator='equal', formula=['"Đạt (Pass)"'], stopIfTrue=True,
                               fill=PatternFill(start_color=PASS_BG, end_color=PASS_BG, fill_type="solid"),
                               font=Font(name="Segoe UI", size=9, bold=True, color=PASS_TEXT))
        rule_fail = CellIsRule(operator='equal', formula=['"Không đạt (Fail)"'], stopIfTrue=True,
                               fill=PatternFill(start_color=FAIL_BG, end_color=FAIL_BG, fill_type="solid"),
                               font=Font(name="Segoe UI", size=9, bold=True, color=FAIL_TEXT))
        rule_block = CellIsRule(operator='equal', formula=['"Bị chặn (Blocked)"'], stopIfTrue=True,
                                fill=PatternFill(start_color=BLOCK_BG, end_color=BLOCK_BG, fill_type="solid"),
                                font=Font(name="Segoe UI", size=9, bold=True, color=BLOCK_TEXT))
        ws.conditional_formatting.add(f"L9:L{end_row_val}", rule_pass)
        ws.conditional_formatting.add(f"L9:L{end_row_val}", rule_fail)
        ws.conditional_formatting.add(f"L9:L{end_row_val}", rule_block)

        # Freeze pane at row 9
        ws.freeze_panes = "A9"

# ----------------------------------------------------------------------------------------
# Main execution
# ----------------------------------------------------------------------------------------
def main():
    print("Initializing UAT Workbook generator...")
    wb = openpyxl.Workbook()
    # Remove default sheet
    default_sheet = wb.active
    
    print("Building Sheet 00: Overview & PCCV...")
    build_overview_sheet(wb)
    
    print("Building Sheet 01: Test Environment & Instructions...")
    build_guide_sheet(wb)
    
    print("Building Sheet 02: GitHub Issue Reporting Template...")
    build_issue_template_sheet(wb)
    
    print("Building Sheet 03: Central Issue Log...")
    build_issue_log_sheet(wb)
    
    print("Building 16 Functional UAT Tabs...")
    build_functional_tabs(wb)
    
    # Remove initial default sheet
    if default_sheet.title in wb.sheetnames:
        wb.remove(default_sheet)

    print(f"Saving workbook to {FILE_MAIN}...")
    wb.save(FILE_MAIN)
    
    print(f"Duplicating to {FILE_COMPAT} for backward compatibility...")
    shutil.copyfile(FILE_MAIN, FILE_COMPAT)
    
    print("SUCCESS: Comprehensive Velura UAT workbook generated perfectly!")

if __name__ == "__main__":
    main()
