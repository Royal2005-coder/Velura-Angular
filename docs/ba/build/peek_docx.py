# -*- coding: utf-8 -*-
import sys
from docx import Document
from docx.oxml.ns import qn

path, *idx = sys.argv[1:]
d = Document(path)
body = list(d.element.body.iterchildren())
for i in idx:
    el = body[int(i)]
    xml = el.xml
    print("=== body[%s] %s len=%d" % (i, el.tag.split('}')[1], len(xml)))
    print(xml[:3500])
