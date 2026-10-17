# -*- coding: utf-8 -*-
"""Sao luu ban goc, ghi ban BPMN hoan thien vao docs/ba va export PNG cuoi."""
import re
import shutil
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

BA = Path(__file__).resolve().parent.parent
OUT = Path(__file__).resolve().parent / "out"
BK = BA / "backup-truoc-khi-hoan-thien"
BK.mkdir(exist_ok=True)

ORIG = [
    "quan ly san pham cu.drawio.xml",
    "quan ly danh gia review.drawio.xml",
    "Quy trình quản lý sản phẩm .docx",
    "Quy trình quản lý đánh giá và review .docx",
]
for n in ORIG:
    src, dst = BA / n, BK / n
    if src.exists() and not dst.exists():
        shutil.copy2(src, dst)
        print("backup", n)


def read(p):
    return Path(p).read_text(encoding="utf-8")


def pages(xml):
    """Tach cac the <diagram> trong mot file mxfile."""
    root = ET.fromstring(xml)
    return root.findall("diagram")


# 1) review: giu nguyen 1 trang
shutil.copyfile(OUT / "quan_ly_danh_gia_review.drawio.xml", BA / "quan ly danh gia review.drawio.xml")

# 2) san pham: trang 1 = quy trinh chinh, trang 2 = xu ly anh AI
main = read(OUT / "quan_ly_san_pham.drawio.xml")
sub = read(OUT / "quan_ly_san_pham_anh_ai.drawio.xml")
m = re.search(r"<diagram\b.*?</diagram>", sub, re.S)
assert m, "khong tim thay <diagram> trong ban anh AI"
merged = main.replace("</mxfile>", m.group(0) + "\n</mxfile>")
ET.fromstring(merged)  # kiem tra well-formed
(BA / "quan ly san pham cu.drawio.xml").write_text(merged, encoding="utf-8")

# 3) ban .bpmn + png di kem
for slug in ("quan_ly_san_pham", "quan_ly_san_pham_anh_ai", "quan_ly_danh_gia_review"):
    shutil.copyfile(OUT / f"{slug}.bpmn", BA / f"{slug}.bpmn")
    shutil.copyfile(OUT / f"{slug}.png", BA / f"{slug}.png")
    ET.parse(BA / f"{slug}.bpmn")
    print("ok", slug)
print("pages san pham:", len(pages(merged)))
