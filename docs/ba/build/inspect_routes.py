# -*- coding: utf-8 -*-
"""In ra cac duong di de soat: do dai so voi khoang cach Manhattan, so lan re, cong dung."""
import sys

import ba_models
from bpmnkit import build, _segments

name = sys.argv[1]
dg = getattr(ba_models, "dia_" + name)()
_, _, report, router = build(dg)
print(report["size"], "giao cat", report["crossings"])
for f in dg.flows:
    rt = router.routes.get(f["id"])
    if not rt:
        print("KHONG ROUTE", f["id"])
        continue
    pts = rt["points"]
    length = sum(abs(a[0] - b[0]) + abs(a[1] - b[1]) for a, b in _segments(pts))
    man = abs(pts[0][0] - pts[-1][0]) + abs(pts[0][1] - pts[-1][1])
    flag = "  <<<" if man and length / max(man, 1) > 1.5 and length - man > 120 else ""
    print("%-34s %s->%s  len=%5d man=%5d bends=%d%s" % (
        f["id"][:34], rt["src_side"], rt["dst_side"], length, man, len(pts) - 2, flag))
