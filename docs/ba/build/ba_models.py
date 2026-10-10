# -*- coding: utf-8 -*-
"""Cac so do BPMN cua quy trinh quan ly san pham (3.1.8) va quan ly danh gia (3.1.10).

Noi dung bam theo hanh vi that cua ma nguon velura-angular:
  apps/api/src/products/product-service.ts      chuyen trang thai, doi gia, combo, CSV (toi da 500 dong)
  apps/api/src/products/product-router.ts       image-advice: Gemini nhan xet anh va dung nen studio
  apps/admin-ng/.../catalog/admin-products.page.ts   tang sang 8%, tuong phan 6%, nguong 4 MB
  apps/api/src/pricing/pricing-service.ts       ly do 10-500 ky tu, gia ban khong vuot gia goc, lich su gia
  apps/api/src/reviews/review-reply-ai.ts       goi y phan hoi toi da 2 cau, cau mau du phong
  apps/admin-ng/.../reviews/admin-reviews.page.ts   nhan cam xuc Tich cuc / Trung tinh / Tieu cuc
"""
from bpmnkit import Diagram

ADMIN, SYS, CSKH = "lane_admin", "lane_sys", "lane_cskh"


# ---------------------------------------------------------------------------
# Hinh 3.12a - Xu ly anh san pham bang AI (chi tiet cua hoat dong goi con)
# ---------------------------------------------------------------------------
def dia_image_ai():
    T, G = 205, 105
    d = Diagram("quan_ly_san_pham_anh_ai", "Hình 3.12a - Xử lý ảnh sản phẩm bằng AI",
                [G, T, T, T, T, G, T, T, T, G, G, 120])
    d.pool("velura", "Velura", [
        (ADMIN, "Quản trị viên quản lý sản phẩm", 1.5, 120),
        (SYS, "Hệ thống", 2.3, 130),
    ])
    d.blackbox("gemini", "Google Gemini (dịch vụ AI bên ngoài)", 64)

    BYP, MAIN = -0.62, 0.52
    d.event("e_start", ADMIN, 0, 0, "Cần ảnh\nsản phẩm", "start")
    d.task("t_chon", ADMIN, 1, 0, "Nhấn Xem trước nền studio, chọn ảnh JPG, PNG, WebP hoặc GIF (tối đa 5 MB)", "user")
    d.task("t_sang", SYS, 2, MAIN, "Thu nhỏ cạnh dài tối đa 1280 px, tăng sáng 8% và tương phản 6%", "service")
    d.task("t_gui", SYS, 3, MAIN, "Gửi ảnh cho Gemini: giữ sản phẩm, dựng nền studio và ánh sáng mềm", "send")
    d.task("t_nhan", SYS, 4, MAIN, "Nhận ảnh nền studio (kèm tối đa 3 câu nhận xét nếu có)", "receive")
    d.gateway("g_studio", SYS, 5, MAIN, "Gemini trả về\nảnh nền studio?")
    d.task("t_studio", SYS, 6, MAIN, "Đặt ảnh nền studio vào cột Sau", "service")
    d.task("t_banSang", SYS, 6, BYP, "Đặt bản ảnh đã tăng sáng vào cột Sau, ghi chú lý do chưa có nền studio", "service")
    d.task("t_xem", ADMIN, 7, 0, "So sánh ảnh Trước và Sau, đọc ghi chú, chọn Dùng ảnh sau hoặc Giữ ảnh gốc", "user")
    d.gateway("g_luu", ADMIN, 8, 0, "Đã chọn ảnh\nđể lưu?")
    d.task("t_luu", SYS, 9, MAIN, "Tải ảnh được chọn lên kho ảnh, thêm đường dẫn vào danh sách ảnh", "service")
    d.event("e_end", ADMIN, 10, 0, "Ảnh sẵn sàng gắn\nvào sản phẩm", "end")
    d.event("e_huy", ADMIN, 8, 0.64, "Đóng, không lưu ảnh", "end", lab="right")
    d.store("ds_anh", SYS, 11, MAIN, "Kho ảnh\nsản phẩm")

    d.seq("e_start", "t_chon")
    d.seq("t_chon", "t_sang")
    d.seq("t_sang", "t_gui")
    d.seq("t_gui", "t_nhan")
    d.seq("t_nhan", "g_studio")
    d.seq("g_studio", "t_studio", "Có")
    d.seq("g_studio", "t_banSang", "Không")
    d.seq("t_studio", "t_xem")
    d.seq("t_banSang", "t_xem")
    d.seq("t_xem", "g_luu")
    d.seq("g_luu", "t_luu", "Có")
    d.seq("g_luu", "e_huy", "Không")
    d.seq("t_luu", "e_end")

    d.msg("t_gui", "gemini", "Ảnh đã thu nhỏ và yêu cầu")
    d.msg("gemini", "t_nhan", "Ảnh nền studio")
    d.assoc("t_luu", "ds_anh")
    return d


