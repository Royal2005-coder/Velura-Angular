# -*- coding: utf-8 -*-
"""Nam so do BPMN cua quy trinh khuyen mai 3.1.13.

Noi dung bam theo hanh vi that cua ma nguon production:
  apps/api/src/user/voucher-engine.ts           thu tu tam buoc kiem, cach chon ma tot nhat
  apps/api/src/user/order-pricing.ts            may chu tu chot gia, phi giao theo nguong
  apps/api/src/pricing/promotion-lifecycle.ts   nam trang thai vong doi chien dich
  database/migrations/025_*.sql                 cong don ngan sach, tu dung chien dich

Moi so do tach rieng mot tieu quy trinh de ban PNG nhung vao tai lieu van doc duoc
o kho trang A4, thay vi mot hinh dai gap ba lan be ngang trang.
"""
from bpmn_build import Model

ADMIN = "lane_admin"
SYS = "lane_sys"
KH = "lane_kh"
SELL = "lane_sell"
PROMO = "lane_promo"

TOP, LOW, DEEP = -1.0, 0.62, 1.78
AROW = -0.3


def _admin_pool(m, admin_rows=2, sys_rows=5.3):
    m.pool("velura", "Velura", [
        (ADMIN, "Quản trị viên giá và khuyến mãi", admin_rows),
        (SYS, "Hệ thống", sys_rows),
    ])


# ---------------------------------------------------------------------------
# Hinh 3.17 - Thiet lap chien dich khuyen mai
# ---------------------------------------------------------------------------
def dia_campaign():
    m = Model("Hình 3.17 - Thiết lập chiến dịch khuyến mãi")
    _admin_pool(m)

    m.event("ev_start", ADMIN, 0, AROW, "Có nhu cầu chạy\nchương trình khuyến mãi", "start")
    m.task("t_khaibao", ADMIN, 1, AROW,
           "Khai báo chiến dịch: tên, mô tả,\nkhung thời gian, ngân sách\nvà nội dung trình bày")
    m.task("t_kiem", SYS, 2, TOP,
           "Kiểm vai trò và tính hợp lệ\ncủa khung thời gian", "service")
    m.gateway("gw_hople", SYS, 2.9, TOP, "Dữ liệu hợp lệ?")
    m.task("t_loi", SYS, 2.9, LOW,
           "Trả về trường sai và giữ nguyên\ndữ liệu đã nhập", "send")
    m.task("t_quydoi", SYS, 3.8, TOP,
           "Quy đổi ngân sách thành\nsố mã tối đa được phát hành", "service")
    m.task("t_ghicd", SYS, 4.8, TOP,
           "Ghi chiến dịch ở trạng thái\nTạm dừng và ghi nhật ký", "service")
    m.task("t_chonglan", SYS, 5.8, TOP,
           "Đối chiếu chồng lấn thời gian\nvà danh mục với chiến dịch khác", "service")
    m.gateway("gw_chonglan", SYS, 6.7, TOP, "Có chồng lấn?")
    m.task("t_canhbaotrung", SYS, 6.7, LOW,
           "Cảnh báo trùng chiến dịch,\nkhông tự gộp mức giảm", "send")
    m.event("ev_end", ADMIN, 7.7, AROW, "Chiến dịch chờ\nphát hành mã", "end")
    m.store("ds_log", SYS, 4.8, DEEP, "Nhật ký\nkhuyến mãi")

    m.seq("ev_start", "t_khaibao")
    m.seq("t_khaibao", "t_kiem")
    m.seq("t_kiem", "gw_hople")
    m.seq("gw_hople", "t_loi", "Không")
    m.seq("t_loi", "t_khaibao")
    m.seq("gw_hople", "t_quydoi", "Có")
    m.seq("t_quydoi", "t_ghicd")
    m.seq("t_ghicd", "t_chonglan")
    m.seq("t_chonglan", "gw_chonglan")
    m.seq("gw_chonglan", "t_canhbaotrung", "Có")
    m.seq("t_canhbaotrung", "ev_end")
    m.seq("gw_chonglan", "ev_end", "Không")
    m.assoc("t_ghicd", "ds_log")

    m.note("n_quydoi", SYS, 2.9, DEEP,
           "Số mã tối đa bằng ngân sách chiến dịch chia cho trần giảm mỗi lượt. "
           "Trần này chặn tại thời điểm phát hành mã.")
    m.note("n_chonglan", SYS, 6.7, DEEP,
           "Hệ thống chỉ cảnh báo. Không tự chọn giữa hai chiến dịch chồng lấn "
           "và không cộng dồn mức giảm của chúng.")
    m.assoc("n_quydoi", "t_quydoi")
    m.assoc("n_chonglan", "t_chonglan")
    return m


