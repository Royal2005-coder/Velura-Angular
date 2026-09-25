# -*- coding: utf-8 -*-
"""Dung tep docx muc 3.1.13 tren dung khuon mau Khuyenmai.docx.

Mo tep mau, xoa sach phan than bai roi viet lai noi dung moi bang chinh cac
style cua mau (normal, Heading 3..6) va dung lai dinh dang doan, o bang, luoi
cot cua mau. Lam vay de ban giao nam dung trong bo tai lieu chuong 3 ma khong
lech font, le hay gian dong.
"""
import copy
import os

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Cm

import noidung

HERE = os.path.dirname(os.path.abspath(__file__))
BA_DIR = os.path.abspath(os.path.join(HERE, ".."))
TEMPLATE = os.path.join(BA_DIR, "_mau-Khuyenmai.docx")
OUT = os.path.join(BA_DIR, "Velura-3.1.13-Quy-trinh-khuyen-mai.docx")

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
IMG_W = Cm(15.25)          # dung bang be ngang chu cua mau
GRID = [2235, 2235, 2235, 2340]   # twips, lay tu bang cua mau


class Template:
    """Giu lai cac manh dinh dang lay tu tep mau de tai su dung."""

    def __init__(self, doc):
        self.body_pPr = None
        self.body_rPr = None
        self.img_pPr = None
        self.cell_pPr = None
        self.cell_rPr = None
        self.tblPr = None

        for p in doc.paragraphs:
            if p.style.name == "normal" and len(p.text) > 80 and self.body_pPr is None:
                self.body_pPr = self._pPr(p)
                self.body_rPr = self._rPr(p)
            if "graphicData" in p._p.xml and self.img_pPr is None:
                self.img_pPr = self._pPr(p)

        table = doc.tables[0]
        self.tblPr = copy.deepcopy(table._tbl.find(W + "tblPr"))
        cell = table.rows[1].cells[2]
        self.cell_pPr = self._pPr(cell.paragraphs[0])
        self.cell_rPr = self._rPr(cell.paragraphs[0])

    @staticmethod
    def _pPr(p):
        el = p._p.find(W + "pPr")
        return copy.deepcopy(el) if el is not None else None

    @staticmethod
    def _rPr(p):
        if not p.runs:
            return None
        el = p.runs[0]._r.find(W + "rPr")
        return copy.deepcopy(el) if el is not None else None


def normalise_measures(doc):
    """Lam tron cac so do dang thuc do Google Docs sinh ra.

    Ban xuat cua Google Docs ghi le trang kieu 1797.1653543307089 twips. Doc
    duoc, nhung python-docx doc bang int() nen vo ngay khi can be ngang kha
    dung de dat anh hoac bang.
    """
    for el in doc.element.body.iter():
        for name, value in list(el.attrib.items()):
            if "." in value:
                try:
                    el.set(name, str(int(round(float(value)))))
                except ValueError:
                    pass


def clear_body(doc):
    """Xoa het noi dung than bai, giu lai sectPr va cac quan he anh khong dung."""
    body = doc.element.body
    for child in list(body.iterchildren()):
        if child.tag == qn("w:sectPr"):
            continue
        body.remove(child)
    # bo anh cu cua mau de tep ban giao khong mang theo phan thua
    for rid, rel in list(doc.part.rels.items()):
        if "image" in rel.reltype:
            doc.part.drop_rel(rid)


def apply_pPr(p, pPr):
    if pPr is None:
        return
    old = p._p.find(W + "pPr")
    if old is not None:
        p._p.remove(old)
    p._p.insert(0, copy.deepcopy(pPr))


def apply_rPr(run, rPr):
    if rPr is None:
        return
    old = run._r.find(W + "rPr")
    if old is not None:
        run._r.remove(old)
    run._r.insert(0, copy.deepcopy(rPr))


def add_para(doc, tpl, text, style="normal", indent=True):
    p = doc.add_paragraph(style=style)
    if style == "normal":
        apply_pPr(p, tpl.body_pPr)
        if not indent:
            pPr = p._p.find(W + "pPr")
            ind = pPr.find(W + "ind")
            if ind is not None:
                pPr.remove(ind)
    run = p.add_run(text)
    if style == "normal":
        apply_rPr(run, tpl.body_rPr)
    return p


def add_picture(doc, tpl, path):
    p = doc.add_paragraph(style="normal")
    apply_pPr(p, tpl.img_pPr)
    p.add_run().add_picture(path, width=IMG_W)
    return p


def build_table(doc, tpl):
    table = doc.add_table(rows=1, cols=4)

    old = table._tbl.find(W + "tblPr")
    if old is not None:
        table._tbl.remove(old)
    table._tbl.insert(0, copy.deepcopy(tpl.tblPr))

    grid = table._tbl.find(W + "tblGrid")
    for i, col in enumerate(grid.findall(W + "gridCol")):
        col.set(qn("w:w"), str(GRID[i]))

    def fill(cell, text, bold):
        cell.text = ""
        p = cell.paragraphs[0]
        apply_pPr(p, tpl.cell_pPr)
        run = p.add_run(text)
        apply_rPr(run, tpl.cell_rPr)
        run.bold = bold

    for i, name in enumerate(noidung.BANG_HEADER):
        fill(table.rows[0].cells[i], name, True)
    for row_data in noidung.BANG:
        cells = table.add_row().cells
        for i, value in enumerate(row_data):
            fill(cells[i], value, i == 0)

    for row in table.rows:
        for i, cell in enumerate(row.cells):
            cell.width = Cm(GRID[i] / 1440.0 * 2.54)
    return table


def build():
    doc = Document(TEMPLATE)
    tpl = Template(doc)
    normalise_measures(doc)
    clear_body(doc)

    add_para(doc, tpl, noidung.TIEU_DE, style="Heading 3")

    add_para(doc, tpl, noidung.MUC_1, style="Heading 4")
    for item in noidung.MO_TA:
        if item[0] == "para":
            add_para(doc, tpl, item[1])
        else:
            _, fname, cap, lead = item
            add_para(doc, tpl, lead)
            path = os.path.join(BA_DIR, fname)
            if not os.path.exists(path):
                raise SystemExit("thieu anh: " + path)
            add_picture(doc, tpl, path)
            add_para(doc, tpl, cap, style="Heading 6")

    add_para(doc, tpl, noidung.MUC_2, style="Heading 4")
    add_para(doc, tpl, noidung.BANG_CAPTION, style="Heading 5")
    build_table(doc, tpl)

    add_para(doc, tpl, noidung.MUC_3, style="Heading 4")
    for title, mota, xuly in noidung.NGOAI_LE:
        add_para(doc, tpl, title, indent=False)
        add_para(doc, tpl, "Mô tả: " + mota, indent=False)
        add_para(doc, tpl, "Cách xử lý: " + xuly, indent=False)

    doc.save(OUT)
    return OUT


if __name__ == "__main__":
    print(build())
