# -*- coding: utf-8 -*-
"""Sinh .drawio.xml / .bpmn / .png cho cac so do BPMN cua quy trinh san pham va danh gia.

Chay:  python make_bpmn.py [ten_so_do ...]   (mac dinh: tat ca)
Ket qua nam trong  build/out/
"""
import os
import subprocess
import sys

import ba_models
from bpmnkit import build

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

DIAGRAMS = {
    "anh_ai": ba_models.dia_image_ai,
}
for _name in ("product", "review"):
    _fn = getattr(ba_models, "dia_" + _name, None)
    if _fn:
        DIAGRAMS[_name] = _fn


def main(names):
    os.makedirs(OUT, exist_ok=True)
    for name in names or DIAGRAMS:
        dg = DIAGRAMS[name]()
        drawio, bpmn, report, router = build(dg)
        base = os.path.join(OUT, dg.slug)
        with open(base + ".drawio.xml", "w", encoding="utf-8") as fh:
            fh.write(drawio)
        with open(base + ".bpmn", "w", encoding="utf-8") as fh:
            fh.write(bpmn)
        print("== %s  %dx%d  giao cat=%d" % (name, report["size"][0], report["size"][1], report["crossings"]))
        for key in ("rules", "geometry", "warnings"):
            for line in report[key]:
                print("  [%s] %s" % (key, line))
        if not (report["rules"] or report["geometry"]):
            print("  kiem dinh OK")
        if "--png" in sys.argv:
            subprocess.run(["node", os.path.join(HERE, "export_png.cjs"), base + ".drawio.xml",
                            base + ".png", "2", "24"], check=False)


if __name__ == "__main__":
    main([a for a in sys.argv[1:] if not a.startswith("--")])
