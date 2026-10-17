import os
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

def build_uat_workbook():
    wb = openpyxl.Workbook()
    # Remove default sheet
    wb.remove(wb.active)

    # Styles definition
    font_family = "Segoe UI"
    
    # Fonts
    title_font = Font(name=font_family, size=16, bold=True, color="FFFFFF")
    subtitle_font = Font(name=font_family, size=10, italic=True, color="F3EFEA")
    sheet_header_font = Font(name=font_family, size=13, bold=True, color="1E293B")
    table_header_font = Font(name=font_family, size=10, bold=True, color="FFFFFF")
    sub_header_font = Font(name=font_family, size=10, bold=True, color="334155")
    cell_font = Font(name=font_family, size=9.5, color="1E293B")
    cell_font_bold = Font(name=font_family, size=9.5, bold=True, color="1E293B")
    code_font = Font(name="Consolas", size=9, bold=True, color="0F172A")
    kpi_num_font = Font(name=font_family, size=18, bold=True, color="1E293B")
    kpi_label_font = Font(name=font_family, size=9, bold=True, color="64748B")

    # Fills
    brand_primary_fill = PatternFill(start_color="7D562D", end_color="7D562D", fill_type="solid") # Velura Terracotta Brown
    brand_dark_fill = PatternFill(start_color="1E293B", end_color="1E293B", fill_type="solid") # Slate 800
    brand_accent_fill = PatternFill(start_color="8C4E16", end_color="8C4E16", fill_type="solid") # Warm Saddle
    header_light_fill = PatternFill(start_color="F1E8DF", end_color="F1E8DF", fill_type="solid") # Light Brown tint
    zebra_fill = PatternFill(start_color="FDFCFB", end_color="FDFCFB", fill_type="solid")
    card_bg_fill = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")
    
    # Status Fills & Fonts
    pass_fill = PatternFill(start_color="DCFCE7", end_color="DCFCE7", fill_type="solid") # Green 100
    pass_font = Font(name=font_family, size=9.5, bold=True, color="166534") # Green 800
    fail_fill = PatternFill(start_color="FEE2E2", end_color="FEE2E2", fill_type="solid") # Red 100
    fail_font = Font(name=font_family, size=9.5, bold=True, color="991B1B") # Red 800
    blocked_fill = PatternFill(start_color="FEF3C7", end_color="FEF3C7", fill_type="solid") # Amber 100
    blocked_font = Font(name=font_family, size=9.5, bold=True, color="92400E") # Amber 800
    untested_fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid") # Slate 100
    untested_font = Font(name=font_family, size=9.5, bold=True, color="475569") # Slate 600

    # Borders
    thin_border_side = Side(border_style="thin", color="E2D9D0")
    double_bottom_side = Side(border_style="double", color="7D562D")
    thick_bottom_side = Side(border_style="medium", color="7D562D")
    
    cell_border = Border(left=thin_border_side, right=thin_border_side, top=thin_border_side, bottom=thin_border_side)
    header_border = Border(left=thin_border_side, right=thin_border_side, top=thin_border_side, bottom=thick_bottom_side)
    summary_border = Border(left=thin_border_side, right=thin_border_side, top=thin_border_side, bottom=double_bottom_side)

    # Alignments
    align_center = Alignment(horizontal="center", vertical="center")
    align_left = Alignment(horizontal="left", vertical="center")
    align_left_wrap = Alignment(horizontal="left", vertical="center", wrap_text=True)
    align_right = Alignment(horizontal="right", vertical="center")

    # =========================================================================
    # SHEET 1: TỔNG QUAN & PHÂN CÔNG (Overview & Tester Assignments)
    # =========================================================================
    ws1 = wb.create_sheet(title="Tổng quan & Phân công")
    ws1.views.sheetView[0].showGridLines = True

    # Title Banner
    ws1.merge_cells("A1:K1")
    ws1["A1"] = "KẾ HOẠCH & MA TRẬN PHÂN CÔNG KIỂM THỬ CHẤP NHẬN NGƯỜI DÙNG (UAT)"
    ws1["A1"].font = title_font
    ws1["A1"].fill = brand_primary_fill
    ws1["A1"].alignment = Alignment(horizontal="left", vertical="center", indent=1)
    ws1.row_dimensions[1].height = 40

    ws1.merge_cells("A2:K2")
    ws1["A2"] = "Dự án: Nền tảng Thương mại Điện tử Velura Fashion | Release Candidate: v1.0-RC | Phạm vi: 6 Phân hệ Core & 42 Kịch bản UAT"
    ws1["A2"].font = subtitle_font
    ws1["A2"].fill = brand_accent_fill
    ws1["A2"].alignment = Alignment(horizontal="left", vertical="center", indent=1)
    ws1.row_dimensions[2].height = 24

    # KPI Summary Cards Block (Row 4 to 6)
    kpis = [
        ("B4", "C4", "B5", "C5", "B6", "C6", "TỔNG TEST CASES", "='Kịch bản UAT Chi tiết'!B2", "Kịch bản đã chuẩn bị"),
        ("E4", "F4", "E5", "F5", "E6", "F6", "ĐẠT (PASS)", "=COUNTIF('Kịch bản UAT Chi tiết'!J4:J45, \"Pass\")", "Kịch bản đạt yêu cầu"),
        ("H4", "I4", "H5", "I5", "H6", "I6", "LỖI (FAIL)", "=COUNTIF('Kịch bản UAT Chi tiết'!J4:J45, \"Fail\")", "Cần DEV sửa chữa"),
        ("K4", "K4", "K5", "K5", "K6", "K6", "TỶ LỆ ĐẠT (PASS RATE)", "=IF(B5>0, E5/B5, 0)", "Mục tiêu nghiệm thu >= 95%"),
    ]

    for top_l, top_r, mid_l, mid_r, bot_l, bot_r, label, formula, note in kpis:
        if top_l != top_r:
            ws1.merge_cells(f"{top_l}:{top_r}")
            ws1.merge_cells(f"{mid_l}:{mid_r}")
            ws1.merge_cells(f"{bot_l}:{bot_r}")
        ws1[top_l] = label
        ws1[top_l].font = kpi_label_font
        ws1[top_l].fill = card_bg_fill
        ws1[top_l].alignment = align_center

        ws1[mid_l] = formula
        ws1[mid_l].font = kpi_num_font
        ws1[mid_l].fill = card_bg_fill
        ws1[mid_l].alignment = align_center

        ws1[bot_l] = note
        ws1[bot_l].font = Font(name=font_family, size=8, italic=True, color="94A3B8")
        ws1[bot_l].fill = card_bg_fill
        ws1[bot_l].alignment = align_center

    ws1["K5"].number_format = "0.0%"
    ws1.row_dimensions[4].height = 18
    ws1.row_dimensions[5].height = 28
    ws1.row_dimensions[6].height = 18

    # Table 1: Phân công 6 Testers (Row 8 to 16)
    ws1["A8"] = "1. BẢNG PHÂN CÔNG 6 NHÂN SỰ UAT THEO PERSONA & VAI TRÒ"
    ws1["A8"].font = sheet_header_font
    ws1.row_dimensions[8].height = 28

    tester_headers = ["Mã Tester", "Họ và Tên", "Vai trò (Persona)", "Phân hệ / Quy trình phụ trách", "Tài khoản Test", "Số lượng TC", "Đạt (Pass)", "Lỗi (Fail)", "Chưa test", "Tiến độ", "Trạng thái"]
    for col_idx, h in enumerate(tester_headers, 1):
        cell = ws1.cell(row=9, column=col_idx, value=h)
        cell.font = table_header_font
        cell.fill = brand_dark_fill
        cell.alignment = align_center
        cell.border = header_border
    ws1.row_dimensions[9].height = 26

    testers_data = [
        ("Tester 01", "Nguyễn Thị Ánh", "Khách Shopper Online", "Tìm kiếm AI, Lọc SP, Giỏ hàng, Mua ngay, Thanh toán Stripe", "shopper.online@velura.test", "=COUNTIF('Kịch bản UAT Chi tiết'!C4:C45, A10)", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A10, 'Kịch bản UAT Chi tiết'!J4:J45, \"Pass\")", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A10, 'Kịch bản UAT Chi tiết'!J4:J45, \"Fail\")", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A10, 'Kịch bản UAT Chi tiết'!J4:J45, \"Untested\")", "=IF(F10>0, G10/F10, 0)", "Đang tiến hành"),
        ("Tester 02", "Trần Quốc Bảo", "Khách VIP & COD", "Hồ sơ cá nhân, Voucher Sinh nhật HPBD2026, Đặt hàng COD, Quà tặng, Hóa đơn VAT, Hủy đơn", "vip.member@velura.test", "=COUNTIF('Kịch bản UAT Chi tiết'!C4:C45, A11)", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A11, 'Kịch bản UAT Chi tiết'!J4:J45, \"Pass\")", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A11, 'Kịch bản UAT Chi tiết'!J4:J45, \"Fail\")", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A11, 'Kịch bản UAT Chi tiết'!J4:J45, \"Untested\")", "=IF(F11>0, G11/F11, 0)", "Đang tiến hành"),
        ("Tester 03", "Lê Hoàng Châu", "Khách Hậu mãi & Review", "Tạo yêu cầu Đổi trả (Hoàn tiền / Đổi hàng), Upload ảnh lỗi, Tra cứu tiến độ RMA, Đánh giá đơn mua & Khách vãng lai OTP", "chau.le@gmail.test", "=COUNTIF('Kịch bản UAT Chi tiết'!C4:C45, A12)", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A12, 'Kịch bản UAT Chi tiết'!J4:J45, \"Pass\")", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A12, 'Kịch bản UAT Chi tiết'!J4:J45, \"Fail\")", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A12, 'Kịch bản UAT Chi tiết'!J4:J45, \"Untested\")", "=IF(F12>0, G12/F12, 0)", "Đang tiến hành"),
        ("Tester 04", "Phạm Văn Dũng", "Vận hành Đơn hàng & Kho", "Admin tiếp nhận đơn, Gọi xác nhận đơn COD, Đóng gói, Bàn giao vận chuyển, Tiếp nhận kiện đổi trả & Kiểm định QA", "warehouse.ops@velura.vn", "=COUNTIF('Kịch bản UAT Chi tiết'!C4:C45, A13)", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A13, 'Kịch bản UAT Chi tiết'!J4:J45, \"Pass\")", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A13, 'Kịch bản UAT Chi tiết'!J4:J45, \"Fail\")", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A13, 'Kịch bản UAT Chi tiết'!J4:J45, \"Untested\")", "=IF(F13>0, G13/F13, 0)", "Đang tiến hành"),
        ("Tester 05", "Đặng Thị Mai", "Chuyên viên CSKH & RMA", "Liên hệ khách đổi trả, Duyệt hoàn tiền cố định, Duyệt đổi size/màu, Từ chối kèm lý do, Hoàn tiền Stripe/Thủ công, Soạn & gửi hàng đổi", "cskh.lead@velura.vn", "=COUNTIF('Kịch bản UAT Chi tiết'!C4:C45, A14)", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A14, 'Kịch bản UAT Chi tiết'!J4:J45, \"Pass\")", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A14, 'Kịch bản UAT Chi tiết'!J4:J45, \"Fail\")", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A14, 'Kịch bản UAT Chi tiết'!J4:J45, \"Untested\")", "=IF(F14>0, G14/F14, 0)", "Đang tiến hành"),
        ("Tester 06", "Vũ Minh Tuấn", "Quản trị viên Catalog & MKT", "Quản lý SP & Biến thể, Khóa mua khi hết tồn, AI mô tả SP, Tạo Flash sale & Voucher, Kiểm duyệt Review nhạy cảm, Phân quyền & Audit logs", "admin.system@velura.vn", "=COUNTIF('Kịch bản UAT Chi tiết'!C4:C45, A15)", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A15, 'Kịch bản UAT Chi tiết'!J4:J45, \"Pass\")", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A15, 'Kịch bản UAT Chi tiết'!J4:J45, \"Fail\")", "=COUNTIFS('Kịch bản UAT Chi tiết'!C4:C45, A15, 'Kịch bản UAT Chi tiết'!J4:J45, \"Untested\")", "=IF(F15>0, G15/F15, 0)", "Đang tiến hành"),
    ]

    for r_idx, row in enumerate(testers_data, 10):
        for c_idx, val in enumerate(row, 1):
            c = ws1.cell(row=r_idx, column=c_idx, value=val)
            c.font = cell_font
            c.border = cell_border
            if c_idx in [1, 5]:
                c.font = code_font
                c.alignment = align_center
            elif c_idx in [2, 3]:
                c.alignment = align_left
            elif c_idx == 4:
                c.alignment = align_left_wrap
            elif c_idx in [6, 7, 8, 9]:
                c.alignment = align_center
            elif c_idx == 10:
                c.alignment = align_right
                c.number_format = "0.0%"
            elif c_idx == 11:
                c.alignment = align_center
                c.fill = blocked_fill
                c.font = blocked_font
        ws1.row_dimensions[r_idx].height = 24

    # Summary Row
    summary_row = 16
    ws1.cell(row=summary_row, column=1, value="TỔNG CỘNG").font = cell_font_bold
    ws1.cell(row=summary_row, column=1).alignment = align_center
    ws1.cell(row=summary_row, column=1).border = summary_border
    for c in range(2, 6):
        cell = ws1.cell(row=summary_row, column=c, value="")
        cell.border = summary_border

    ws1.cell(row=summary_row, column=6, value="=SUM(F10:F15)").font = cell_font_bold
    ws1.cell(row=summary_row, column=6).alignment = align_center
    ws1.cell(row=summary_row, column=6).border = summary_border

    ws1.cell(row=summary_row, column=7, value="=SUM(G10:G15)").font = cell_font_bold
    ws1.cell(row=summary_row, column=7).alignment = align_center
    ws1.cell(row=summary_row, column=7).border = summary_border

    ws1.cell(row=summary_row, column=8, value="=SUM(H10:H15)").font = cell_font_bold
    ws1.cell(row=summary_row, column=8).alignment = align_center
    ws1.cell(row=summary_row, column=8).border = summary_border

    ws1.cell(row=summary_row, column=9, value="=SUM(I10:I15)").font = cell_font_bold
    ws1.cell(row=summary_row, column=9).alignment = align_center
    ws1.cell(row=summary_row, column=9).border = summary_border

    ws1.cell(row=summary_row, column=10, value="=IF(F16>0, G16/F16, 0)").font = cell_font_bold
    ws1.cell(row=summary_row, column=10).alignment = align_right
    ws1.cell(row=summary_row, column=10).number_format = "0.0%"
    ws1.cell(row=summary_row, column=10).border = summary_border

    ws1.cell(row=summary_row, column=11, value="").border = summary_border
    ws1.row_dimensions[summary_row].height = 24

    # Table 2: Tiêu chuẩn mức độ nghiêm trọng lỗi (Severity Definition)
    ws1["A18"] = "2. QUY CHUẨN ĐÁNH GIÁ MỨC ĐỘ NGHIÊM TRỌNG CỦA LỖI (DEFECT SEVERITY)"
    ws1["A18"].font = sheet_header_font
    ws1.row_dimensions[18].height = 28

    sev_headers = ["Mức độ", "Định nghĩa kỹ thuật", "Tác động nghiệp vụ", "Ví dụ thực tế trong Velura", "SLA Xử lý"]
    for col_idx, h in enumerate(sev_headers, 1):
        c = ws1.cell(row=19, column=col_idx, value=h)
        c.font = table_header_font
        c.fill = brand_dark_fill
        c.alignment = align_center
        c.border = header_border
    ws1.row_dimensions[19].height = 24

    sev_data = [
        ("Blocker", "Lỗi sập hệ thống (Crash/500), dừng toàn bộ quy trình, không có cách giải quyết thay thế (workaround).", "Khách hàng không thể thanh toán, mất doanh thu lập tức.", "Lỗi thanh toán Stripe báo 500; Kho không thể nhận hàng đổi trả; Không tạo được đơn hàng.", "Ngay lập tức (<= 2h)"),
        ("Critical", "Chức năng chính bị hỏng nặng, sai lệch dữ liệu tài chính hoặc số lượng tồn kho.", "Ảnh hưởng trực tiếp đến kế toán, thất thoát hàng hóa hoặc tiền hoàn.", "Sai lệch số tiền hoàn trả khách; Hết hàng tồn kho nhưng nút Mua ngay vẫn không bị khóa.", "Khắc phục trong 6h"),
        ("Major", "Chức năng quan trọng không hoạt động đúng kỳ vọng nhưng có luồng tạm thay thế.", "Gây trải nghiệm xấu, khách hàng khiếu nại nhưng luồng mua vẫn xong.", "Không áp dụng được voucher sinh nhật; Nút hành động đổi trả méo xẹo, dropdown không đóng khi click ngoài.", "Khắc phục trong 24h"),
        ("Minor", "Lỗi giao diện (UI), sai chính tả, khoảng cách padding, thiếu tooltip hoặc icon lệch nhẹ.", "Không ảnh hưởng nghiệp vụ cốt lõi, chỉ làm giảm tính thẩm mỹ chuyên nghiệp.", "Màu sắc nút chưa chuẩn token; Tiêu đề cột chưa căn giữa; Text tràn chữ nhẹ trên mobile.", "Khắc phục đợt sau (Sprint tới)"),
    ]

    for r_idx, row in enumerate(sev_data, 20):
        for c_idx, val in enumerate(row, 1):
            c = ws1.cell(row=r_idx, column=c_idx, value=val)
            c.font = cell_font
            c.border = cell_border
            if c_idx == 1:
                c.font = cell_font_bold
                c.alignment = align_center
                if val == "Blocker": c.fill = fail_fill; c.font = fail_font
                elif val == "Critical": c.fill = fail_fill; c.font = Font(name=font_family, size=9.5, bold=True, color="B91C1C")
                elif val == "Major": c.fill = blocked_fill; c.font = blocked_font
                else: c.fill = pass_fill; c.font = pass_font
            elif c_idx == 5:
                c.alignment = align_center
                c.font = cell_font_bold
            else:
                c.alignment = align_left_wrap
        ws1.row_dimensions[r_idx].height = 26

    # Column widths for Sheet 1
    ws1.column_dimensions["A"].width = 14
    ws1.column_dimensions["B"].width = 18
    ws1.column_dimensions["C"].width = 24
    ws1.column_dimensions["D"].width = 44
    ws1.column_dimensions["E"].width = 28
    ws1.column_dimensions["F"].width = 14
    ws1.column_dimensions["G"].width = 14
    ws1.column_dimensions["H"].width = 14
    ws1.column_dimensions["I"].width = 14
    ws1.column_dimensions["J"].width = 14
    ws1.column_dimensions["K"].width = 18


    # =========================================================================
    # SHEET 2: KỊCH BẢN UAT CHI TIẾT (Detailed Test Cases)
    # =========================================================================
    ws2 = wb.create_sheet(title="Kịch bản UAT Chi tiết")
    ws2.views.sheetView[0].showGridLines = True

    # Title & Metadata
    ws2.merge_cells("A1:L1")
    ws2["A1"] = "DANH SÁCH CHI TIẾT 42 KỊCH BẢN UAT (USER ACCEPTANCE TESTING) - VELURA E-COMMERCE"
    ws2["A1"].font = title_font
    ws2["A1"].fill = brand_primary_fill
    ws2["A1"].alignment = Alignment(horizontal="left", vertical="center", indent=1)
    ws2.row_dimensions[1].height = 36

    ws2["A2"] = "Tổng số Test Cases:"
    ws2["A2"].font = cell_font_bold
    ws2["B2"] = "=COUNTA(A4:A45)"
    ws2["B2"].font = cell_font_bold
    ws2["C2"] = "Kịch bản"
    ws2["C2"].font = cell_font

    tc_headers = [
        "Mã TC", "Quy trình Core", "Tester", "Tên Kịch bản / Luồng thực hiện", 
        "Tiền điều kiện (Preconditions)", "Các bước thực hiện (Test Steps)", 
        "Dữ liệu kiểm thử (Test Data)", "Kết quả mong đợi (Expected Results)", 
        "Kết quả thực tế (Actual Result)", "Trạng thái", "Mức độ", "Ghi chú / Bug ID"
    ]

    for col_idx, h in enumerate(tc_headers, 1):
        cell = ws2.cell(row=3, column=col_idx, value=h)
        cell.font = table_header_font
        cell.fill = brand_dark_fill
        cell.alignment = align_center
        cell.border = header_border
    ws2.row_dimensions[3].height = 28

    # 42 Test Cases Data
    test_cases = [
        # Tester 1: Nguyễn Thị Ánh (Tìm kiếm, PDP, Cart, Stripe)
        ("TC-CORE-01", "Tìm kiếm & Khám phá SP", "Tester 01", "Tìm kiếm sản phẩm bằng từ khóa văn bản và xem gợi ý", 
         "User đang ở trang chủ Storefront", 
         "1. Nhập từ khóa 'áo polo' vào ô tìm kiếm ở Header.\n2. Quan sát dropdown gợi ý sản phẩm tức thì.\n3. Nhấn Enter hoặc click icon kính lúp.", 
         "Từ khóa: 'áo polo'", 
         "Hệ thống hiển thị danh sách sản phẩm khớp với từ khóa 'áo polo', hiển thị đúng giá, số lượng kết quả và hình ảnh đại diện.", 
         "", "Untested", "Major", ""),
        
        ("TC-CORE-02", "Tìm kiếm & Khám phá SP", "Tester 01", "Tìm kiếm sản phẩm bằng hình ảnh AI (Visual Search)", 
         "User có ảnh chụp mẫu áo sơ mi lụa trong máy", 
         "1. Click icon Camera cạnh thanh tìm kiếm.\n2. Tải lên tệp ảnh mẫu trang phục (JPG/PNG).\n3. Chờ AI xử lý nhận diện đặc trưng và trả kết quả.", 
         "File ảnh: so-mi-nam-trang.jpg", 
         "Hệ thống phân tích ảnh qua AI Gemini, tự động trích xuất các sản phẩm tương đồng về màu sắc, chất liệu và phom dáng.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-03", "Tìm kiếm & Khám phá SP", "Tester 01", "Bộ lọc sản phẩm đa chiều theo Danh mục, Size, Màu, Giá", 
         "Đang ở trang Danh mục Sản phẩm /shop", 
         "1. Chọn danh mục 'Áo nam'.\n2. Tích chọn Size 'L', Màu 'Xanh Navy'.\n3. Kéo thanh khoảng giá từ 200.000đ - 500.000đ.\n4. Chọn sắp xếp 'Giá tăng dần'.", 
         "Filter: Nam, Size L, Màu Navy, 200k-500k", 
         "Danh sách cập nhật ngay lập tức (không reload trang), chỉ hiển thị các sản phẩm thỏa mãn đồng thời tất cả các tiêu chí.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-04", "Chi tiết sản phẩm (PDP)", "Tester 01", "Chuyển đổi biến thể Size/Màu và khóa nút khi hết hàng", 
         "Sản phẩm 'Áo Thun Cotton' có màu Đen - Size M tồn kho = 0, Size L còn 5 cái", 
         "1. Vào trang chi tiết sản phẩm 'Áo Thun Cotton'.\n2. Click chọn màu 'Đen'.\n3. Click chọn Size 'M'.\n4. Quan sát nút Mua ngay & Thêm giỏ hàng.\n5. Click chuyển sang Size 'L'.", 
         "SKU: AT-BLK-M (hết hàng), AT-BLK-L (còn hàng)", 
         "Khi chọn Size M hết hàng: Nút chuyển sang trạng thái 'Hết hàng' và bị Disable (không click được). Khi chọn Size L: Nút kích hoạt lại bình thường.", 
         "", "Untested", "Critical", ""),

        ("TC-CORE-05", "Giỏ hàng & Đặt hàng", "Tester 01", "Thêm nhanh vào giỏ hàng từ thẻ sản phẩm (Quick Add)", 
         "Khách đang duyệt trang danh sách sản phẩm", 
         "1. Rê chuột vào thẻ sản phẩm 'Quần Khaki'.\n2. Bấm nút 'Thêm vào giỏ'.\n3. Quan sát thông báo Toast và Badge giỏ hàng ở Header.", 
         "SP: Quần Khaki Slimfit, Size L", 
         "Sản phẩm được thêm ngay vào giỏ hàng mà KHÔNG bị chuyển trang; số lượng trên icon giỏ hàng tăng thêm 1.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-06", "Giỏ hàng & Đặt hàng", "Tester 01", "Nút 'Mua ngay' chuyển thẳng vào trang Thanh toán", 
         "Khách đang xem chi tiết sản phẩm", 
         "1. Chọn Size và Màu sản phẩm.\n2. Click nút 'Mua ngay'.", 
         "SP: Áo Len Merino, Size XL", 
         "Hệ thống lập tức điều hướng khách đến trang `/checkout/shipping` với đúng sản phẩm vừa chọn trong tóm tắt đơn hàng.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-07", "Giỏ hàng & Đặt hàng", "Tester 01", "Chỉnh sửa số lượng, đổi size/màu trực tiếp trong Giỏ hàng", 
         "Giỏ hàng đang có 2 sản phẩm", 
         "1. Mở trang Giỏ hàng `/cart`.\n2. Tăng số lượng SP 1 từ 1 lên 3 cái.\n3. Đổi size SP 2 từ M sang L ngay dropdown trong giỏ.\n4. Xóa 1 sản phẩm khỏi giỏ.", 
         "Giỏ hàng hiện tại", 
         "Tổng tiền giỏ hàng tự động tính toán lại chính xác theo thời gian thực; biến thể size cập nhật đúng mà không cần ra ngoài chọn lại.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-08", "Thanh toán Online", "Tester 01", "Thanh toán trực tuyến thành công bằng thẻ tín dụng quốc tế Stripe", 
         "Khách hàng ở bước Thanh toán `/checkout/payment`, giỏ hàng hợp lệ", 
         "1. Nhập địa chỉ nhận hàng.\n2. Chọn phương thức 'Thẻ tín dụng / Ghi nợ quốc tế (Stripe)'.\n3. Nhập thông tin thẻ test Stripe hợp lệ.\n4. Bấm 'Hoàn tất đặt hàng'.", 
         "Thẻ test Stripe: 4242 4242 4242 4242, CVC: 123", 
         "Cổng Stripe xác thực thành công, hệ thống trừ tồn kho, chuyển hướng đến trang Đặt hàng thành công (`/order-success`), gửi email xác nhận.", 
         "", "Untested", "Blocker", ""),

        ("TC-CORE-09", "Thanh toán Online", "Tester 01", "Xử lý thẻ lỗi / từ chối thanh toán Stripe và bảo toàn giỏ hàng", 
         "Khách chọn thanh toán Stripe", 
         "1. Nhập thông tin thẻ thanh toán bị từ chối / hết hạn.\n2. Bấm 'Hoàn tất đặt hàng'.", 
         "Thẻ test Stripe Declined: 4000 0000 0000 0002", 
         "Hiển thị thông báo lỗi rõ ràng ('Thẻ của bạn đã bị từ chối'), KHÔNG tạo đơn rác, KHÔNG trừ tồn kho, giỏ hàng của khách vẫn được giữ nguyên.", 
         "", "Untested", "Critical", ""),

        # Tester 2: Trần Quốc Bảo (Member VIP, Birthday, COD, Services)
        ("TC-CORE-10", "Tài khoản Thành viên", "Tester 02", "Đăng ký tài khoản, đăng nhập & cập nhật ngày sinh nhật", 
         "Khách hàng mới chưa có tài khoản", 
         "1. Bấm Đăng ký tài khoản mới bằng Email/Mật khẩu.\n2. Đăng nhập vào hệ thống.\n3. Vào mục 'Thông tin tài khoản', thiết lập Ngày sinh nhật.\n4. Bấm 'Lưu thay đổi'.", 
         "Email: test.vip2026@gmail.com, DOB: Ngày hôm nay", 
         "Hệ thống lưu thông tin thành công, hiển thị badge hạng thành viên mới và ghi nhận ngày sinh nhật vào hồ sơ khách hàng.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-11", "Khuyến mãi & Sinh nhật", "Tester 02", "Nhận và áp dụng mã Voucher sinh nhật tự động HPBD2026", 
         "Tài khoản có ngày sinh nhật trùng ngày hiện tại", 
         "1. Đăng nhập tài khoản ngày sinh nhật.\n2. Vào mục 'Ví Voucher / Ưu đãi của tôi'.\n3. Kiểm tra mã voucher sinh nhật `HPBD2026`.\n4. Thêm sản phẩm vào giỏ hàng và áp dụng mã.", 
         "Mã Voucher: HPBD2026", 
         "Hệ thống hiển thị voucher sinh nhật trong ví; khi áp mã vào đơn hàng được giảm đúng số tiền/phần trăm ưu đãi sinh nhật.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-12", "Khuyến mãi & Sinh nhật", "Tester 02", "Kiểm tra giới hạn & điều kiện áp dụng Voucher khuyến mãi", 
         "Có mã voucher yêu cầu đơn tối thiểu 500.000đ", 
         "1. Thêm sản phẩm trị giá 300.000đ vào giỏ.\n2. Nhập mã voucher và bấm 'Áp dụng'.\n3. Thêm tiếp SP để tổng tiền > 500.000đ và áp dụng lại.", 
         "Mã Voucher: VELURA50 (Min 500k, giảm 50k)", 
         "Khi đơn 300k: Báo lỗi 'Đơn hàng chưa đạt giá trị tối thiểu 500.000đ'. Khi đơn > 500k: Áp dụng thành công, trừ đúng 50.000đ.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-13", "Đặt hàng & Dịch vụ", "Tester 02", "Đặt hàng thanh toán khi nhận hàng (COD) thành công", 
         "Khách chọn sản phẩm và vào thanh toán", 
         "1. Nhập thông tin người nhận (Họ tên, SĐT, Địa chỉ chi tiết).\n2. Chọn phương thức 'Thanh toán khi nhận hàng (COD)'.\n3. Bấm 'Xác nhận đặt hàng'.", 
         "COD, SĐT: 0912345678, Địa chỉ: Hà Nội", 
         "Đơn hàng được khởi tạo thành công với trạng thái `PENDING_CONFIRMATION`, mã đơn hàng sinh tự động `#ORD-xxxx`, tồn kho được giữ chỗ.", 
         "", "Untested", "Blocker", ""),

        ("TC-CORE-14", "Dịch vụ giá trị gia tăng", "Tester 02", "Tùy chọn đóng gói quà tặng Coolmate & thiệp chúc mừng", 
         "Khách hàng ở bước Thanh toán", 
         "1. Tích chọn 'Gói quà tặng (Gift Box)'.\n2. Nhập tên người nhận quà và lời chúc mừng.\n3. Đặt hàng.", 
         "Gift Box: Nam, Lời chúc: 'Chúc mừng sinh nhật bạn thân!'", 
         "Thông tin gói quà và lời chúc hiển thị rõ trong tóm tắt đơn hàng của khách và xuất hiện trên chi tiết đơn hàng của Admin.", 
         "", "Untested", "Minor", ""),

        ("TC-CORE-15", "Dịch vụ giá trị gia tăng", "Tester 02", "Yêu cầu xuất hóa đơn điện tử VAT cho doanh nghiệp", 
         "Khách hàng ở bước Thanh toán", 
         "1. Tích chọn 'Yêu cầu xuất hóa đơn VAT'.\n2. Nhập Tên công ty, Mã số thuế, Địa chỉ công ty, Email nhận hóa đơn.\n3. Đặt hàng.", 
         "MST: 0101234567, Cty TNHH Thời Trang Quốc Tế", 
         "Hệ thống validate đúng định dạng MST; thông tin xuất hóa đơn được đính kèm vào metadata đơn hàng để kế toán xử lý.", 
         "", "Untested", "Minor", ""),

        ("TC-CORE-16", "Quản lý đơn hàng khách", "Tester 02", "Khách hàng tự hủy đơn hàng khi đơn chưa được xử lý", 
         "Khách hàng có đơn vừa đặt ở trạng thái PENDING", 
         "1. Vào 'Lịch sử đơn hàng' trong tài khoản khách.\n2. Mở đơn hàng vừa đặt.\n3. Bấm nút 'Hủy đơn hàng'.\n4. Chọn lý do hủy và xác nhận.", 
         "Đơn #ORD-xxxx (trạng thái: PENDING)", 
         "Đơn hàng chuyển sang trạng thái `CANCELLED`, số lượng tồn kho của các sản phẩm trong đơn được hoàn trả tự động vào kho.", 
         "", "Untested", "Critical", ""),

        # Tester 3: Lê Hoàng Châu (RMA Đổi trả, Review sản phẩm, Khách vãng lai OTP)
        ("TC-CORE-17", "Quy trình Đổi trả (RMA)", "Tester 03", "Khách hàng tạo yêu cầu Trả hàng - Hoàn tiền (Refund)", 
         "Khách hàng có đơn hàng ở trạng thái `DELIVERED` trong vòng 7 ngày", 
         "1. Vào chi tiết đơn hàng đã giao thành công.\n2. Bấm nút 'Yêu cầu đổi / trả hàng'.\n3. Chọn loại yêu cầu 'Hoàn tiền'.\n4. Chọn sản phẩm cần hoàn, nhập số tài khoản ngân hàng nhận tiền.\n5. Gửi yêu cầu.", 
         "Đơn #ORD-xxxx, Loại: Hoàn tiền, STK Vietcombank", 
         "Tạo thành công phiếu đổi trả `#RET-xxxx` với trạng thái `REQUESTED`, số tiền hoàn dự kiến hiển thị đúng giá mua ban đầu.", 
         "", "Untested", "Blocker", ""),

        ("TC-CORE-18", "Quy trình Đổi trả (RMA)", "Tester 03", "Khách hàng tạo yêu cầu Đổi kích cỡ / màu sắc (Exchange)", 
         "Khách hàng có đơn đã nhận hàng, sản phẩm mặc không vừa size", 
         "1. Vào chi tiết đơn hàng, chọn 'Yêu cầu đổi / trả hàng'.\n2. Chọn loại yêu cầu 'Đổi sản phẩm'.\n3. Chọn size mới mong muốn (Ví dụ: từ Size M sang L).\n4. Gửi yêu cầu.", 
         "Loại: Đổi hàng, Đổi từ M sang L", 
         "Tạo thành công phiếu `#RET-xxxx` với trạng thái `REQUESTED`, ghi nhận rõ sản phẩm cần đổi và kích cỡ mong muốn.", 
         "", "Untested", "Blocker", ""),

        ("TC-CORE-19", "Quy trình Đổi trả (RMA)", "Tester 03", "Tải lên tệp hình ảnh bằng chứng tình trạng sản phẩm lỗi", 
         "Khách đang ở form tạo phiếu đổi trả", 
         "1. Nhấn nút tải ảnh bằng chứng sản phẩm.\n2. Chọn 1-3 ảnh chụp thực tế tình trạng áo bị lỗi đường may.\n3. Quan sát xem trước (Preview) ảnh và gửi form.", 
         "2 file ảnh: loi-rach-vai.jpg, loi-tem-mac.jpg", 
         "Hình ảnh được tải lên thành công, hiển thị thumbnail rõ nét; Admin mở phiếu có thể click xem ảnh phóng to bằng Lightbox.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-20", "Quy trình Đổi trả (RMA)", "Tester 03", "Tra cứu tiến độ xử lý phiếu đổi trả theo thời gian thực", 
         "Khách hàng đã có phiếu đổi trả đang được CSKH xử lý", 
         "1. Vào trang 'Theo dõi đổi trả' `/returns/track`.\n2. Nhập mã phiếu `#RET-xxxx` và SĐT đặt hàng.\n3. Quan sát timeline các bước xử lý.", 
         "Mã phiếu: #RET-xxxx", 
         "Hiển thị timeline trực quan các bước: Đã tiếp nhận -> Đang liên hệ -> Chờ gửi hàng -> Đang chuyển về -> Đã nhận & QA -> Hoàn tiền/Giao đổi -> Hoàn tất.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-21", "Đánh giá & Review", "Tester 03", "Khách hàng đăng nhập đánh giá sản phẩm kèm ảnh thực tế", 
         "Khách đã mua và nhận sản phẩm thành công", 
         "1. Vào trang chi tiết sản phẩm hoặc Lịch sử mua hàng.\n2. Nhấn 'Viết đánh giá'.\n3. Chọn 5 sao, nhập nhận xét khen chất vải.\n4. Upload 1 ảnh mặc thử sản phẩm.\n5. Bấm 'Gửi đánh giá'.", 
         "5 sao, nhận xét: 'Vải mát mịn, đường may rất đẹp', 1 ảnh", 
         "Đánh giá gửi thành công, thông báo cảm ơn khách hàng; đánh giá xuất hiện trên trang chi tiết sản phẩm.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-22", "Đánh giá & Review", "Tester 03", "Khách vãng lai xác thực SĐT/Email OTP để đánh giá đơn hàng", 
         "Khách mua hàng không tạo tài khoản (mua vãng lai), đơn đã giao", 
         "1. Vào trang Đánh giá sản phẩm.\n2. Chọn luồng 'Đánh giá qua đơn hàng đã mua'.\n3. Nhập Số điện thoại đặt hàng.\n4. Nhập mã OTP gửi về Email/SMS để xác thực.\n5. Hệ thống hiển thị các đơn hàng tương ứng.\n6. Chọn sản phẩm và gửi đánh giá.", 
         "SĐT vãng lai, OTP: 123456", 
         "Hệ thống xác thực đúng chủ đơn hàng, cho phép khách vãng lai đánh giá chuẩn luồng bảo mật mà không bắt buộc đăng nhập tài khoản.", 
         "", "Untested", "Critical", ""),

        # Tester 4: Phạm Văn Dũng (Admin Đơn hàng, Xác nhận COD, Kho Fulfillment & QA)
        ("TC-CORE-23", "Quản lý Đơn hàng Admin", "Tester 04", "Tiếp nhận đơn hàng mới và lọc đơn hàng theo trạng thái/thanh toán", 
         "Admin đăng nhập tài khoản Kho / Vận hành", 
         "1. Vào Admin Portal -> menu 'Đơn hàng' (`/admin/orders`).\n2. Lọc đơn hàng theo phương thức 'COD' và trạng thái 'Chờ xác nhận'.\n3. Kiểm tra danh sách hiển thị.", 
         "Filter: COD, Pending", 
         "Danh sách hiển thị chính xác các đơn COD mới nhất, thông tin khách hàng, số điện thoại, tổng tiền lining-nums rõ ràng.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-24", "Quản lý Đơn hàng Admin", "Tester 04", "Ghi nhận cuộc gọi xác nhận đơn COD cho khách hàng rủi ro", 
         "Đơn hàng COD giá trị cao cần gọi xác nhận", 
         "1. Bấm nút gọi xác nhận hoặc mở Drawer đơn hàng.\n2. Click 'Ghi nhận cuộc gọi'.\n3. Chọn kết quả: 'Đã liên lạc - Khách xác nhận lấy hàng'.\n4. Lưu thông tin.", 
         "Đơn COD #ORD-xxxx, Kết quả: Thành công", 
         "Hệ thống lưu log CSKH vào đơn hàng, đơn được mở khóa để chuyển tiếp sang trạng thái 'Đang chuẩn bị hàng'.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-25", "Vận hành Kho Fulfillment", "Tester 04", "In phiếu xuất kho, đóng gói & bàn giao đơn vị vận chuyển", 
         "Đơn hàng đã được xác nhận hợp lệ", 
         "1. Chọn đơn hàng trong danh sách.\n2. Bấm 'Xuất kho & Giao hàng'.\n3. Nhập mã vận đơn (Tracking Code) của bên chuyển phát.\n4. Xác nhận.", 
         "Tracking: VNPOST-987654321", 
         "Đơn hàng chuyển trạng thái sang `SHIPPING` (Đang giao hàng), hệ thống gửi email thông báo mã vận đơn cho khách hàng tra cứu.", 
         "", "Untested", "Blocker", ""),

        ("TC-CORE-26", "Vận hành Kho Fulfillment", "Tester 04", "Cập nhật giao hàng thành công (Delivered) hoặc Thất bại", 
         "Đơn hàng đang ở trạng thái `SHIPPING`", 
         "1. Tìm đơn hàng theo mã vận đơn.\n2. Chọn thao tác 'Xác nhận giao thành công'.\n3. Kiểm tra đơn hàng hoàn tất.", 
         "Đơn #ORD-xxxx", 
         "Đơn chuyển sang `DELIVERED`, hệ thống kích hoạt chính sách bảo hành / đổi trả 15 ngày kể từ thời điểm này.", 
         "", "Untested", "Critical", ""),

        ("TC-CORE-27", "Vận hành Kho RMA", "Tester 04", "Tiếp nhận kiện hàng đổi trả từ shipper gửi về kho", 
         "Phiếu đổi trả đang ở trạng thái `RETURN_IN_TRANSIT` (Khách đã gửi hàng)", 
         "1. Vào Admin -> menu 'Đổi & Trả hàng'.\n2. Mở dropdown thao tác của phiếu.\n3. Chọn tác vụ 'Nhận hàng & QA'.", 
         "Phiếu #RET-xxxx (Status: RETURN_IN_TRANSIT)", 
         "Mở modal kiểm định QA và ghi nhận kiện hàng đã cập bến kho thành công (`RECEIVED`).", 
         "", "Untested", "Blocker", ""),

        ("TC-CORE-28", "Kiểm định chất lượng QA", "Tester 04", "Kiểm tra chất lượng hàng đổi trả (QA Pass / QA Fail)", 
         "Kiện hàng đổi trả đã mở tại bàn kiểm định của kho", 
         "1. Kiểm tra tem mác, độ mới của áo.\n2. Chọn kết quả QA: 'Đạt chuẩn nhập lại (QA Pass)'.\n3. Nhập ghi chú kiểm định: 'Hàng nguyên tem, lỗi chỉ may chuẩn xác'.\n4. Lưu kết quả.", 
         "Kết quả: qa_pass, Note >= 10 ký tự", 
         "Phiếu đổi trả được duyệt QA thành công, hệ thống mở khóa bước tiếp theo (Cho phép CSKH duyệt hoàn tiền hoặc xuất hàng đổi).", 
         "", "Untested", "Blocker", ""),

        # Tester 5: Đặng Thị Mai (CSKH, Duyệt Đổi trả, Hoàn tiền Stripe/Manual, Support)
        ("TC-CORE-29", "CSKH Quản lý Đổi trả", "Tester 05", "Tiếp nhận phiếu mới và ghi nhận liên hệ khách hàng", 
         "Phiếu đổi trả ở trạng thái `REQUESTED`", 
         "1. Vào Admin -> 'Đổi & Trả hàng'.\n2. Bấm nút Thao tác [ ✏ ] của dòng phiếu.\n3. Chọn 'Liên hệ khách hàng'.\n4. Chọn kết quả liên lạc: 'Đã trao đổi - Thỏa thuận phương án'.\n5. Lưu biên bản.", 
         "Phiếu #RET-xxxx, Ghi chú CSKH", 
         "Phiếu chuyển trạng thái sang `CONTACTING`, hiển thị badge phân loại và thời gian liên lạc rõ ràng.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-30", "CSKH Quản lý Đổi trả", "Tester 05", "Phê duyệt Hoàn tiền với số tiền cố định theo giá mua", 
         "Phiếu ở trạng thái `CONTACTING` và loại yêu cầu là hoàn tiền", 
         "1. Bấm nút Thao tác [ ✏ ], chọn 'Duyệt hoàn tiền'.\n2. Quan sát khung hiển thị số tiền hoàn cố định (không cho sửa tay).\n3. Nhập ghi chú duyệt tối thiểu 10 ký tự.\n4. Bấm 'Xác nhận duyệt'.", 
         "Số tiền hoàn cố định = Giá trị mua của món hàng", 
         "Số tiền hoàn được khóa cứng chính xác (chuẩn kế toán, tránh gian lận); phiếu chuyển sang `WAITING_RETURN` (Chờ khách gửi hàng).", 
         "", "Untested", "Critical", ""),

        ("TC-CORE-31", "CSKH Quản lý Đổi trả", "Tester 05", "Phê duyệt Đổi hàng kích cỡ / màu sắc mới cho khách", 
         "Phiếu ở trạng thái `CONTACTING` và loại yêu cầu là đổi hàng", 
         "1. Bấm nút Thao tác [ ✏ ], chọn 'Duyệt đổi hàng'.\n2. Xác nhận thông tin sản phẩm và size mới.\n3. Nhập ghi chú thỏa thuận đổi.\n4. Xác nhận.", 
         "Đổi sang size L", 
         "Phiếu chuyển sang `WAITING_RETURN`, hệ thống gửi email hướng dẫn khách hàng đóng gói và gửi hàng về kho Velura.", 
         "", "Untested", "Critical", ""),

        ("TC-CORE-32", "CSKH Quản lý Đổi trả", "Tester 05", "Từ chối yêu cầu đổi trả không hợp lệ kèm lý do minh bạch", 
         "Phiếu đổi trả do khách dùng sai quy cách / rách do ngoại lực", 
         "1. Bấm nút Thao tác [ ✏ ], chọn 'Từ chối yêu cầu'.\n2. Nhập lý do từ chối rõ ràng (>= 10 ký tự).\n3. Bấm xác nhận từ chối.", 
         "Lý do: 'Sản phẩm đã qua sử dụng và bị cắt mác, không thuộc diện đổi trả'", 
         "Phiếu đổi trả kết thúc với trạng thái `REJECTED`, lý do từ chối được lưu trữ và hiển thị minh bạch cho khách tra cứu.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-33", "Xử lý Thanh toán Hoàn", "Tester 05", "Kích hoạt hoàn tiền tự động qua cổng thanh toán Stripe", 
         "Đơn hàng ban đầu thanh toán bằng thẻ Stripe, hàng đổi trả đã QA Pass", 
         "1. Bấm nút Thao tác [ ✏ ], chọn 'Hoàn tiền qua Stripe'.\n2. Xác nhận lệnh hoàn tiền qua cổng.", 
         "Refund qua Stripe Gateway API", 
         "Cổng Stripe thực hiện refund thành công, ghi nhận mã Refund ID, trạng thái chuyển `REFUNDED` -> `COMPLETED`, tiền về thẻ của khách.", 
         "", "Untested", "Blocker", ""),

        ("TC-CORE-34", "Xử lý Thanh toán Hoàn", "Tester 05", "Ghi nhận chuyển khoản hoàn tiền thủ công cho đơn COD", 
         "Đơn hàng ban đầu là COD, hàng đổi trả đã QA Pass", 
         "1. Bấm nút Thao tác [ ✏ ], chọn 'Ghi nhận hoàn tiền'.\n2. Nhập mã tham chiếu chuyển khoản ngân hàng (Bank Ref No).\n3. Tải lên ảnh bill chuyển tiền thành công.\n4. Xác nhận.", 
         "Mã giao dịch ngân hàng: VCB-20261006-8899", 
         "Hệ thống lưu chứng từ hoàn tiền, phiếu chuyển trạng thái `REFUNDED`, gửi email thông báo tiền đã hoàn vào tài khoản khách.", 
         "", "Untested", "Blocker", ""),

        ("TC-CORE-35", "Fulfillment Đổi hàng", "Tester 05", "Soạn hàng thay thế & Xác nhận hoàn tất quy trình đổi hàng", 
         "Phiếu đổi hàng đã QA Pass", 
         "1. Bấm nút Thao tác [ ✏ ], chọn 'Soạn hàng đổi'.\n2. Nhập mã vận đơn gửi hàng mới cho khách.\n3. Khi khách nhận được, chọn 'Hoàn tất đổi hàng'.", 
         "Mã vận đơn đổi: GHTK-55443322", 
         "Phiếu đổi hàng chuyển sang `COMPLETED`, hệ thống xuất kho bù sản phẩm mới và đóng hồ sơ đổi trả thành công.", 
         "", "Untested", "Blocker", ""),

        ("TC-CORE-36", "Hỗ trợ khách hàng (CSKH)", "Tester 05", "Quản lý và giải quyết Support Ticket từ khách hàng", 
         "Có ticket thắc mắc của khách hàng gửi qua web", 
         "1. Vào tab 'Phiếu hỗ trợ' (`/admin/returns`).\n2. Mở ticket cần xử lý.\n3. Nhập nội dung phản hồi CSKH.\n4. Đổi trạng thái ticket sang 'Đã giải quyết'.", 
         "Ticket ID: #TCK-xxxx, Nội dung: Tư vấn bảo quản áo lụa", 
         "Nội dung phản hồi được lưu trữ, khách hàng nhận được email thông báo giải đáp từ bộ phận CSKH.", 
         "", "Untested", "Major", ""),

        # Tester 6: Vũ Minh Tuấn (Catalog, Inventory, Promotion, Review Moderation, RBAC)
        ("TC-CORE-37", "Quản trị Sản phẩm", "Tester 06", "Tạo mới sản phẩm với đầy đủ biến thể Màu/Size/SKU", 
         "Admin đăng nhập quyền Quản trị Catalog", 
         "1. Vào Admin -> 'Sản phẩm' (`/admin/products`).\n2. Bấm 'Thêm sản phẩm mới'.\n3. Nhập tên, danh mục, giá niêm yết, giá khuyến mãi.\n4. Tạo ma trận biến thể: Màu (Trắng, Đen) x Size (S, M, L).\n5. Thiết lập số lượng tồn cho từng SKU.\n6. Lưu sản phẩm.", 
         "SP: Polo Velura Signature, 6 SKUs", 
         "Sản phẩm được lưu thành công vào CSDL, hiển thị đúng trên trang chủ và trang danh mục của người dùng.", 
         "", "Untested", "Blocker", ""),

        ("TC-CORE-38", "Quản trị Tồn kho", "Tester 06", "Thiết lập tồn kho = 0 và kiểm tra hệ thống tự khóa mua trên Storefront", 
         "Sản phẩm đang bán bình thường", 
         "1. Vào Admin điều chỉnh tồn kho của SKU 'Polo Signature - Đen - L' về 0.\n2. Lưu thay đổi.\n3. Mở tab trình duyệt ẩn danh vào PDP của sản phẩm đó.\n4. Chọn màu Đen và Size L.", 
         "Tồn kho SKU = 0", 
         "Trên web người dùng, nút 'Mua ngay' và 'Thêm giỏ hàng' tự động bị vô hiệu hóa (disabled), hiển thị nhãn 'Tạm hết hàng', ngăn chặn đặt vượt tồn.", 
         "", "Untested", "Critical", ""),

        ("TC-CORE-39", "Trợ lý AI Catalog", "Tester 06", "Sử dụng Trợ lý AI tạo mô tả sản phẩm và tối ưu SEO", 
         "Admin đang tạo hoặc sửa sản phẩm", 
         "1. Nhập tên sản phẩm và các thuộc tính chất liệu (100% Cotton Pima).\n2. Bấm nút 'AI Gợi ý mô tả'.\n3. Kiểm tra văn phong, thẻ Meta Title và Meta Description do AI tạo.\n4. Bấm áp dụng.", 
         "Chất liệu: Cotton Pima 220gsm", 
         "AI sinh ra mô tả sang trọng, đúng văn phong thời trang cao cấp Velura, tự động điền các thẻ SEO chuẩn Google.", 
         "", "Untested", "Minor", ""),

        ("TC-CORE-40", "Quản lý Khuyến mãi", "Tester 06", "Tạo chiến dịch Flash Sale và tạo mã Voucher giảm giá mới", 
         "Admin vào phân hệ 'Khuyến mãi' (`/admin/promotions`)", 
         "1. Tạo Chiến dịch 'Mùa hè rực rỡ' (thời gian bắt đầu, kết thúc).\n2. Tạo Mã giảm giá mới `SUMMER2026` giảm 20%, tối đa 100k, đơn tối thiểu 300k, giới hạn 100 lượt.\n3. Kích hoạt mã.", 
         "Voucher: SUMMER2026, Giảm 20% max 100k", 
         "Voucher được kích hoạt trên hệ thống; khách hàng áp mã `SUMMER2026` ở giỏ hàng sẽ được chiết khấu chính xác theo công thức.", 
         "", "Untested", "Critical", ""),

        ("TC-CORE-41", "Kiểm duyệt Đánh giá", "Tester 06", "Hệ thống tự nhận diện từ ngữ nhạy cảm / spam và Admin xử lý", 
         "Có đánh giá mới chứa từ ngữ thô tục / spam", 
         "1. Vào Admin -> 'Đánh giá' (`/admin/reviews`).\n2. Kiểm tra tab 'Cần xử lý gấp'.\n3. Quan sát cảnh báo tự động bôi đỏ từ nhạy cảm.\n4. Chọn thao tác 'Ẩn đánh giá' hoặc 'Phản hồi'.", 
         "Review chứa từ khóa nhạy cảm / spam", 
         "Hệ thống phát hiện chính xác từ cấm, gắn cờ cảnh báo; Admin có thể ẩn đánh giá vi phạm khỏi trang sản phẩm ngay lập tức.", 
         "", "Untested", "Major", ""),

        ("TC-CORE-42", "Phân quyền & Audit Logs", "Tester 06", "Kiểm tra phân quyền tài khoản (RBAC) và Nhật ký thao tác (Audit)", 
         "Admin kiểm tra an ninh và vận hành", 
         "1. Vào Admin -> 'Tài khoản' (`/admin/accounts`).\n2. Kiểm tra danh sách nhân sự và phân vai trò: Admin, CSKH, Kho.\n3. Đăng nhập bằng tài khoản Kho: Kiểm tra không truy cập được vào đổi mật khẩu / xóa sản phẩm.\n4. Mở 'Nhật ký hệ thống' (`/admin/logs`) kiểm tra lịch sử thao tác.", 
         "Tài khoản Kho vs Tài khoản Admin", 
         "Quyền hạn được kiểm soát nghiêm ngặt theo vai trò (RBAC); mọi thao tác duyệt đơn, hoàn tiền, sửa giá đều được ghi vết (Audit trail) kèm thời gian và người thực hiện.", 
         "", "Untested", "Critical", "")
    ]

    for r_idx, tc in enumerate(test_cases, 4):
        for c_idx, val in enumerate(tc, 1):
            cell = ws2.cell(row=r_idx, column=c_idx, value=val)
            cell.font = cell_font
            cell.border = cell_border
            
            if c_idx == 1: # Mã TC
                cell.font = code_font
                cell.alignment = align_center
            elif c_idx == 2: # Quy trình
                cell.font = cell_font_bold
                cell.alignment = align_left
            elif c_idx == 3: # Tester
                cell.font = cell_font_bold
                cell.alignment = align_center
            elif c_idx == 4: # Tên kịch bản
                cell.font = cell_font_bold
                cell.alignment = align_left_wrap
            elif c_idx in [5, 6, 7, 8]: # Preconditions, Steps, Data, Expected
                cell.alignment = align_left_wrap
            elif c_idx == 9: # Actual
                cell.alignment = align_left_wrap
            elif c_idx == 10: # Status
                cell.alignment = align_center
                if val == "Pass": cell.fill = pass_fill; cell.font = pass_font
                elif val == "Fail": cell.fill = fail_fill; cell.font = fail_font
                elif val == "Blocked": cell.fill = blocked_fill; cell.font = blocked_font
                else: cell.fill = untested_fill; cell.font = untested_font
            elif c_idx == 11: # Severity
                cell.alignment = align_center
                cell.font = cell_font_bold
                if val == "Blocker": cell.font = Font(name=font_family, size=9.5, bold=True, color="991B1B")
                elif val == "Critical": cell.font = Font(name=font_family, size=9.5, bold=True, color="DC2626")
                elif val == "Major": cell.font = Font(name=font_family, size=9.5, bold=True, color="D97706")
                else: cell.font = Font(name=font_family, size=9.5, bold=True, color="16A34A")
            elif c_idx == 12: # Note
                cell.alignment = align_left_wrap

        ws2.row_dimensions[r_idx].height = 48

    # Column Widths for Sheet 2
    ws2.column_dimensions["A"].width = 15 # Mã TC
    ws2.column_dimensions["B"].width = 24 # Quy trình
    ws2.column_dimensions["C"].width = 14 # Tester
    ws2.column_dimensions["D"].width = 32 # Tên kịch bản
    ws2.column_dimensions["E"].width = 28 # Tiền điều kiện
    ws2.column_dimensions["F"].width = 42 # Các bước
    ws2.column_dimensions["G"].width = 25 # Test Data
    ws2.column_dimensions["H"].width = 38 # Expected
    ws2.column_dimensions["I"].width = 25 # Actual
    ws2.column_dimensions["J"].width = 14 # Status
    ws2.column_dimensions["K"].width = 14 # Severity
    ws2.column_dimensions["L"].width = 18 # Notes

    ws2.freeze_panes = "D4"


    # =========================================================================
    # SHEET 3: MA TRẬN 6 QUY TRÌNH CORE (Core Workflows Matrix)
    # =========================================================================
    ws3 = wb.create_sheet(title="Ma trận Quy trình Core")
    ws3.views.sheetView[0].showGridLines = True

    ws3.merge_cells("A1:G1")
    ws3["A1"] = "BẢNG ĐẶC TẢ CHI TIẾT 6 QUY TRÌNH KINH DOANH CỐT LÕI (CORE E-COMMERCE WORKFLOWS)"
    ws3["A1"].font = title_font
    ws3["A1"].fill = brand_primary_fill
    ws3["A1"].alignment = Alignment(horizontal="left", vertical="center", indent=1)
    ws3.row_dimensions[1].height = 36

    matrix_headers = ["STT", "Quy trình Core", "Vai trò tham gia (Actors)", "Điểm bắt đầu (Trigger / Input)", "Các bước xử lý chính của Hệ thống", "Điểm kết thúc (Output / Result)", "Tiêu chí Nghiệm thu Chấp nhận (Exit Criteria)"]
    for col_idx, h in enumerate(matrix_headers, 1):
        cell = ws3.cell(row=2, column=col_idx, value=h)
        cell.font = table_header_font
        cell.fill = brand_dark_fill
        cell.alignment = align_center
        cell.border = header_border
    ws3.row_dimensions[2].height = 28

    workflows_data = [
        ("01", "Tìm kiếm, Khám phá & Chọn Sản phẩm (PDP & Catalog)", 
         "Khách hàng (Shopper)", 
         "Khách truy cập Storefront, tìm kiếm từ khóa hoặc upload ảnh mẫu trang phục", 
         "1. Text Search & Filter: Lọc theo size, màu, khoảng giá.\n2. Visual AI Search: Nhận diện ảnh mẫu qua Google Gemini.\n3. PDP Variant Matrix: Chuyển màu/size thời gian thực.\n4. Stock Check: Nếu SKU tồn kho = 0, tự động disable nút Mua ngay/Thêm giỏ.", 
         "Sản phẩm được chọn đúng biến thể và chuyển vào Giỏ hàng hoặc trang Thanh toán", 
         "- Tìm kiếm AI trả kết quả tương đồng < 2 giây.\n- Nút Mua ngay / Thêm giỏ khóa 100% khi hết tồn kho.\n- Không bị reload trang khi lọc thuộc tính."),

        ("02", "Thanh toán & Đặt hàng Trực tuyến (Checkout & Payments)", 
         "Khách hàng, Cổng Stripe, Hệ thống Email", 
         "Khách nhấn 'Mua ngay' hoặc 'Tiến hành đặt hàng' từ giỏ hàng", 
         "1. Nhập thông tin giao hàng & chọn gói quà / hóa đơn VAT.\n2. Áp dụng Voucher (Kiểm tra min order, flash sale, voucher sinh nhật HPBD2026).\n3. Phương thức COD: Ghi nhận đơn PENDING_CONFIRMATION.\n4. Phương thức Stripe: Tích hợp thẻ tín dụng, xác thực 3D Secure.\n5. Trừ tồn kho & bắn email biên nhận.", 
         "Mã đơn hàng `#ORD-xxxx` được tạo, đơn chuyển trạng thái sang xử lý", 
         "- Thanh toán thẻ Stripe trừ tiền đúng, webhook trả về < 3s.\n- Voucher sinh nhật HPBD2026 kích hoạt đúng ngày sinh khách hàng.\n- Đơn hàng COD lưu đủ metadata gói quà, VAT."),

        ("03", "Xác nhận, Đóng gói & Giao nhận Đơn hàng (Order Fulfillment)", 
         "Nhân viên Vận hành, Thủ kho, Đơn vị vận chuyển (3PL)", 
         "Đơn hàng mới xuất hiện trên Dashboard Admin", 
         "1. CSKH/Vận hành gọi xác nhận đơn COD có rủi ro, log kết quả cuộc gọi.\n2. Xuất phiếu đóng gói hàng hóa tại kho.\n3. Đóng gói kiện hàng & bàn giao đơn vị vận chuyển (gắn mã Tracking).\n4. Chuyển trạng thái đơn sang `SHIPPING`.\n5. Xác nhận giao thành công chuyển `DELIVERED`.", 
         "Khách nhận được kiện hàng nguyên vẹn, hệ thống kích hoạt thời hạn đổi trả 15 ngày", 
         "- Lịch sử cuộc gọi xác nhận lưu vết đầy đủ trong đơn.\n- Trạng thái đơn cập nhật theo thời gian thực.\n- Tồn kho trừ chính xác theo từng SKU."),

        ("04", "Yêu cầu & Xử lý Đổi trả Hàng (RMA Return & Exchange)", 
         "Khách hàng, Chuyên viên CSKH, Thủ kho QA, Kế toán", 
         "Khách hàng nhấn 'Yêu cầu đổi / trả' trên đơn đã giao thành công", 
         "1. Khách gửi yêu cầu (Hoàn tiền hoặc Đổi hàng), tải ảnh lỗi SP (`REQUESTED`).\n2. CSKH liên hệ khách thỏa thuận biên bản (`CONTACTING`).\n3. CSKH duyệt phương án: Hoàn tiền cố định theo giá mua hoặc Đổi size mới (`WAITING_RETURN`).\n4. Khách gửi hàng (`RETURN_IN_TRANSIT`), Kho nhận kiện hàng (`RECEIVED`).\n5. Kho kiểm định QA: Đạt (`qa_pass`) hoặc Từ chối (`qa_fail`).\n6. Hoàn tiền qua Stripe/Chuyển khoản hoặc Soạn hàng đổi.\n7. Nghiệm thu hoàn tất (`COMPLETED`).", 
         "Khách nhận đủ tiền hoàn vào tài khoản hoặc nhận được sản phẩm đổi mới, phiếu đổi trả đóng thành công", 
         "- Số tiền hoàn khóa cứng chuẩn theo giá trị thực mua.\n- Thao tác cột bảng Admin dùng cặp icon [ 👁 ] [ ✏ ] và Dropdown menu chuẩn chỉ, không vỡ giao diện.\n- Quy trình kiểm định QA có log minh bạch."),

        ("05", "Đánh giá, Review & Kiểm duyệt Phản hồi (Product Review)", 
         "Khách đã mua hàng, Khách vãng lai, Admin CSKH", 
         "Khách nhận hàng thành công hoặc truy cập trang đánh giá", 
         "1. Khách đăng nhập: Đánh giá sao, viết nhận xét, tải ảnh thực tế.\n2. Khách vãng lai: Xác thực qua SĐT/Email OTP để hiện đơn hàng và đánh giá.\n3. AI Guard: Tự động quét từ ngữ thô tục, spam, số điện thoại lạ.\n4. Admin: Duyệt công khai review, ẩn review vi phạm, hoặc phản hồi thương hiệu.", 
         "Đánh giá hiển thị công khai trên PDP, điểm trung bình sao của sản phẩm được cập nhật", 
         "- Luồng xác thực OTP cho khách vãng lai hoạt động mượt mà, bảo mật.\n- Tự động gắn cờ cảnh báo từ cấm/spam chính xác.\n- Review có ảnh tải lên sắc nét, có lightbox phóng to ảnh."),

        ("06", "Quản trị Danh mục, Tồn kho & Khuyến mãi (Backoffice & Campaigns)", 
         "Quản trị viên (Admin), Marketing Lead", 
         "Kế hoạch ra mắt sản phẩm mới hoặc mở đợt khuyến mãi Flash Sale", 
         "1. Tạo sản phẩm mới, upload ảnh, AI tự sinh mô tả hấp dẫn & thẻ SEO.\n2. Cấu hình biến thể đa tầng (Màu x Size), nhập số lượng kho.\n3. Tạo chiến dịch Flash sale, Voucher giảm giá, Cấu hình quà sinh nhật.\n4. Giám sát phân quyền tài khoản (RBAC) và kiểm tra Audit Logs.", 
         "Sản phẩm và chiến dịch khuyến mãi lên sóng đúng giờ, phân quyền an toàn", 
         "- Tồn kho đồng bộ tức thì giữa Admin và Storefront.\n- Voucher không bị lỗi tính toán âm tiền hoặc vượt giới hạn lượt dùng.\n- Phân quyền chuẩn: Kho và CSKH không can thiệp được cài đặt nhạy cảm.")
    ]

    for r_idx, wf in enumerate(workflows_data, 3):
        for c_idx, val in enumerate(wf, 1):
            cell = ws3.cell(row=r_idx, column=c_idx, value=val)
            cell.font = cell_font
            cell.border = cell_border
            if c_idx == 1:
                cell.font = code_font
                cell.alignment = align_center
            elif c_idx == 2:
                cell.font = cell_font_bold
                cell.alignment = align_left_wrap
            elif c_idx == 3:
                cell.font = cell_font_bold
                cell.alignment = align_center
            else:
                cell.alignment = align_left_wrap
        ws3.row_dimensions[r_idx].height = 65

    ws3.column_dimensions["A"].width = 8
    ws3.column_dimensions["B"].width = 28
    ws3.column_dimensions["C"].width = 20
    ws3.column_dimensions["D"].width = 28
    ws3.column_dimensions["E"].width = 45
    ws3.column_dimensions["F"].width = 30
    ws3.column_dimensions["G"].width = 35


    # =========================================================================
    # SHEET 4: BÁO CÁO PHÁT SINH LỖI (Defect & Bug Tracker)
    # =========================================================================
    ws4 = wb.create_sheet(title="Nhật ký Báo cáo Bug UAT")
    ws4.views.sheetView[0].showGridLines = True

    ws4.merge_cells("A1:K1")
    ws4["A1"] = "NHẬT KÝ THEO DÕI VÀ XỬ LÝ LỖI PHÁT SINH TRONG QUÁ TRÌNH UAT (DEFECT LOG)"
    ws4["A1"].font = title_font
    ws4["A1"].fill = brand_primary_fill
    ws4["A1"].alignment = Alignment(horizontal="left", vertical="center", indent=1)
    ws4.row_dimensions[1].height = 36

    bug_headers = ["Bug ID", "Mã TC Liên quan", "Tóm tắt Lỗi (Summary)", "Phân hệ", "Người phát hiện", "Mức độ (Severity)", "Độ ưu tiên (Priority)", "Các bước tái hiện (Steps to Reproduce)", "Kết quả thực tế vs Mong đợi", "Trạng thái xử lý", "Người phụ trách Fix"]
    for col_idx, h in enumerate(bug_headers, 1):
        cell = ws4.cell(row=2, column=col_idx, value=h)
        cell.font = table_header_font
        cell.fill = brand_dark_fill
        cell.alignment = align_center
        cell.border = header_border
    ws4.row_dimensions[2].height = 28

    sample_bugs = [
        ("BUG-001", "TC-CORE-04", "Nút Thêm vào giỏ không bị khóa khi biến thể màu Đen - Size M hết hàng", "Chi tiết SP", "Tester 01", "Critical", "P1 - High", "1. Vào PDP Áo Cotton.\n2. Chọn Đen, chọn M (tồn = 0).\n3. Nút vẫn sáng và cho click.", "Nút vẫn cho bấm thay vì bị disabled và hiện 'Hết hàng'", "Đã sửa (Fixed)", "Dev Frontend"),
        ("BUG-002", "TC-CORE-11", "Voucher sinh nhật HPBD2026 không tự động nạp vào ví khách hàng", "Khuyến mãi", "Tester 02", "Major", "P2 - Medium", "1. Tạo user có ngày sinh hôm nay.\n2. Vào ví voucher thấy rỗng.", "Không thấy mã voucher sinh nhật được kích hoạt tự động", "Đang xử lý (In Progress)", "Dev Backend"),
        ("BUG-003", "TC-CORE-30", "Số tiền hoàn đổi trả cho phép sửa tay dẫn đến nguy cơ sai lệch kế toán", "CSKH Đổi trả", "Tester 05", "Critical", "P1 - High", "1. Admin mở modal Duyệt hoàn tiền.\n2. Ô số tiền cho phép gõ số tùy ý.", "Ô số tiền bị hở cho sửa tự do thay vì khóa cứng theo giá mua", "Đã sửa (Fixed)", "Dev Fullstack"),
        ("BUG-004", "TC-CORE-34", "Cột Thao tác đổi trả nút bấm so le méo xẹo, text 'Đã hoàn tất' trơ trọi", "CSKH Đổi trả", "Tester 05", "Minor", "P3 - Low", "1. Vào bảng Admin Returns.\n2. Cột thao tác hàng 1 nút, hàng 2 nút, nút dài ngắn lệch nhau.", "Cột thao tác méo mó, mất thẩm mỹ chuyên nghiệp", "Đã sửa (Fixed)", "Dev Frontend"),
    ]

    for r_idx, bug in enumerate(sample_bugs, 3):
        for c_idx, val in enumerate(bug, 1):
            cell = ws4.cell(row=r_idx, column=c_idx, value=val)
            cell.font = cell_font
            cell.border = cell_border
            if c_idx in [1, 2]:
                cell.font = code_font
                cell.alignment = align_center
            elif c_idx in [3, 4, 5, 11]:
                cell.alignment = align_left
            elif c_idx == 6:
                cell.alignment = align_center
                cell.font = cell_font_bold
                if val == "Critical": cell.fill = fail_fill; cell.font = fail_font
                elif val == "Major": cell.fill = blocked_fill; cell.font = blocked_font
                else: cell.fill = pass_fill; cell.font = pass_font
            elif c_idx in [7, 10]:
                cell.alignment = align_center
                cell.font = cell_font_bold
            else:
                cell.alignment = align_left_wrap
        ws4.row_dimensions[r_idx].height = 40

    # Add 15 blank template rows for testing logging
    for r_idx in range(7, 22):
        bug_id = f"BUG-{r_idx-2:03d}"
        ws4.cell(row=r_idx, column=1, value=bug_id).alignment = align_center
        ws4.cell(row=r_idx, column=1).font = code_font
        ws4.cell(row=r_idx, column=1).border = cell_border
        for c_idx in range(2, 12):
            cell = ws4.cell(row=r_idx, column=c_idx, value="")
            cell.border = cell_border
            cell.font = cell_font
        ws4.row_dimensions[r_idx].height = 28

    ws4.column_dimensions["A"].width = 12
    ws4.column_dimensions["B"].width = 16
    ws4.column_dimensions["C"].width = 36
    ws4.column_dimensions["D"].width = 18
    ws4.column_dimensions["E"].width = 16
    ws4.column_dimensions["F"].width = 16
    ws4.column_dimensions["G"].width = 16
    ws4.column_dimensions["H"].width = 35
    ws4.column_dimensions["I"].width = 35
    ws4.column_dimensions["J"].width = 18
    ws4.column_dimensions["K"].width = 18

    # Save output
    output_dir = "docs/ba"
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, "Velura_UAT_Test_Plan_Core_Workflows_6_Testers.xlsx")
    wb.save(output_path)
    print(f"UAT Test Plan workbook created successfully at: {output_path}")

if __name__ == "__main__":
    build_uat_workbook()
