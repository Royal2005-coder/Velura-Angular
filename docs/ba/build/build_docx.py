# -*- coding: utf-8 -*-
"""Dung tep docx muc 3.1.13 tu noidung.py va cac PNG da render."""
import os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

import noidung

BA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(BA_DIR, "Velura-3.1.13-Quy-trinh-khuyen-mai.docx")

FONT = "Times New Roman"
SIZE_BODY = Pt(13)
SIZE_TABLE = Pt(11)
SIZE_CAPTION = Pt(12)
IMG_W = Cm(16.5)


def set_font(run, size=SIZE_BODY, bold=False, italic=False):
    run.font.name = FONT
    run.font.size = size
    run.bold = bold
    run.italic = italic
    run._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)


def body(doc, text, first_indent=True):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p.paragraph_format.space_after = Pt(6)
    p.paragraph_format.line_spacing = 1.4
    if first_indent:
        p.paragraph_format.first_line_indent = Cm(1.0)
    set_font(p.add_run(text))
    return p


def heading(doc, text, size=Pt(14), space_before=Pt(14)):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = space_before
    p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.keep_with_next = True
    set_font(p.add_run(text), size=size, bold=True)
    return p


def caption(doc, text):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(12)
    set_font(p.add_run(text), size=SIZE_CAPTION, italic=True)
    return p


def picture(doc, path):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(2)
    p.add_run().add_picture(path, width=IMG_W)
    return p


def shade(cell, hexcolor):
    tcPr = cell._tc.get_or_add_tcPr()
    el = OxmlElement("w:shd")
    el.set(qn("w:val"), "clear")
    el.set(qn("w:fill"), hexcolor)
    tcPr.append(el)


def build():
    doc = Document()

    section = doc.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.left_margin = Cm(2.5)
    section.right_margin = Cm(2.0)
    section.top_margin = Cm(2.0)
    section.bottom_margin = Cm(2.0)

    style = doc.styles["Normal"]
    style.font.name = FONT
    style.font.size = SIZE_BODY
    style.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)

    heading(doc, noidung.TIEU_DE, size=Pt(15), space_before=Pt(0))

    # 3.1.13.1
    heading(doc, noidung.MUC_1)
    for item in noidung.MO_TA:
        if item[0] == "para":
            body(doc, item[1])
        else:
            _, fname, cap, lead = item
            body(doc, lead)
            path = os.path.join(BA_DIR, fname)
            if not os.path.exists(path):
                raise SystemExit("thieu anh: " + path)
            picture(doc, path)
            caption(doc, cap)

    # 3.1.13.2
    heading(doc, noidung.MUC_2)
    caption(doc, noidung.BANG_CAPTION)

    table = doc.add_table(rows=1, cols=4)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    widths = [Cm(2.6), Cm(3.2), Cm(5.6), Cm(5.1)]

    hdr = table.rows[0]
    hdr.cells[0].paragraphs[0].paragraph_format.keep_with_next = True
    for i, name in enumerate(noidung.BANG_HEADER):
        cell = hdr.cells[i]
        cell.text = ""
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        set_font(p.add_run(name), size=SIZE_TABLE, bold=True)
        shade(cell, "E8E8E8")

    for row_data in noidung.BANG:
        cells = table.add_row().cells
        for i, value in enumerate(row_data):
            cells[i].text = ""
            p = cells[i].paragraphs[0]
            p.alignment = (WD_ALIGN_PARAGRAPH.LEFT if i < 2
                           else WD_ALIGN_PARAGRAPH.JUSTIFY)
            p.paragraph_format.space_after = Pt(2)
            set_font(p.add_run(value), size=SIZE_TABLE, bold=(i == 0))

    for row in table.rows:
        for i, cell in enumerate(row.cells):
            cell.width = widths[i]

    # 3.1.13.3
    heading(doc, noidung.MUC_3)
    for title, mota, xuly in noidung.NGOAI_LE:
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(10)
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.keep_with_next = True
        set_font(p.add_run(title), bold=True)

        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.line_spacing = 1.4
        set_font(p.add_run("Mô tả: "), italic=True)
        set_font(p.add_run(mota))

        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.line_spacing = 1.4
        set_font(p.add_run("Cách xử lý: "), italic=True)
        set_font(p.add_run(xuly))

    doc.save(OUT)
    return OUT


if __name__ == "__main__":
    print(build())
