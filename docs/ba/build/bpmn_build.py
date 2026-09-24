# -*- coding: utf-8 -*-
"""Mo hinh BPMN dung chung cho quy trinh khuyen mai 3.1.13.

Mot mo hinh duy nhat sinh ra hai dinh dang: .bpmn (BPMN 2.0 + BPMNDI, mo duoc
tren bpmn.io) va .drawio (mxGraph, mo duoc tren app.diagrams.net). Toa do tinh
tu luoi cot/hang nen hai ban xuat khong the lech nhau.

Bo style draw.io lay nguyen tu khuyenmai.drawio.xml cua du an de cac hinh moi
nam cung quy uoc trinh bay voi cac BPMN da co trong chuong 3.
"""
import html

COL_W = 235
ROW_H = 140
PAD_X = 120
TASK_W, TASK_H = 190, 84
GW = 46
EV = 36
LANE_TITLE = 30
POOL_X, POOL_Y0 = 40, 40
POOL_GAP = 70

S_LANE = "swimlane;html=1;horizontal=0;swimlaneFillColor=none;startSize=30;fontSize=14;"
S_EVENT = ("points=[[0.145,0.145,0],[0.5,0,0],[0.855,0.145,0],[1,0.5,0],[0.855,0.855,0],"
           "[0.5,1,0],[0.145,0.855,0],[0,0.5,0]];shape=mxgraph.bpmn.event;html=1;"
           "verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;"
           "align=center;perimeter=ellipsePerimeter;outlineConnect=0;aspect=fixed;"
           "outline={outline};symbol={symbol};fontSize=14;")
S_GW = ("shape=mxgraph.bpmn.gateway2;html=1;verticalLabelPosition=bottom;"
        "labelBackgroundColor=#ffffff;verticalAlign=top;align=center;"
        "perimeter=rhombusPerimeter;outlineConnect=0;outline=none;symbol=exclusiveGw;"
        "gwType=exclusive;fontSize=15;")
S_TASK = ("shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=10;html=1;"
          "container=1;expand=0;collapsible=0;taskMarker={marker};fontSize=14;")
S_TEXT = "text;html=1;fontSize=14;fontStyle=2;align=center;verticalAlign=middle;whiteSpace=wrap;"
S_STORE = "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=10;fontSize=14;"
S_NOTE = ("html=1;shape=mxgraph.flowchart.annotation_2;align=left;labelPosition=right;"
          "verticalAlign=top;fontSize=13;spacingLeft=10;")
S_SEQ = "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;endFill=1;fontSize=14;"
S_MSG = ("edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;dashed=1;endArrow=open;endFill=0;"
         "startArrow=oval;startFill=0;fontSize=13;")
S_ASSOC = "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;dashed=1;endArrow=none;endFill=0;fontSize=13;"
S_ELBL = "edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;points=[];fontSize=14;"

EVENT_KIND = {
    "start": ("standard", "general"),
    "end": ("end", "general"),
    "timer": ("catching", "timer"),
    "catch": ("catching", "message"),
    "throw": ("throwing", "message"),
}
TASK_BPMN = {"user": "userTask", "service": "serviceTask",
             "send": "sendTask", "manual": "manualTask"}


def esc(t):
    return html.escape(t, quote=True)


def esc_draw(t):
    return esc(t).replace("\n", "&#xa;")