# ---------------------------------------------------------------------------
# Hinh 3.12 - Quy trinh quan ly san pham (them gia, combo, anh AI)
# ---------------------------------------------------------------------------
def dia_product():
    T, G = 205, 105
    d = Diagram("quan_ly_san_pham", "Hình 3.12 - Quy trình quản lý sản phẩm",
                [100, T, 190, 235, 235, G, T, G, T, G, T, T, 100])
    d.pool("velura", "Velura", [
        (ADMIN, "Quản trị viên quản lý sản phẩm", 5.0, 112),
        (SYS, "Hệ thống", 5.7, 175),
    ])
    branches = [
        # ma, hang, nhan luong, nhap, kiem, cong, luu, loi
        ("a", -2, "Thêm / sửa",
         "Nhập hoặc chỉnh thông tin sản phẩm: tên, SKU, danh mục, mô tả, size, màu, tồn kho",
         "Kiểm tra SKU, giá, danh mục, ảnh và tồn kho", "Dữ liệu\nhợp lệ?",
         "Lưu sản phẩm, kiểm tra phiên bản bản ghi", "Hủy thao tác"),
        ("b", -1, "Đổi giá",
         "Chọn sản phẩm, nhập giá gốc, giá bán và lý do đổi giá",
         "Kiểm tra quyền giá, giá bán không vượt giá gốc, lý do 10–500 ký tự", "Giá\nhợp lệ?",
         "Cập nhật giá, ghi lịch sử giá cũ và giá mới", "Hủy đổi giá"),
        ("c", 0, "Combo",
         "Chọn combo, thêm, sửa số lượng hoặc bỏ sản phẩm thành phần",
         "Kiểm tra sản phẩm thành phần và số lượng nguyên từ 1", "Thành phần\nhợp lệ?",
         "Cập nhật thành phần của combo", "Hủy thao tác"),
        ("d", 1, "Ẩn / hiện",
         "Chọn sản phẩm, trạng thái mới và lý do thay đổi",
         "Kiểm tra sản phẩm tồn tại, quyền thao tác và luồng chuyển trạng thái", "Thao tác\nhợp lệ?",
         "Cập nhật trạng thái: Đang bán, Tạm ẩn, Hết hàng hoặc Ngừng bán", "Hủy thao tác"),
        ("e", 2, "Nhập CSV",
         "Tải file CSV theo mẫu chuẩn lên hệ thống",
         "Kiểm tra cả file: cột bắt buộc, SKU, giá, tối đa 500 dòng", "File\nhợp lệ?",
         "Thêm mới hoặc cập nhật sản phẩm theo SKU", "Từ chối cả file"),
    ]
    d.event("e_start", ADMIN, 0, 0, "Vào trang Quản\nlý Sản phẩm", "start")
    d.task("t_ds", ADMIN, 1, 0, "Xem danh sách, lọc và tìm kiếm sản phẩm", "user")
    d.gateway("g_chon", ADMIN, 2, 0, "Chọn thao tác?")
    d.seq("e_start", "t_ds")
    d.seq("t_ds", "g_chon")
    for (k, row, lbl, nhap, kiem, cong, luu, loi) in branches:
        d.task(k + "_nhap", ADMIN, 3, row, nhap, "user")
        d.task(k + "_kiem", SYS, 4, row, kiem, "service")
        d.gateway(k + "_gw", SYS, 5, row, cong)
        d.task(k + "_luu", SYS, 6, row, luu, "service")
        d.event(k + "_loi", SYS, 5, row + 0.38, loi, "end", lab="right")
        d.seq("g_chon", k + "_nhap", lbl)
        d.seq(k + "_kiem", k + "_gw")
        d.seq(k + "_gw", k + "_luu", "Có")
        d.seq(k + "_gw", k + "_loi", "Không")
        d.seq(k + "_luu", "g_hoi")
    d.call("a_anh", ADMIN, 4, -2, "Xử lý ảnh sản phẩm bằng AI (Hình 3.12a)")
    d.seq("a_nhap", "a_anh")
    d.seq("a_anh", "a_kiem")
    for k in "bcde":
        d.seq(k + "_nhap", k + "_kiem")

    d.gateway("g_hoi", SYS, 7, 0, "")
    d.task("t_kho", SYS, 8, 0, "Đồng bộ trạng thái tồn kho: Hết hàng hoặc Đang bán", "service")
    d.gateway("g_nguong", SYS, 9, 0, "Dưới ngưỡng\ntối thiểu?")
    d.task("t_canhbao", SYS, 10, -0.5, "Gửi cảnh báo Sắp hết hàng qua Dashboard và Email", "service")
    d.task("t_binhthuong", SYS, 10, 0.5, "Ghi nhận trạng thái tồn kho bình thường", "service")
    d.task("t_log", SYS, 11, 0, "Ghi nhật ký: người thao tác, thời gian, dữ liệu trước và sau, kết quả", "service")
    d.store("ds_log", SYS, 11, 1.05, "Nhật ký\nSản phẩm")
    d.event("e_end", SYS, 12, 0, "Hoàn tất", "end")
    d.seq("g_hoi", "t_kho")
    d.seq("t_kho", "g_nguong")
    d.seq("g_nguong", "t_canhbao", "Có")
    d.seq("g_nguong", "t_binhthuong", "Không")
    d.seq("t_canhbao", "t_log")
    d.seq("t_binhthuong", "t_log")
    d.seq("t_log", "e_end")
    d.assoc("t_log", "ds_log")
    return d