# ---------------------------------------------------------------------------
# Hinh 3.18 - Phat hanh ma giam gia va kich hoat chien dich
# ---------------------------------------------------------------------------
def dia_voucher():
    m = Model("Hình 3.18 - Phát hành mã giảm giá và kích hoạt chiến dịch")
    _admin_pool(m)

    m.event("v_start", ADMIN, 0, AROW, "Chiến dịch đã có\ntrần số mã", "start")
    m.task("v_nhap", ADMIN, 1, AROW,
           "Nhập mã: loại giảm, trần giảm,\ngiá trị đơn tối thiểu, nhóm khách,\nkho lượt và hạn dùng")
    m.task("v_kiem", SYS, 2, TOP,
           "Kiểm mã không trùng và số mã\nchưa vượt trần ngân sách", "service")
    m.gateway("v_gw", SYS, 2.9, TOP, "Đủ điều kiện phát hành?")
    m.task("v_tuchoi", SYS, 2.9, LOW,
           "Từ chối kèm lý do cụ thể:\ntrùng mã hoặc vượt trần", "send")
    m.task("v_ghi", SYS, 3.8, TOP,
           "Ghi mã giảm giá và ghi nhật ký\nkèm người thực hiện", "service")
    m.task("v_kichhoat", ADMIN, 4.8, AROW, "Kích hoạt chiến dịch")
    m.task("v_mo", SYS, 5.8, TOP,
           "Mở mã cho khách theo đúng\nnhóm đối tượng đã khai", "service")
    m.event("v_end", ADMIN, 6.8, AROW, "Mã sẵn sàng\nphục vụ khách", "end")
    m.store("v_log", SYS, 3.8, DEEP, "Nhật ký\nkhuyến mãi")

    m.seq("v_start", "v_nhap")
    m.seq("v_nhap", "v_kiem")
    m.seq("v_kiem", "v_gw")
    m.seq("v_gw", "v_tuchoi", "Không")
    m.seq("v_tuchoi", "v_nhap")
    m.seq("v_gw", "v_ghi", "Có")
    m.seq("v_ghi", "v_kichhoat")
    m.seq("v_kichhoat", "v_mo")
    m.seq("v_mo", "v_end")
    m.assoc("v_ghi", "v_log")

    m.note("n_rpc", SYS, 1.9, DEEP,
           "Mọi thao tác ghi đi qua hàm RPC có kiểm vai trò trên cơ sở dữ liệu "
           "và sinh một dòng nhật ký kèm người thực hiện.")
    m.note("n_nhom", SYS, 5.8, DEEP,
           "Chiến dịch là vỏ chứa mã, ngân sách và khung thời gian. Chiến dịch "
           "không tự đổi giá bán của sản phẩm.")
    m.assoc("n_rpc", "v_ghi")
    m.assoc("n_nhom", "v_mo")
    return m


