# -*- coding: utf-8 -*-
"""BPMN tim kiem bang hinh anh (U6 / KAN-84, muc 3.1.3 bo sung).

Ba hinh 3.4b / 3.4c / 3.4d dung chung bo dung hinh cua build/bpmn_build.py
(bo style draw.io lay tu tim kiem.drawio.xml) nen cung quy uoc voi cac BPMN cu.
Dau ra:
  - Velura-3.1.3-Tim-kiem-bang-hinh-anh.drawio : trang 1 la BPMN tim kiem goc
    (tim kiem.drawio.xml, giu nguyen), trang 2-4 la ba hinh moi.
  - timkiem-anh-3-4b/c/d.bpmn : mo duoc tren bpmn.io
  - timkiem-anh-3-4b/c/d.png  : do bang draw.io-export (neu co)
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BA_DIR = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(BA_DIR, "build"))

import bpmn_build  # noqa: E402
import bpmn_emit   # noqa: E402
from bpmn_build import Model  # noqa: E402

bpmn_emit.NS = bpmn_emit.NS.replace("/khuyenmai", "/timkiem-anh")

ORIG = os.path.join(BA_DIR, "tim kiem.drawio.xml")
OUT_DRAWIO = os.path.join(BA_DIR, "Velura-3.1.3-Tim-kiem-bang-hinh-anh.drawio")

U, S = "Người dùng", "Hệ thống"
TOP, MID, LOW = -1.2, 0.0, 1.2      # ba tang cua lane He thong


def pool(m, pid, name):
    m.pool(pid, name, [("lane_u_" + pid, U, 1.4), ("lane_s_" + pid, S, 3.5)])
    return "lane_u_" + pid, "lane_s_" + pid


def stack_fail(m, gw, col, task_id, task_label, end_id, end_label, lane_s, branch_label="Không"):
    """Nhanh loi dung doc: gateway -> thong bao -> ket thuc, cung mot cot."""
    m.task(task_id, lane_s, col, MID, task_label, "send")
    m.event(end_id, lane_s, col, LOW, end_label, "end")
    m.seq(gw, task_id, branch_label)
    m.seq(task_id, end_id)


# ---------------------------------------------------------------------------
# Hinh 3.4b - Chon anh va kiem tra anh
# ---------------------------------------------------------------------------
def diagram_b1():
    m = Model("Hình 3.4b - Chọn ảnh và kiểm tra ảnh")
    lu, ls = pool(m, "A", "Velura - Tìm kiếm bằng hình ảnh (1/3)")
    m.event("a_start", lu, 0, 0, "Người dùng muốn tìm món đồ tương tự từ một bức ảnh", "start")
    m.task("a_cam", lu, 1, 0, "Nhấn biểu tượng camera trong ô tìm kiếm", "user")
    m.task("a_open", ls, 2, TOP, "Mở cửa sổ chọn ảnh: tải lên, chụp ảnh, kéo thả hoặc dán", "service")
    m.task("a_pick", lu, 3, 0, "Chọn ảnh từ thiết bị hoặc chụp bằng camera", "user")
    m.task("a_chk", ls, 4, TOP, "Kiểm tra định dạng JPG, PNG, WEBP và dung lượng tối đa 5 MB", "service")
    m.gateway("a_gw", ls, 5, TOP, "Ảnh hợp lệ?")
    stack_fail(m, "a_gw", 5, "a_err", "Báo lỗi kèm lý do cụ thể ngay tại cửa sổ chọn ảnh",
               "a_end_err", "Người dùng ở lại cửa sổ chọn ảnh", ls)
    m.task("a_prev", ls, 6, TOP, "Hiển thị ảnh xem trước và khung chọn vùng (mặc định toàn ảnh)", "service")
    m.task("a_crop", lu, 7, 0, "Khoanh món đồ cần tìm (nếu có) rồi nhấn Tìm sản phẩm", "user")
    m.event("a_end", lu, 8, 0, "Ảnh sẵn sàng, chuyển sang Hình 3.4c", "end")

    m.seq("a_start", "a_cam")
    m.seq("a_cam", "a_open")
    m.seq("a_open", "a_pick")
    m.seq("a_pick", "a_chk")
    m.seq("a_chk", "a_gw")
    m.seq("a_gw", "a_prev", "Có")
    m.seq("a_prev", "a_crop")
    m.seq("a_crop", "a_end")
    return m


# ---------------------------------------------------------------------------
# Hinh 3.4c - Phan tich anh va so khop san pham
# ---------------------------------------------------------------------------
def diagram_b2():
    m = Model("Hình 3.4c - Phân tích ảnh và so khớp sản phẩm")
    lu, ls = pool(m, "B", "Velura - Tìm kiếm bằng hình ảnh (2/3)")
    m.event("b_start", lu, 0, 0, "Ảnh đã sẵn sàng (từ Hình 3.4b)", "start")
    m.task("b_recv", ls, 1, TOP, "Nhận ảnh đã chọn vùng và kiểm tra giới hạn tần suất", "service")
    m.gateway("b_gw1", ls, 2, TOP, "Trong giới hạn tần suất?")
    stack_fail(m, "b_gw1", 2, "b_rate", "Báo vượt tần suất kèm thời gian chờ",
               "b_end_rate", "Người dùng chờ rồi thử lại", ls)
    m.task("b_ai", ls, 3, TOP, "Gọi AI nhận diện trang phục: loại, màu, phom, chất liệu, phong cách", "service")
    m.gateway("b_gw2", ls, 4, TOP, "AI phản hồi hợp lệ?")
    stack_fail(m, "b_gw2", 4, "b_aierr", "Báo dịch vụ tạm thời lỗi, cho phép thử lại",
               "b_end_ai", "Người dùng chọn thử lại", ls, "Lỗi hoặc quá 15 giây")
    m.gateway("b_gw3", ls, 5, TOP, "Ảnh là trang phục?")
    stack_fail(m, "b_gw3", 5, "b_nf", "Báo không nhận diện được, gợi ý chụp lại một món rõ nét",
               "b_end_nf", "Người dùng chọn ảnh khác hoặc tìm bằng từ khóa", ls)
    m.task("b_match", ls, 6, TOP, "Tạo vector từ mô tả thuộc tính rồi truy vấn sản phẩm đang bán (ngưỡng 0.45, tối đa 20)", "service")
    m.store("b_store", ls, 6, MID, "Kho sản phẩm và vector embedding")
    m.gateway("b_gw4", ls, 7, TOP, "Có sản phẩm tương đồng?")
    stack_fail(m, "b_gw4", 7, "b_empty", "Báo chưa có sản phẩm tương đồng kèm khối Sản phẩm nổi bật",
               "b_end_empty", "Người dùng xem sản phẩm nổi bật hoặc tìm bằng từ khóa", ls)
    m.event("b_end", lu, 8, 0, "Danh sách tương đồng sẵn sàng (chuyển Hình 3.4d)", "end")

    m.seq("b_start", "b_recv")
    m.seq("b_recv", "b_gw1")
    m.seq("b_gw1", "b_ai", "Có")
    m.seq("b_ai", "b_gw2")
    m.seq("b_gw2", "b_gw3", "Có")
    m.seq("b_gw3", "b_match", "Có")
    m.seq("b_match", "b_gw4")
    m.seq("b_gw4", "b_end", "Có")
    m.assoc("b_match", "b_store")
    return m


# ---------------------------------------------------------------------------
# Hinh 3.4d - Toi uu theo Style Quiz, tinh chinh, them vao gio
# ---------------------------------------------------------------------------
def diagram_b3():
    m = Model("Hình 3.4d - Tối ưu theo Style Quiz, tinh chỉnh và thêm vào giỏ")
    lu = "lane_u_C"
    ls = "lane_s_C"
    m.pool("C", "Velura - Tìm kiếm bằng hình ảnh (3/3)", [(lu, U, 2.0), (ls, S, 3.0)])
    m.event("c_start", lu, 0, -0.5, "Danh sách tương đồng sẵn sàng (từ Hình 3.4c)", "start")
    m.task("c_chk", ls, 1, TOP, "Kiểm tra Style Profile của người dùng (Member: CSDL, Guest: phiên)", "service")
    m.store("c_store", ls, 1, MID, "Style Profile")
    m.gateway("c_gw1", ls, 2, TOP, "Đã có Style Profile?")
    m.task("c_score", ls, 3, TOP, "Chấm điểm lại theo dáng người, phong cách, tone da, dịp, ngân sách và gắn nhãn Hợp dáng", "service")
    m.task("c_banner", ls, 2, MID, "Giữ thứ tự tương đồng, khóa lọc Dáng người và mời làm Style Quiz", "send")
    m.task("c_show", ls, 4, TOP, "Hiển thị trang kết quả: ảnh gốc, chip thuộc tính, bộ lọc, lưới sản phẩm", "service")
    m.gateway("c_gw2", lu, 5, 0, "Người dùng muốn làm gì?")
    m.task("c_pick", lu, 6, -0.5, "Nhấp sản phẩm, chọn size, màu và nhấn Thêm vào giỏ hàng", "user")
    m.task("c_cart", ls, 7, TOP, "Kiểm tồn kho, gợi ý size và cập nhật giỏ hàng như quy trình Hình 3.4", "service")
    m.event("c_end_cart", ls, 8, TOP, "Sản phẩm đã vào giỏ hàng", "end")
    m.task("c_ref", lu, 6, 0.5, "Sửa chip thuộc tính, thêm từ khóa hoặc chọn bộ lọc", "user")
    m.task("c_redo", ls, 6, MID, "Áp dụng chỉnh sửa và tìm lại, không cần tải lại ảnh", "service")
    m.event("c_end_ref", ls, 7, MID, "Kết quả được cập nhật, người dùng tiếp tục xem", "end")

    m.seq("c_start", "c_chk")
    m.seq("c_chk", "c_gw1")
    m.assoc("c_chk", "c_store")
    m.seq("c_gw1", "c_score", "Rồi")
    m.seq("c_gw1", "c_banner", "Chưa")
    m.seq("c_score", "c_show")
    m.seq("c_banner", "c_show")
    m.seq("c_show", "c_gw2")
    m.seq("c_gw2", "c_pick", "Xem chi tiết")
    m.seq("c_gw2", "c_ref", "Tinh chỉnh")
    m.seq("c_pick", "c_cart")
    m.seq("c_cart", "c_end_cart")
    m.seq("c_ref", "c_redo")
    m.seq("c_redo", "c_end_ref")
    return m


def original_pages():
    xml = open(ORIG, encoding="utf-8").read()
    pages = re.findall(r"<diagram .*?</diagram>", xml, flags=re.S)
    if len(pages) != 1:
        raise SystemExit("BPMN goc phai co dung 1 trang, thay %d" % len(pages))
    return re.sub(r'name="[^"]*"', 'name="Hình 3.4 - BPMN tìm kiếm gốc (giữ nguyên)"', pages[0], count=1)


def main():
    models = [diagram_b1(), diagram_b2(), diagram_b3()]
    for m in models:
        errs = m.check()
        if errs:
            raise SystemExit("%s: %s" % (m.name, "; ".join(errs)))

    new_xml = bpmn_emit.to_drawio(models)
    head, body = new_xml.split("<mxfile host=\"app.diagrams.net\">", 1)
    merged = head + "<mxfile host=\"app.diagrams.net\">\n  " + original_pages() + "\n" + body
    with open(OUT_DRAWIO, "w", encoding="utf-8") as fh:
        fh.write(merged)
    print("drawio:", OUT_DRAWIO)

    slugs = ["3-4b", "3-4c", "3-4d"]
    for m, slug in zip(models, slugs):
        path = os.path.join(BA_DIR, "timkiem-anh-%s.bpmn" % slug)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(bpmn_emit.to_bpmn(m, slug.replace("-", "_")))
        print("bpmn:", path)
    # PNG: draw.io-export chi ve trang dau nen moi hinh ghi ra mot tep tam
    if "--png" in sys.argv:
        import subprocess
        for m, slug in zip(models, slugs):
            tmp = os.path.join(HERE, "tmp-%s.drawio" % slug)
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(bpmn_emit.to_drawio([m]))
            png = os.path.join(BA_DIR, "timkiem-anh-%s.png" % slug)
            subprocess.run("drawio \"%s\" -o \"%s\" -F png" % (tmp, png), shell=True, check=True)
            os.remove(tmp)
            # nen trong suot hien thanh den o mot so trinh xem -> do len nen trang
            from PIL import Image
            img = Image.open(png).convert("RGBA")
            flat = Image.new("RGBA", img.size, (255, 255, 255, 255))
            flat.alpha_composite(img)
            flat.convert("RGB").save(png)
            print("png:", png)
    # ten hinh de buoc docx doi chieu
    with open(os.path.join(HERE, "pages.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(m.name for m in models))


if __name__ == "__main__":
    main()
