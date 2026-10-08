# -*- coding: utf-8 -*-
"""Kiem tra tep drawio / bpmn la XML hop le va dem trang, phan tu."""
import glob
import os
import xml.etree.ElementTree as ET

BA = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
root = ET.parse(os.path.join(BA, "Velura-3.1.3-Tim-kiem-bang-hinh-anh.drawio")).getroot()
for d in root.findall("diagram"):
    print("trang:", d.get("name"), "- cells:", len(d.findall(".//mxCell")))
ids = [c.get("id") for c in root.iter("mxCell")]
for f in sorted(glob.glob(os.path.join(BA, "timkiem-anh-*.bpmn"))):
    r = ET.parse(f).getroot()
    ns = "{http://www.omg.org/spec/BPMN/20100524/MODEL}"
    procs = r.findall(ns + "process")
    n_flow = sum(len(p.findall(ns + "sequenceFlow")) for p in procs)
    print(os.path.basename(f), "OK, sequenceFlow =", n_flow)