# ---------------------------------------------------------------------------
# Hinh 3.19 - Vi ma giam gia va chon ma tot nhat cho khach
# ---------------------------------------------------------------------------
def dia_wallet():
    m = Model("Hình 3.19 - Ví mã giảm giá và chọn mã tốt nhất")
    m.pool("khachhang", "Khách hàng", [(KH, "Khách hàng", 2)])
    m.pool("velura", "Velura", [(PROMO, "Dịch vụ khuyến mãi", 5.3)])

    m.event("w_cstart", KH, 0, AROW, "Khách mở giỏ hàng\nhoặc trang Ưu đãi", "start")
    m.task("w_xem", KH, 1, AROW, "Xem trang Ưu đãi hoặc\nthêm sản phẩm vào giỏ")
    m.task("w_vi", KH, 4.4, AROW, "Xem ví mã giảm giá và\nmức giảm được gợi ý")
    m.gateway("w_gw", KH, 5.4, AROW, "Đổi sang mã khác?")
    m.task("w_doi", KH, 5.4, 0.72, "Chọn mã khác trong ví")
    m.event("w_cend", KH, 6.4, AROW, "Giỏ hàng đã gắn\nmột mã duy nhất", "end")

    m.event("w_sstart", PROMO, 1, TOP, "Nhận phiên\ngiỏ hàng", "start")
    m.task("w_loc", PROMO, 2, TOP,
           "Xác định khách vãng lai hay thành viên\nvà lọc bộ mã theo đối tượng", "service")
    m.task("w_cham", PROMO, 3, TOP,
           "Chấm từng mã trên giá trị giỏ\nhiện tại theo tám bước kiểm", "service")
    m.gateway("w_sgw", PROMO, 3.9, TOP, "Có mã đủ điều kiện?")
    m.task("w_lydo", PROMO, 3.9, LOW,
           "Nêu lý do chưa dùng được\nvà số tiền còn thiếu", "send")
    m.task("w_chon", PROMO, 4.8, TOP,
           "Chọn mã cho số tiền giảm\nthực tế lớn nhất", "service")
    m.event("w_send", PROMO, 5.8, TOP, "Ví mã đã\nsẵn sàng", "end")

    m.seq("w_cstart", "w_xem")
    m.seq("w_xem", "w_vi")
    m.seq("w_vi", "w_gw")
    m.seq("w_gw", "w_doi", "Có")
    m.seq("w_doi", "w_vi")
    m.seq("w_gw", "w_cend", "Không")

    m.seq("w_sstart", "w_loc")
    m.seq("w_loc", "w_cham")
    m.seq("w_cham", "w_sgw")
    m.seq("w_sgw", "w_lydo", "Không")
    m.seq("w_sgw", "w_chon", "Có")
    m.seq("w_lydo", "w_send")
    m.seq("w_chon", "w_send")

    m.msg("w_xem", "w_sstart", "Phiên giỏ hàng và\ntrạng thái đăng nhập")
    m.msg("w_chon", "w_vi", "Mã được áp\nvà mức giảm")
    m.msg("w_lydo", "w_vi", "Lý do chưa dùng được")
    m.msg("w_doi", "w_cham", "Mã khách tự chọn")

    m.note("n_tambuoc", PROMO, 2.6, DEEP,
           "Tám bước kiểm theo thứ tự: mã ngừng hoạt động, chưa tới hạn, hết hạn, "
           "hết lượt toàn hệ thống, chiến dịch cha dừng hoặc cạn ngân sách, sai nhóm "
           "khách, hết lượt của chính khách, chưa đạt giá trị đơn tối thiểu.")
    m.note("n_totnhat", PROMO, 5.3, DEEP,
           "So sánh theo số tiền giảm thực tế sau khi áp trần, không theo phần trăm "
           "danh nghĩa. Bằng nhau thì ưu tiên mã hết hạn sớm hơn. Mỗi đơn một mã.")
    m.assoc("n_tambuoc", "w_cham")
    m.assoc("n_totnhat", "w_chon")
    return m