class Model:
    def __init__(self, name):
        self.name = name
        self.pools = []
        self.nodes = []
        self.flows = []

    def pool(self, pid, name, lanes):
        self.pools.append(dict(id=pid, name=name,
                               lanes=[dict(id=l[0], name=l[1], rows=l[2]) for l in lanes]))

    def _add(self, nid, lane, col, row, kind, label, marker=None, w=None, h=None):
        self.nodes.append(dict(id=nid, lane=lane, col=col, row=row, kind=kind,
                               label=label, marker=marker, w=w, h=h))

    def task(self, nid, lane, col, row, label, marker="user"):
        self._add(nid, lane, col, row, "task", label, marker, TASK_W, TASK_H)

    def gateway(self, nid, lane, col, row, question):
        self._add(nid, lane, col, row, "gateway", question, None, GW, GW)

    def event(self, nid, lane, col, row, label, kind="start"):
        self._add(nid, lane, col, row, "event:" + kind, label, None, EV, EV)

    def store(self, nid, lane, col, row, label):
        self._add(nid, lane, col, row, "store", label, None, 150, 84)

    def note(self, nid, lane, col, row, text, w=26, h=104, wrap=58):
        """Khung chu thich BPMN: hinh moc vuong hep, chu chay sang ben phai."""
        words, lines, cur = text.split(), [], ""
        for word in words:
            if cur and len(cur) + 1 + len(word) > wrap:
                lines.append(cur)
                cur = word
            else:
                cur = (cur + " " + word).strip()
        if cur:
            lines.append(cur)
        self._add(nid, lane, col, row, "note", "\n".join(lines), None, w, h)

    def seq(self, src, dst, label=""):
        self.flows.append(dict(id="f_%s_%s" % (src, dst), kind="seq",
                               src=src, dst=dst, label=label))

    def msg(self, src, dst, label=""):
        self.flows.append(dict(id="m_%s_%s" % (src, dst), kind="msg",
                               src=src, dst=dst, label=label))

    def assoc(self, src, dst):
        self.flows.append(dict(id="a_%s_%s" % (src, dst), kind="assoc",
                               src=src, dst=dst, label=""))

    def geometry(self):
        """Tra ve (pool_box, lane_box, node_box) theo toa do tuyet doi."""
        max_col = max(n["col"] for n in self.nodes)
        pool_w = LANE_TITLE + PAD_X + max_col * COL_W + TASK_W / 2.0 + PAD_X
        pool_box, lane_box, y = {}, {}, POOL_Y0
        for p in self.pools:
            ph = sum(l["rows"] * ROW_H for l in p["lanes"])
            pool_box[p["id"]] = (POOL_X, y, pool_w, ph)
            ly = y
            for lane in p["lanes"]:
                lh = lane["rows"] * ROW_H
                lane_box[lane["id"]] = (POOL_X + LANE_TITLE, ly, pool_w - LANE_TITLE, lh)
                ly += lh
            y += ph + POOL_GAP
        node_box = {}
        for n in self.nodes:
            lx, ly, lw, lh = lane_box[n["lane"]]
            cx = lx + PAD_X + n["col"] * COL_W
            cy = ly + lh / 2.0 + n["row"] * ROW_H
            node_box[n["id"]] = (cx - n["w"] / 2.0, cy - n["h"] / 2.0, n["w"], n["h"])
        return pool_box, lane_box, node_box

    def pool_of_lane(self, lane_id):
        for p in self.pools:
            for lane in p["lanes"]:
                if lane["id"] == lane_id:
                    return p["id"]
        raise KeyError(lane_id)

    def check(self):
        """Kiem dinh BPMN 2.0 truoc khi xuat."""
        ids = [n["id"] for n in self.nodes]
        errs = []
        if len(ids) != len(set(ids)):
            errs.append("trung id nut")
        known = set(ids)
        pool_of = {n["id"]: self.pool_of_lane(n["lane"]) for n in self.nodes}
        kind_of = {n["id"]: n["kind"] for n in self.nodes}
        for f in self.flows:
            for side in ("src", "dst"):
                if f[side] not in known:
                    errs.append("%s tro toi nut khong ton tai: %s" % (f["id"], f[side]))
            if f["src"] in known and f["dst"] in known:
                same_pool = pool_of[f["src"]] == pool_of[f["dst"]]
                if f["kind"] == "seq" and not same_pool:
                    errs.append("sequence flow vuot pool: %s" % f["id"])
                if f["kind"] == "msg" and same_pool:
                    errs.append("message flow trong cung pool: %s" % f["id"])
                if f["kind"] == "msg" and "gateway" in (kind_of[f["src"]], kind_of[f["dst"]]):
                    errs.append("message flow noi vao gateway: %s" % f["id"])
        for n in self.nodes:
            if n["kind"] == "gateway":
                outs = [f for f in self.flows if f["kind"] == "seq" and f["src"] == n["id"]]
                if len(outs) < 2:
                    errs.append("gateway %s co duoi hai nhanh ra" % n["id"])
                if any(not f["label"] for f in outs):
                    errs.append("nhanh ra cua gateway %s thieu nhan dieu kien" % n["id"])
            if n["kind"] == "event:start":
                if any(f["kind"] == "seq" and f["dst"] == n["id"] for f in self.flows):
                    errs.append("start event %s co luong vao" % n["id"])
            if n["kind"] == "event:end":
                if any(f["kind"] == "seq" and f["src"] == n["id"] for f in self.flows):
                    errs.append("end event %s co luong ra" % n["id"])
            if n["kind"] in ("task", "gateway") or n["kind"].startswith("event:"):
                if n["kind"] not in ("event:start",):
                    if not any(f["kind"] == "seq" and f["dst"] == n["id"] for f in self.flows):
                        errs.append("nut %s khong co luong vao" % n["id"])
                if n["kind"] not in ("event:end",):
                    if not any(f["kind"] == "seq" and f["src"] == n["id"] for f in self.flows):
                        errs.append("nut %s khong co luong ra" % n["id"])
        return errs