# ---------------------------------------------------------------------------
# Hinh 3.14 - Quy trinh quan ly danh gia va review (them nhan cam xuc, goi y AI)
# ---------------------------------------------------------------------------
def dia_review():
    T, G = 200, 100
    d = Diagram("quan_ly_danh_gia_review", "Hình 3.14 - Quy trình quản lý đánh giá và review",
                [G, T, G, T, G, T, T, T, G, 215, 215, 215, 150, T, T, G, T, G, G])
    d.pool("velura", "Velura", [
        (ADMIN, "Admin", 2.3, 120),
        (SYS, "Hệ thống", 3.5, 135),
        (CSKH, "Bộ phận CSKH", 1.3, 120),
    ])
    d.blackbox("gemini", "Google Gemini (dịch vụ AI bên ngoài)", 64)

    # Tiep nhan va quet
    d.event("r_start", SYS, 0, 0, "Khách gửi\nđánh giá mới", "start")
    d.task("r_quet", SYS, 1, 0, "Quét từ cấm (blacklist) và đọc số sao", "service")
    d.gateway("r_gwcam", SYS, 2, 0, "Chứa\ntừ cấm?")
    d.task("r_che", SYS, 3, -0.62, "Che từ cấm bằng ***, ghi vào danh sách quản lý, đánh dấu khẩn", "service")
    d.task("r_thuong", SYS, 3, 0.62, "Đưa vào danh sách quản lý theo thứ tự thông thường", "service")
    d.gateway("r_m1", SYS, 4, 0, "")
    d.seq("r_start", "r_quet")
    d.seq("r_quet", "r_gwcam")
    d.seq("r_gwcam", "r_che", "Có")
    d.seq("r_gwcam", "r_thuong", "Không")
    d.seq("r_che", "r_m1")
    d.seq("r_thuong", "r_m1")

    # Admin duyet
    d.task("r_loc", ADMIN, 5, -0.5, "Dùng bộ lọc đa tiêu chí để tìm và chọn đánh giá", "user")
    d.task("r_xem", ADMIN, 6, -0.5, "Xem chi tiết nội dung, ảnh, số sao và lịch sử mua hàng", "user")
    d.task("r_camxuc", SYS, 7, 0, "Gắn nhãn cảm xúc: Tích cực, Trung tính hoặc Tiêu cực", "service")
    d.gateway("r_gwsao", SYS, 8, 0, "Số sao ≥ 3?")
    d.seq("r_m1", "r_loc")
    d.seq("r_loc", "r_xem")
    d.seq("r_xem", "r_camxuc")
    d.seq("r_camxuc", "r_gwsao")
    d.note("n_camxuc", SYS, 6.3, 1.1,
           "Nhãn tính từ số sao và từ khóa tiêu cực trong nội dung (xấu, tệ, rách, lỗi, thất vọng...). "
           "Nhãn chỉ để gợi ý cho quản trị viên, không tự khóa đánh giá.", wrap=40)
    d.assoc("n_camxuc", "r_camxuc")

    # Tu 3 sao: chon hanh dong
    d.gateway("r_gwact", ADMIN, 9, -0.5, "Chọn hành động?")
    d.seq("r_gwsao", "r_gwact", "Có")
    d.task("r_duyet", SYS, 10, -1, "Phê duyệt: cho phép hiển thị công khai", "service")
    d.task("r_nhapan", ADMIN, 10, -0.5, "Nhập lý do ẩn (tối thiểu 10 ký tự)", "user")
    d.task("r_an", SYS, 11, -1, "Ẩn đánh giá khỏi trang sản phẩm, vẫn lưu trữ", "service")
    d.task("r_gui", SYS, 10, 1, "Gửi nội dung đánh giá cho Gemini xin gợi ý phản hồi", "send")
    d.task("r_nhan", SYS, 11, 1, "Nhận tối đa 2 câu gợi ý phản hồi", "receive")
    d.gateway("r_gwai", SYS, 12, 1, "Gợi ý\nhợp lệ?")
    d.task("r_mau", SYS, 13, 1, "Tạo câu mẫu bám sát nội dung đánh giá", "service")
    d.task("r_chon", ADMIN, 13, -0.5, "Chọn hoặc chỉnh sửa gợi ý rồi gửi phản hồi", "user")
    d.task("r_hienthi", SYS, 14, -1, "Hiển thị phản hồi công khai dưới đánh giá", "service")
    d.seq("r_gwact", "r_duyet", "Phê duyệt")
    d.seq("r_gwact", "r_nhapan", "Ẩn")
    d.seq("r_gwact", "r_gui", "Phản hồi")
    d.seq("r_nhapan", "r_an")
    d.seq("r_gui", "r_nhan")
    d.seq("r_nhan", "r_gwai")
    d.seq("r_gwai", "r_chon", "Có")
    d.seq("r_gwai", "r_mau", "Không")
    d.seq("r_mau", "r_chon")
    d.seq("r_chon", "r_hienthi")
    d.msg("r_gui", "gemini", "Nội dung, số sao và tên sản phẩm")
    d.msg("gemini", "r_nhan", "Tối đa 2 câu gợi ý")

    # 1-2 sao: ticket cham soc
    d.task("r_ticket", ADMIN, 9, 0.58, "Nhấn Tạo Ticket chăm sóc", "user")
    d.task("r_truyxuat", SYS, 10, 0, "Truy xuất dữ liệu khách: lịch sử mua, liên hệ, phiếu hỗ trợ", "service")
    d.task("r_chuyen", SYS, 11, 0, "Chuyển dữ liệu sang Bộ phận CSKH", "service")
    d.task("r_cskh", CSKH, 12, 0, "Liên hệ khách hàng và xử lý khiếu nại", "user")
    d.seq("r_gwsao", "r_ticket", "Không")
    d.seq("r_ticket", "r_truyxuat")
    d.seq("r_truyxuat", "r_chuyen")
    d.seq("r_chuyen", "r_cskh")

    # Hoi tu va ghi vet
    d.gateway("r_m2", SYS, 15, 0, "")
    d.task("r_log", SYS, 16, 0, "Ghi vết nhật ký: mã đánh giá, hành động, thời gian, người thực hiện", "service")
    d.store("ds_log", SYS, 16, 1.2, "Nhật ký\nđánh giá")
    d.gateway("r_m3", SYS, 17, 0, "")
    d.event("r_end", SYS, 18, 0, "Hoàn tất xử\nlý đánh giá", "terminate")
    d.seq("r_duyet", "r_m2")
    d.seq("r_an", "r_m2")
    d.seq("r_hienthi", "r_m2")
    d.seq("r_m2", "r_log")
    d.seq("r_log", "r_m3")
    d.seq("r_cskh", "r_m3")
    d.seq("r_m3", "r_end")
    d.assoc("r_log", "ds_log")
    return d


if __name__ == "__main__":
    pass