# ---------------------------------------------------------------------------
# Hinh 3.20 - Chot tien va ghi nhan uu dai khi dat don
# ---------------------------------------------------------------------------
def dia_checkout():
    m = Model("Hình 3.20 - Chốt tiền và ghi nhận ưu đãi khi đặt đơn")
    m.pool("khachhang", "Khách hàng", [(KH, "Khách hàng", 2)])
    m.pool("velura", "Velura", [
        (SELL, "Hệ thống bán hàng", 2.6),
        (PROMO, "Dịch vụ khuyến mãi", 5.2),
    ])
    srow, slow = -0.28, 0.72

    m.event("k_cstart", KH, 0, AROW, "Khách bấm\nđặt hàng", "start")
    m.task("k_dat", KH, 1, AROW, "Xác nhận đặt hàng")
    m.task("k_ketqua", KH, 7.6, AROW, "Nhận kết quả đặt hàng")
    m.event("k_cend", KH, 8.6, AROW, "Kết thúc\nlượt mua", "end")

    m.event("k_sstart", SELL, 1, srow, "Nhận yêu cầu\nđặt hàng", "start")
    m.task("k_gia", SELL, 2, srow,
           "Tra bảng giá và tự tính tạm tính\ntừ giá catalog", "service")
    m.gateway("k_gwgia", SELL, 2.9, srow, "Giá khớp bảng giá?")
    m.task("k_taila", SELL, 2.9, slow,
           "Yêu cầu tải lại giỏ hàng", "send")
    m.task("k_ship", SELL, 3.8, srow,
           "Xác định phí vận chuyển\ntheo ngưỡng miễn phí", "service")
    m.event("k_endloi", SELL, 3.8, slow, "Dừng, chờ khách\nthao tác lại", "end")

    m.task("k_chamlai", PROMO, 4.8, TOP,
           "Chấm lại mã tại thời điểm đặt đơn", "service")
    m.gateway("k_gwma", PROMO, 5.7, TOP, "Mã còn hợp lệ?")
    m.task("k_tuchoi", PROMO, 5.7, LOW,
           "Từ chối đơn kèm lý do cụ thể", "send")
    m.task("k_tong", PROMO, 6.6, TOP,
           "Chốt tổng tiền bằng tạm tính\ncộng phí giao trừ giảm giá", "service")
    m.task("k_ghiluot", PROMO, 7.6, TOP,
           "Ghi lượt dùng mã và cộng dồn ngân sách\ntrong cùng giao dịch", "service")
    m.event("k_endma", PROMO, 6.6, LOW, "Dừng, chờ khách\nchọn lại mã", "end")
    m.store("k_log", PROMO, 8.6, DEEP, "Nhật ký\nkhuyến mãi")

    m.task("k_ghidon", SELL, 8.6, srow,
           "Ghi đơn hàng kèm số tiền\nđã giảm", "service")
    m.event("k_send", SELL, 9.5, srow, "Ưu đãi được\nghi nhận", "end")

    m.seq("k_cstart", "k_dat")
    m.seq("k_dat", "k_ketqua")
    m.seq("k_ketqua", "k_cend")

    m.seq("k_sstart", "k_gia")
    m.seq("k_gia", "k_gwgia")
    m.seq("k_gwgia", "k_taila", "Không")
    m.seq("k_taila", "k_endloi")
    m.seq("k_gwgia", "k_ship", "Có")
    m.seq("k_ship", "k_chamlai")
    m.seq("k_chamlai", "k_gwma")
    m.seq("k_gwma", "k_tuchoi", "Không")
    m.seq("k_tuchoi", "k_endma")
    m.seq("k_gwma", "k_tong", "Có")
    m.seq("k_tong", "k_ghiluot")
    m.seq("k_ghiluot", "k_ghidon")
    m.seq("k_ghidon", "k_send")
    m.assoc("k_ghiluot", "k_log")

    m.msg("k_dat", "k_sstart", "Giỏ hàng và mã\nkhách đang áp")
    m.msg("k_taila", "k_ketqua", "Giá đã thay đổi,\nvui lòng tải lại giỏ")
    m.msg("k_tuchoi", "k_ketqua", "Mã không còn hợp lệ")
    m.msg("k_ghidon", "k_ketqua", "Xác nhận đơn và\nsố tiền đã giảm")

    m.note("n_maychu", SELL, 2.4, 1.55,
           "Máy chủ không nhận đơn giá, tạm tính, phí giao hay số tiền giảm do "
           "trình duyệt gửi lên. Lệch giá thì từ chối đơn.")
    m.note("n_ship", PROMO, 4.4, DEEP,
           "Miễn phí vận chuyển là ngưỡng theo giá trị đơn do máy chủ giữ, "
           "không phải một loại mã giảm giá.")
    m.note("n_huy", PROMO, 7.0, DEEP,
           "Huỷ đơn thì lượt dùng và phần ngân sách đã cộng được hoàn lại.")
    m.assoc("n_maychu", "k_gia")
    m.assoc("n_ship", "k_ship")
    m.assoc("n_huy", "k_ghiluot")
    return m


# ---------------------------------------------------------------------------
# Hinh 3.21 - Giam sat ngan sach, tu dong dung va thong ke
# ---------------------------------------------------------------------------
def dia_budget():
    m = Model("Hình 3.21 - Giám sát ngân sách và thống kê")
    _admin_pool(m)

    m.event("b_start", SYS, 0, TOP, "Chiến dịch\nđang chạy", "start")
    m.event("b_timer", SYS, 0.9, TOP, "Đến mốc đồng bộ\ntheo lịch", "timer")
    m.task("b_lich", SYS, 1.8, TOP,
           "Bộ lịch bật hoặc tắt chiến dịch\ntheo khung ngày", "service")
    m.task("b_congdon", SYS, 2.8, TOP,
           "Cộng dồn ngân sách theo số tiền giảm\nthực tế của từng lượt dùng", "service")
    m.gateway("b_gw", SYS, 3.7, TOP, "Chạm trần ngân sách\nhoặc quá hạn?")
    m.task("b_dung", SYS, 3.7, LOW,
           "Dừng chiến dịch và tắt toàn bộ\nmã thuộc chiến dịch", "service")
    m.task("b_canhbao", SYS, 4.6, LOW,
           "Cảnh báo ngân sách\ncho quản trị viên", "send")
    m.task("b_nhan", SYS, 4.6, TOP,
           "Cập nhật nhãn cảnh báo vận hành\ntrên bảng danh sách", "service")
    m.task("b_theodoi", ADMIN, 5.6, AROW, "Theo dõi cảnh báo và\ntrạng thái chiến dịch")
    m.task("b_thongke", ADMIN, 6.6, AROW, "Xem thống kê hiệu quả\nkhuyến mãi")
    m.task("b_tonghop", SYS, 7.6, TOP,
           "Tổng hợp chỉ số từ đơn hàng thật\ncó áp mã giảm giá", "service")
    m.task("b_xuat", ADMIN, 8.6, AROW, "Xuất báo cáo")
    m.event("b_end", ADMIN, 9.5, AROW, "Kết thúc\nkỳ theo dõi", "end")
    m.store("b_log", SYS, 3.7, DEEP, "Nhật ký\nkhuyến mãi")

    m.seq("b_start", "b_timer")
    m.seq("b_timer", "b_lich")
    m.seq("b_lich", "b_congdon")
    m.seq("b_congdon", "b_gw")
    m.seq("b_gw", "b_dung", "Có")
    m.seq("b_dung", "b_canhbao")
    m.seq("b_canhbao", "b_theodoi")
    m.seq("b_gw", "b_nhan", "Không")
    m.seq("b_nhan", "b_theodoi")
    m.seq("b_theodoi", "b_thongke")
    m.seq("b_thongke", "b_tonghop")
    m.seq("b_tonghop", "b_xuat")
    m.seq("b_xuat", "b_end")
    m.assoc("b_dung", "b_log")

    m.note("n_congdon", SYS, 1.8, DEEP,
           "Ngân sách đã dùng cộng dồn theo số tiền giảm thực tế của từng đơn, "
           "không theo mức trần cấu hình.")
    m.note("n_tonghop", SYS, 7.0, DEEP,
           "Chỉ số đọc từ bảng đơn hàng thật, không đếm số dòng trong bảng chiến dịch. "
           "Trạng thái lấy từ năm trạng thái vòng đời.")
    m.assoc("n_congdon", "b_congdon")
    m.assoc("n_tonghop", "b_tonghop")
    return m


ALL = [
    ("3-17-thiet-lap-chien-dich", "Hình 3.17", dia_campaign),
    ("3-18-phat-hanh-ma", "Hình 3.18", dia_voucher),
    ("3-19-vi-ma-giam-gia", "Hình 3.19", dia_wallet),
    ("3-20-chot-tien-dat-don", "Hình 3.20", dia_checkout),
    ("3-21-ngan-sach-thong-ke", "Hình 3.21", dia_budget),
]
