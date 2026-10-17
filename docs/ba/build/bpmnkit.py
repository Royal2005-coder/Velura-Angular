# -*- coding: utf-8 -*-
"""bpmnkit - dung so do BPMN 2.0 cho tai lieu quy trinh admin cua Velura.

Mot mo hinh duy nhat sinh ra:
  * .drawio.xml  (mxGraph, mo duoc tren app.diagrams.net)
  * .bpmn        (BPMN 2.0 + BPMNDI, mo duoc tren bpmn.io)
  * kiem dinh    (luat BPMN + hinh hoc: chong cheo nut, duong di xuyen nut)

Toa do tinh tu luoi cot/hang. Moi luong (sequence / message / association) duoc
tu dinh tuyen vuong goc bang mot bo tim duong co diem phat: tranh xuyen nut,
tranh chong len nhan, han che giao cat va chong lan giua cac luong.
"""
import html
import math

# --------------------------------------------------------------------------
# Kich thuoc
# --------------------------------------------------------------------------
ROW_H = 130
TASK_W, TASK_H = 176, 88
GW = 50
EV = 36
STORE_W, STORE_H = 110, 74
LANE_TITLE = 30
POOL_X, POOL_Y0 = 40, 40
POOL_GAP = 96
PAD_L, PAD_R = 40, 40
STUB = 18          # doan thang toi thieu roi khoi / vao mot cong
MARGIN = 7         # le an toan quanh nut khi do xuyen
CHAR_W = 7.3       # be ngang uoc luong cua mot ky tu co chu 14
CHAR_W_NOTE = 6.6
LINE_H = 18

FONT = 14

# --------------------------------------------------------------------------
# Style draw.io
# --------------------------------------------------------------------------
S_POOL = "swimlane;html=1;horizontal=0;swimlaneFillColor=none;startSize=30;fontSize=15;fontStyle=1;"
S_LANE = "swimlane;html=1;horizontal=0;swimlaneFillColor=none;startSize=30;fontSize=14;"
S_EVENT = ("points=[[0.145,0.145,0],[0.5,0,0],[0.855,0.145,0],[1,0.5,0],[0.855,0.855,0],"
           "[0.5,1,0],[0.145,0.855,0],[0,0.5,0]];shape=mxgraph.bpmn.event;html=1;"
           "verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;"
           "align=center;perimeter=ellipsePerimeter;outlineConnect=0;aspect=fixed;"
           "outline={outline};symbol={symbol};fontSize=13;")
S_GW = ("shape=mxgraph.bpmn.gateway2;html=1;verticalLabelPosition=bottom;"
        "verticalAlign=top;align=center;perimeter=rhombusPerimeter;outlineConnect=0;"
        "outline=none;symbol={symbol};gwType={gwtype};fontSize=13;")
S_GWLABEL = ("text;html=1;align=right;verticalAlign=bottom;whiteSpace=nowrap;fontSize=13;"
             "fontStyle=2;labelBackgroundColor=#ffffff;")
S_TASK = ("shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=10;html=1;"
          "container=1;expand=0;collapsible=0;taskMarker={marker};fontSize=14;")
S_CALL = S_TASK + "isLoopSub=1;strokeWidth=3;"
S_STORE = "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=10;fontSize=13;"
S_NOTE = ("html=1;shape=mxgraph.flowchart.annotation_2;align=left;labelPosition=right;"
          "verticalAlign=middle;fontSize=13;spacingLeft=8;")
S_SEQ = "rounded=0;html=1;jumpStyle=arc;jumpSize=10;endArrow=block;endFill=1;fontSize=13;"
S_MSG = ("rounded=0;html=1;jumpStyle=arc;jumpSize=10;dashed=1;endArrow=open;endFill=0;"
         "startArrow=oval;startFill=0;fontSize=13;")
S_ASSOC = "rounded=0;html=1;dashed=1;dashPattern=1 3;endArrow=none;endFill=0;fontSize=12;"
S_ELBL = ("edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;points=[];"
          "labelBackgroundColor=#ffffff;fontSize=13;")

EVENT_KIND = {            # (outline, symbol, ten BPMN)
    "start": ("standard", "general"),
    "msgstart": ("standard", "message"),
    "end": ("end", "general"),
    "terminate": ("end", "terminate"),
    "timer": ("catching", "timer"),
    "catch": ("catching", "message"),
    "throw": ("throwing", "message"),
}
GW_KIND = {               # (symbol, gwType)
    "xor": ("exclusiveGw", "exclusive"),
    "and": ("parallelGw", "parallel"),
}
TASK_BPMN = {"user": "userTask", "service": "serviceTask", "send": "sendTask",
             "receive": "receiveTask", "manual": "manualTask", "script": "scriptTask",
             "businessRule": "businessRuleTask"}


def esc(t):
    return html.escape(t, quote=True)


def esc_draw(t):
    return esc(t).replace("\n", "&#xa;")


def wrap_text(text, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur:
        lines.append(cur)
    return lines


class Rect:
    __slots__ = ("x", "y", "w", "h")

    def __init__(self, x, y, w, h):
        self.x, self.y, self.w, self.h = x, y, w, h

    @property
    def cx(self):
        return self.x + self.w / 2.0

    @property
    def cy(self):
        return self.y + self.h / 2.0

    @property
    def r(self):
        return self.x + self.w

    @property
    def b(self):
        return self.y + self.h

    def inflate(self, m):
        return Rect(self.x - m, self.y - m, self.w + 2 * m, self.h + 2 * m)

    def overlaps(self, o):
        return self.x < o.r and o.x < self.r and self.y < o.b and o.y < self.b

    def tup(self):
        return (self.x, self.y, self.w, self.h)


# --------------------------------------------------------------------------
# Mo hinh
# --------------------------------------------------------------------------
class Diagram:
    def __init__(self, slug, title, colw):
        self.slug, self.title, self.colw = slug, title, list(colw)
        self.pools = []
        self.nodes = []
        self.flows = []
        self._geo = None

    # ---- khai bao pool / lane ---------------------------------------------
    def pool(self, pid, name, lanes):
        """lanes: [(lane_id, lane_name, so_hang)]"""
        self.pools.append(dict(id=pid, name=name, blackbox=False,
                               lanes=[dict(id=l[0], name=l[1], rows=l[2],
                                           row_h=(l[3] if len(l) > 3 else ROW_H)) for l in lanes]))

    def blackbox(self, pid, name, height=64):
        self.pools.append(dict(id=pid, name=name, blackbox=True, height=height, lanes=[]))

    # ---- nut -----------------------------------------------------------------
    def _add(self, nid, kind, lane, col, row, label, **kw):
        d = dict(id=nid, kind=kind, lane=lane, col=col, row=row, label=label)
        d.update(kw)
        self.nodes.append(d)

    def task(self, nid, lane, col, row, label, marker="user"):
        self._add(nid, "task", lane, col, row, label, marker=marker)

    def call(self, nid, lane, col, row, label):
        self._add(nid, "call", lane, col, row, label, marker="abstract")

    def gateway(self, nid, lane, col, row, label="", gtype="xor"):
        self._add(nid, "gateway", lane, col, row, label, gtype=gtype)

    def event(self, nid, lane, col, row, label, etype="start", lab="bottom"):
        self._add(nid, "event", lane, col, row, label, etype=etype, lab=lab)

    def store(self, nid, lane, col, row, label):
        self._add(nid, "store", lane, col, row, label)

    def note(self, nid, lane, col, row, text, wrap=40):
        self._add(nid, "note", lane, col, row, text, wrap=wrap)

    # ---- luong ---------------------------------------------------------------
    def seq(self, src, dst, label="", **hint):
        self.flows.append(dict(id="Flow_%s__%s" % (src, dst), kind="seq", src=src, dst=dst,
                               label=label, hint=hint))

    def msg(self, src, dst, label="", **hint):
        self.flows.append(dict(id="Msg_%s__%s" % (src, dst), kind="msg", src=src, dst=dst,
                               label=label, hint=hint))

    def assoc(self, src, dst, **hint):
        self.flows.append(dict(id="Assoc_%s__%s" % (src, dst), kind="assoc", src=src, dst=dst,
                               label="", hint=hint))

    # ---- hinh hoc ------------------------------------------------------------
    def colx(self, c):
        """Tam cot c (c co the le, noi suy giua cac cot)."""
        lo = int(math.floor(c))
        frac = c - lo

        def center(i):
            return PAD_L + sum(self.colw[:i]) + self.colw[i] / 2.0
        if frac == 0:
            return center(lo)
        return center(lo) + (center(lo + 1) - center(lo)) * frac

    def geometry(self):
        if self._geo:
            return self._geo
        self.lane_rowh = {l["id"]: l["row_h"] for p in self.pools for l in p["lanes"]}
        inner_w = PAD_L + sum(self.colw) + PAD_R
        pool_w = LANE_TITLE + inner_w
        pool_box, lane_box, y = {}, {}, POOL_Y0
        for p in self.pools:
            if p["blackbox"]:
                pool_box[p["id"]] = Rect(POOL_X, y, pool_w, p["height"])
                y += p["height"] + POOL_GAP
                continue
            ph = sum(l["rows"] * l["row_h"] for l in p["lanes"])
            pool_box[p["id"]] = Rect(POOL_X, y, pool_w, ph)
            ly = y
            for lane in p["lanes"]:
                lh = lane["rows"] * lane["row_h"]
                lane_box[lane["id"]] = Rect(POOL_X + LANE_TITLE, ly, pool_w - LANE_TITLE, lh)
                ly += lh
            y += ph + POOL_GAP
        node_box, label_box = {}, {}
        for n in self.nodes:
            lane = lane_box[n["lane"]]
            cx = POOL_X + LANE_TITLE + self.colx(n["col"])
            cy = lane.cy + n["row"] * self.lane_rowh[n["lane"]]
            k = n["kind"]
            if k in ("task", "call"):
                w, h = TASK_W, TASK_H
            elif k == "gateway":
                w = h = GW
            elif k == "event":
                w = h = EV
            elif k == "store":
                w, h = STORE_W, STORE_H
            else:  # note: rect gom khung ngoac + chu
                lines = wrap_text(n["label"], n["wrap"])
                n["_lines"] = lines
                tw = max(len(s) for s in lines) * CHAR_W_NOTE + 14
                th = max(len(lines) * 17 + 8, 44)
                # khung ngoac rong 14; chu nam ben phai
                node_box[n["id"]] = Rect(cx - 7, cy - th / 2.0, 14 + tw, th)
                n["_bracket"] = Rect(cx - 7, cy - th / 2.0, 14, th)
                continue
            node_box[n["id"]] = Rect(cx - w / 2.0, cy - h / 2.0, w, h)
            r = node_box[n["id"]]
            if k == "gateway" and n["label"]:
                lines = n["label"].split("\n")
                lw = max(len(s) for s in lines) * CHAR_W + 10
                # nhan nam o goc tren-trai de khong chan cong phia tren cua nut
                label_box[n["id"]] = Rect(r.cx - 6 - lw, r.cy - TASK_H / 2.0 - 5 - len(lines) * LINE_H,
                                          lw, len(lines) * LINE_H)
                n["_lines"] = lines
            if k == "event" and n["label"]:
                lines = n["label"].split("\n")
                lw = max(len(s) for s in lines) * CHAR_W + 10
                if n.get("lab") == "right":
                    label_box[n["id"]] = Rect(r.r + 4, r.cy - len(lines) * LINE_H / 2.0,
                                              lw, len(lines) * LINE_H)
                else:
                    label_box[n["id"]] = Rect(r.cx - lw / 2.0, r.b + 3, lw, len(lines) * LINE_H)
        self._geo = (pool_box, lane_box, node_box, label_box)
        return self._geo

    def pool_of_lane(self, lane_id):
        for p in self.pools:
            for lane in p["lanes"]:
                if lane["id"] == lane_id:
                    return p["id"]
        raise KeyError(lane_id)

    def pool_of_node(self, nid):
        for n in self.nodes:
            if n["id"] == nid:
                return self.pool_of_lane(n["lane"])
        return nid if any(p["id"] == nid for p in self.pools) else None

    def node(self, nid):
        for n in self.nodes:
            if n["id"] == nid:
                return n
        return None

    # ---- kiem dinh luat BPMN ---------------------------------------------------
    def check_rules(self):
        errs = []
        ids = [n["id"] for n in self.nodes]
        if len(ids) != len(set(ids)):
            errs.append("trung id nut")
        known = set(ids) | {p["id"] for p in self.pools if p["blackbox"]}
        kind_of = {n["id"]: n for n in self.nodes}
        for f in self.flows:
            for side in ("src", "dst"):
                if f[side] not in known:
                    errs.append("%s tro toi nut khong ton tai: %s" % (f["id"], f[side]))
            if f["src"] not in known or f["dst"] not in known:
                continue
            sp, dp = self.pool_of_node(f["src"]), self.pool_of_node(f["dst"])
            if f["kind"] == "seq" and sp != dp:
                errs.append("sequence flow vuot pool: %s" % f["id"])
            if f["kind"] == "msg":
                if sp == dp:
                    errs.append("message flow trong cung pool: %s" % f["id"])
                for e in (f["src"], f["dst"]):
                    if e in kind_of and kind_of[e]["kind"] == "gateway":
                        errs.append("message flow noi vao gateway: %s" % f["id"])
        for n in self.nodes:
            k = n["kind"]
            if k == "gateway":
                outs = [f for f in self.flows if f["kind"] == "seq" and f["src"] == n["id"]]
                ins = [f for f in self.flows if f["kind"] == "seq" and f["dst"] == n["id"]]
                if len(outs) >= 2 and any(not f["label"] for f in outs):
                    errs.append("nhanh ra cua gateway %s thieu nhan dieu kien" % n["id"])
                if len(outs) < 1 or len(ins) < 1:
                    errs.append("gateway %s thieu luong vao hoac ra" % n["id"])
                if len(outs) == 1 and len(ins) < 2:
                    errs.append("gateway %s khong chia cung khong gop" % n["id"])
            if k in ("task", "call", "gateway", "event"):
                et = n.get("etype")
                has_in = any(f["kind"] == "seq" and f["dst"] == n["id"] for f in self.flows)
                has_out = any(f["kind"] == "seq" and f["src"] == n["id"] for f in self.flows)
                has_msg_in = any(f["kind"] == "msg" and f["dst"] == n["id"] for f in self.flows)
                if et in ("start", "msgstart"):
                    if has_in:
                        errs.append("start event %s co luong vao" % n["id"])
                elif not has_in:
                    errs.append("nut %s khong co luong vao" % n["id"])
                if et in ("end", "terminate"):
                    if has_out:
                        errs.append("end event %s co luong ra" % n["id"])
                elif not has_out:
                    errs.append("nut %s khong co luong ra" % n["id"])
                if et == "msgstart" and not has_msg_in:
                    errs.append("message start %s khong co message flow vao" % n["id"])
            if k == "task" and n["marker"] == "receive":
                if not any(f["kind"] == "msg" and f["dst"] == n["id"] for f in self.flows):
                    errs.append("receive task %s khong co message flow vao" % n["id"])
            if k == "task" and n["marker"] == "send":
                if not any(f["kind"] == "msg" and f["src"] == n["id"] for f in self.flows):
                    errs.append("send task %s khong co message flow ra" % n["id"])
        return errs


# --------------------------------------------------------------------------
# Dinh tuyen
# --------------------------------------------------------------------------
def _seg_hits_rect(a, b, r):
    """Doan truc giao a-b cat phan trong (mo) cua hinh chu nhat r."""
    (x1, y1), (x2, y2) = a, b
    if abs(y1 - y2) < 1e-6:          # ngang
        if not (r.y < y1 < r.b):
            return False
        lo, hi = min(x1, x2), max(x1, x2)
        return max(lo, r.x) < min(hi, r.r) - 1e-6
    if abs(x1 - x2) < 1e-6:          # doc
        if not (r.x < x1 < r.r):
            return False
        lo, hi = min(y1, y2), max(y1, y2)
        return max(lo, r.y) < min(hi, r.b) - 1e-6
    return True


def _segments(pts):
    return [(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]


def _simplify(pts):
    out = []
    for p in pts:
        if out and abs(out[-1][0] - p[0]) < 1e-6 and abs(out[-1][1] - p[1]) < 1e-6:
            continue
        out.append(p)
    changed = True
    while changed and len(out) > 2:
        changed = False
        for i in range(1, len(out) - 1):
            a, b, c = out[i - 1], out[i], out[i + 1]
            if (abs(a[0] - b[0]) < 1e-6 and abs(b[0] - c[0]) < 1e-6) or \
               (abs(a[1] - b[1]) < 1e-6 and abs(b[1] - c[1]) < 1e-6):
                del out[i]
                changed = True
                break
    return out


def _reverses(pts):
    for i in range(len(pts) - 2):
        ax, ay = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
        bx, by = pts[i + 2][0] - pts[i + 1][0], pts[i + 2][1] - pts[i + 1][1]
        if ax * bx + ay * by < -1e-6:
            return True
    return False


def _cross_and_overlap(pts, other_segs):
    """Dem giao cat vuong goc va chieu dai chong song song voi cac doan khac."""
    cross, overlap = 0, 0.0
    for (a, b) in _segments(pts):
        for (c, d) in other_segs:
            ah, ch = abs(a[1] - b[1]) < 1e-6, abs(c[1] - d[1]) < 1e-6
            if ah and not ch:
                if min(a[0], b[0]) + 1 < c[0] < max(a[0], b[0]) - 1 and \
                   min(c[1], d[1]) + 1 < a[1] < max(c[1], d[1]) - 1:
                    cross += 1
            elif (not ah) and ch:
                if min(c[0], d[0]) + 1 < a[0] < max(c[0], d[0]) - 1 and \
                   min(a[1], b[1]) + 1 < c[1] < max(a[1], b[1]) - 1:
                    cross += 1
            elif ah and ch and abs(a[1] - c[1]) < 2:
                lo, hi = max(min(a[0], b[0]), min(c[0], d[0])), min(max(a[0], b[0]), max(c[0], d[0]))
                if hi - lo > 3:
                    overlap += hi - lo
            elif (not ah) and (not ch) and abs(a[0] - c[0]) < 2:
                lo, hi = max(min(a[1], b[1]), min(c[1], d[1])), min(max(a[1], b[1]), max(c[1], d[1]))
                if hi - lo > 3:
                    overlap += hi - lo
    return cross, overlap


class Router:
    def __init__(self, dg):
        self.dg = dg
        self.pool_box, self.lane_box, self.node_box, self.label_box = dg.geometry()
        self.obstacles = []          # (Rect goc, owner)
        for n in dg.nodes:
            self.obstacles.append((self.node_box[n["id"]], n["id"]))
        for nid, r in self.label_box.items():
            self.obstacles.append((r, nid + "#label"))
        self._other_segs = []
        self.routes = {}             # flow id -> dict(points, src_port, dst_port)
        self.ports = {}              # (node, side) -> list[(flow id, role)]
        self._build_candidates()

    # ---- cong -----------------------------------------------------------------
    def port(self, nid, side, flow=None, role=None):
        """Toa do va huong ra (ngoai) cua mot cong. Pool den: cong chay theo x cua luong."""
        if nid in self.pool_box and nid not in self.node_box:
            r = self.pool_box[nid]
            dx = (flow or {}).get("hint", {}).get("dx" if role == "src" else "dx2", 0)
            other = flow["dst" if role == "src" else "src"] if flow else None
            ox = self.node_box[other].cx if other in self.node_box else r.cx
            x = ox + dx
            return ((x, r.y), (0, -1)) if side == "T" else ((x, r.b), (0, 1))
        r = self.node_box[nid]
        n = self.dg.node(nid)
        if n and n["kind"] == "note":
            br = n["_bracket"]
            r = br
        return {"R": ((r.r, r.cy), (1, 0)), "L": ((r.x, r.cy), (-1, 0)),
                "T": ((r.cx, r.y), (0, -1)), "B": ((r.cx, r.b), (0, 1))}[side]

    def _build_candidates(self):
        xs, ys = set(), set()
        for n in self.dg.nodes:
            r = self.node_box[n["id"]]
            for d in (MARGIN + 6, MARGIN + 18):
                xs.update((r.x - d, r.r + d))
                ys.update((r.y - d, r.b + d))
            xs.add(r.cx)
            ys.add(r.cy)
        for r in self.label_box.values():
            ys.update((r.y - 6, r.b + 6))
            xs.update((r.x - 6, r.r + 6))
        pos = 0.0
        for w in self.dg.colw:
            b = POOL_X + LANE_TITLE + pos
            for off in (-24, -12, 0, 12, 24):
                xs.add(b + off)
            pos += w
        for r in self.lane_box.values():
            for off in (-18, -9, 9, 18):
                ys.add(r.y + off)
                ys.add(r.b + off)
            ys.add(r.cy)
        for r in self.pool_box.values():
            for off in (-46, -30, -16, 0, 16, 30, 46):
                ys.add(r.b + POOL_GAP / 2.0 + off)
                ys.add(r.y - POOL_GAP / 2.0 + off)
            ys.add(r.cy)
        self.xs = sorted(xs)
        self.ys = sorted(ys)

    # ---- diem phat -----------------------------------------------------------------
    def _side_penalty(self, flow, side, role):
        k = flow["kind"]
        if k == "assoc":
            return 0
        if k == "msg":
            return 0 if side in ("T", "B") else 900
        if role == "src":
            return {"R": 0, "T": 22, "B": 22, "L": 420}[side]
        return {"L": 0, "T": 22, "B": 22, "R": 420}[side]

    def _cost(self, flow, pts, src_side, dst_side):
        if _reverses(pts):
            return None
        cost = 0.0
        segs = _segments(pts)
        length = sum(abs(a[0] - b[0]) + abs(a[1] - b[1]) for a, b in segs)
        cost += length + 34 * (len(pts) - 2)
        own = {flow["src"], flow["dst"]}
        for (a, b) in segs:
            for rect, owner in self.obstacles:
                base = owner.split("#")[0]
                is_label = owner.endswith("#label")
                if base in own and not is_label:
                    # chi chan khi doan xuyen qua chinh nut cua no
                    if _seg_hits_rect(a, b, rect):
                        return None
                    continue
                if is_label and base in own:
                    if _seg_hits_rect(a, b, rect):
                        cost += 2500
                    continue
                if _seg_hits_rect(a, b, rect.inflate(MARGIN)):
                    if flow["kind"] == "assoc":
                        cost += 1800
                    else:
                        return None
        cr, ov = _cross_and_overlap(pts, self._other_segs)
        weight = 1.0 if flow["kind"] != "assoc" else 0.3
        cost += weight * (170 * cr + 14 * ov)
        cost += self._side_penalty(flow, src_side, "src") + self._side_penalty(flow, dst_side, "dst")
        return cost

    def _port_use_penalty(self, flow, nid, side, role):
        used = self.ports.get((nid, side), [])
        if flow["kind"] == "assoc":
            role = "as"
        pen = 0
        for fid, r in used:
            if fid == flow["id"]:
                continue
            if r != role:
                pen += 420
            elif role == "src":
                pen += 35
            elif role == "as":
                pen += 60
        return pen

    def route(self, flow):
        hint = flow.get("hint", {})
        src, dst = flow["src"], flow["dst"]
        src_sides = hint.get("src_sides") or ("R", "T", "B", "L")
        dst_sides = hint.get("dst_sides") or ("L", "T", "B", "R")
        if flow["kind"] == "msg":
            src_sides = hint.get("src_sides") or ("T", "B")
            dst_sides = hint.get("dst_sides") or ("T", "B")
        best = (None, None)
        self._other_segs = []
        for fid, rt in self.routes.items():
            if fid != flow["id"]:
                self._other_segs.extend(_segments(rt["points"]))
        for ss in src_sides:
            for ds in dst_sides:
                (S, d1), (E, d2) = self.port(src, ss, flow, "src"), self.port(dst, ds, flow, "dst")
                if not hint.get("any_side"):
                    # bo cac cong huong ra xa muc tieu theo truc lech nhieu nhat
                    vx, vy = E[0] - S[0], E[1] - S[1]
                    if d1[0] * vx + d1[1] * vy < -1e-6 and abs(d1[0] * vx + d1[1] * vy) > 30:
                        continue
                    if d2[0] * (S[0] - E[0]) + d2[1] * (S[1] - E[1]) < -1e-6 and \
                            abs(d2[0] * (S[0] - E[0]) + d2[1] * (S[1] - E[1])) > 30:
                        continue
                arrive = (-d2[0], -d2[1])
                P1 = (S[0] + d1[0] * STUB, S[1] + d1[1] * STUB)
                P2 = (E[0] - arrive[0] * STUB, E[1] - arrive[1] * STUB)
                extra = self._port_use_penalty(flow, src, ss, "src") + \
                    self._port_use_penalty(flow, dst, ds, "dst")
                for mid in self._connectors(P1, P2):
                    pts = _simplify([S, P1] + mid + [P2, E])
                    c = self._cost(flow, pts, ss, ds)
                    if c is None:
                        continue
                    c += extra
                    if best[0] is None or c < best[0]:
                        best = (c, (pts, ss, ds))
        if best[0] is None:
            return None
        pts, ss, ds = best[1]
        return dict(points=pts, src_side=ss, dst_side=ds, cost=best[0])

    def _connectors(self, P1, P2):
        (x1, y1), (x2, y2) = P1, P2
        out = [[], [(x2, y1)], [(x1, y2)]]
        xlo, xhi = min(x1, x2) - 330, max(x1, x2) + 330
        ylo, yhi = min(y1, y2) - 260, max(y1, y2) + 260
        xs = [x for x in self.xs if xlo <= x <= xhi]
        ys = [y for y in self.ys if ylo <= y <= yhi]
        for x in xs:
            out.append([(x, y1), (x, y2)])
        for y in ys:
            out.append([(x1, y), (x2, y)])
        # 4 doan: hai thanh ray
        if abs(x1 - x2) > 1 and abs(y1 - y2) > 1:
            for y in ys:
                for x in xs:
                    if abs(x - x1) < 1 or abs(x - x2) < 1:
                        continue
        return out

    def register(self, flow, rt):
        self.routes[flow["id"]] = rt
        for nid, side, role in ((flow["src"], rt["src_side"], "src"), (flow["dst"], rt["dst_side"], "dst")):
            if flow["kind"] == "assoc":
                role = "as"
            self.ports.setdefault((nid, side), []).append((flow["id"], role))

    def unregister(self, flow):
        self.routes.pop(flow["id"], None)
        for k, lst in self.ports.items():
            self.ports[k] = [(f, r) for (f, r) in lst if f != flow["id"]]

    def run(self, passes=3):
        order = [f for f in self.dg.flows if f["kind"] == "seq"] + \
                [f for f in self.dg.flows if f["kind"] == "msg"] + \
                [f for f in self.dg.flows if f["kind"] == "assoc"]
        failed = []
        for f in order:
            rt = self.route(f)
            if rt is None:
                failed.append(f["id"])
                continue
            self.register(f, rt)
        for _ in range(passes - 1):
            for f in order:
                if f["id"] in failed:
                    continue
                old = self.routes.get(f["id"])
                self.unregister(f)
                rt = self.route(f)
                self.register(f, rt or old)
        self.failed = failed
        return self.routes


# --------------------------------------------------------------------------
# Nhan tren luong
# --------------------------------------------------------------------------
def _point_at(pts, dist):
    acc = 0.0
    for (a, b) in _segments(pts):
        seg = abs(a[0] - b[0]) + abs(a[1] - b[1])
        if acc + seg >= dist - 1e-6:
            t = (dist - acc) / seg if seg else 0
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), (a, b)
        acc += seg
    return pts[-1], (pts[-2], pts[-1])


def place_labels(dg, router):
    """Chon vi tri nhan cho cac luong co nhan: (x_tuong_doi, dx, dy, rect)."""
    placed = {}
    taken = []
    all_obs = [r.inflate(3) for r, _ in router.obstacles]
    for f in dg.flows:
        if not f["label"] or f["id"] not in router.routes:
            continue
        pts = router.routes[f["id"]]["points"]
        lines = f["label"].split("\n")
        w = max(len(s) for s in lines) * 7.0 + 12
        h = len(lines) * LINE_H + 2
        total = sum(abs(a[0] - b[0]) + abs(a[1] - b[1]) for a, b in _segments(pts))
        cands = []
        acc = 0.0
        for (a, b) in _segments(pts):
            seg = abs(a[0] - b[0]) + abs(a[1] - b[1])
            horizontal = abs(a[1] - b[1]) < 1e-6
            for frac in (0.5, 0.35, 0.65, 0.2, 0.8):
                d = acc + seg * frac
                (px, py), _ = _point_at(pts, d)
                need = w if horizontal else h
                if seg < need * 0.75:
                    continue
                if horizontal:
                    cands.append((d, (px, py), 0, 0, seg))
                else:
                    cands.append((d, (px, py), w / 2.0 + 8, 0, seg))
            acc += seg
        # uu tien doan dai nhat, sau do la vi tri gan giua
        cands.sort(key=lambda c: (-min(c[4], 260), abs(c[0] - total / 2.0)))
        chosen = None
        for (d, (px, py), dx, dy, seg) in cands:
            rect = Rect(px + dx - w / 2.0, py + dy - h / 2.0, w, h)
            if any(rect.overlaps(o) for o in all_obs):
                continue
            if any(rect.overlaps(t) for t in taken):
                continue
            chosen = (d, dx, dy, rect)
            break
        if chosen is None and cands:
            d, (px, py), dx, dy, seg = cands[0]
            chosen = (d, dx, dy, Rect(px + dx - w / 2.0, py + dy - h / 2.0, w, h))
        if chosen is None:
            d = total / 2.0
            (px, py), _ = _point_at(pts, d)
            chosen = (d, 0, 0, Rect(px - w / 2.0, py - h / 2.0, w, h))
        taken.append(chosen[3])
        placed[f["id"]] = dict(rel=(2.0 * chosen[0] / total - 1.0) if total else 0.0,
                               dx=chosen[1], dy=chosen[2], rect=chosen[3])
    return placed


# --------------------------------------------------------------------------
# Kiem dinh hinh hoc
# --------------------------------------------------------------------------
def check_geometry(dg, router, labels):
    errs, warns = [], []
    nb = router.node_box
    ids = list(nb.keys())
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            if nb[ids[i]].inflate(2).overlaps(nb[ids[j]].inflate(2)):
                errs.append("nut chong nhau: %s / %s" % (ids[i], ids[j]))
    for n in dg.nodes:
        lane = router.lane_box[n["lane"]]
        r = nb[n["id"]]
        if r.x < lane.x or r.r > lane.r or r.y < lane.y or r.b > lane.b:
            errs.append("nut ra ngoai lane: %s" % n["id"])
    for nid, lr in router.label_box.items():
        for other in ids:
            if other != nid and lr.overlaps(nb[other]):
                errs.append("nhan cua %s de len nut %s" % (nid, other))
    for f in dg.flows:
        rt = router.routes.get(f["id"])
        if not rt:
            errs.append("khong dinh tuyen duoc luong %s" % f["id"])
            continue
        own = {f["src"], f["dst"]}
        for (a, b) in _segments(rt["points"]):
            for rect, owner in router.obstacles:
                base = owner.split("#")[0]
                if base in own and not owner.endswith("#label"):
                    continue
                if _seg_hits_rect(a, b, rect.inflate(-MARGIN + 1) if not owner.endswith("#label") else rect):
                    (errs if f["kind"] != "assoc" else warns).append(
                        "luong %s xuyen %s" % (f["id"], owner))
    # giao cat / chong lan giua cac luong
    fl = [f for f in dg.flows if f["id"] in router.routes]
    total_cross = 0
    for i in range(len(fl)):
        for j in range(i + 1, len(fl)):
            a, b = fl[i], fl[j]
            if "assoc" in (a["kind"], b["kind"]):
                continue
            cr, ov = _cross_and_overlap(router.routes[a["id"]]["points"],
                                        _segments(router.routes[b["id"]]["points"]))
            total_cross += cr
            same_src = a["src"] == b["src"]
            same_dst = a["dst"] == b["dst"]
            if ov > 3 and not (same_src or same_dst):
                errs.append("luong %s chong len luong %s (%d px)" % (a["id"], b["id"], ov))
    # nhan de len nut
    for fid, lab in labels.items():
        for nid, r in nb.items():
            if lab["rect"].overlaps(r):
                errs.append("nhan luong %s de len nut %s" % (fid, nid))
    return errs, warns, total_cross


# --------------------------------------------------------------------------
# Xuat draw.io
# --------------------------------------------------------------------------
def _edge_ports(router, f, rt):
    """Tham so exit/entry (ti le 0..1) cho style draw.io."""
    def frac(nid, side, pt):
        if nid in router.pool_box and nid not in router.node_box:
            r = router.pool_box[nid]
            return ((pt[0] - r.x) / r.w, 0.0 if side == "T" else 1.0)
        n = router.dg.node(nid)
        r = router.node_box[nid]
        if n and n["kind"] == "note":
            r = n["_bracket"]
        return {"R": (1.0, 0.5), "L": (0.0, 0.5), "T": (0.5, 0.0), "B": (0.5, 1.0)}[side]
    return frac(f["src"], rt["src_side"], rt["points"][0]), frac(f["dst"], rt["dst_side"], rt["points"][-1])


def to_drawio(dg, router, labels):
    pool_box, lane_box, node_box, label_box = router.pool_box, router.lane_box, router.node_box, router.label_box
    ids, seq = {}, [0]

    def nid():
        seq[0] += 1
        return "c%d" % seq[0]

    total_w = int(max(b.r for b in pool_box.values()) + 80)
    total_h = int(max(b.b for b in pool_box.values()) + 80)
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<mxfile host="app.diagrams.net">',
           '  <diagram name="%s" id="diagram_%s">' % (esc(dg.title), dg.slug),
           '    <mxGraphModel dx="2200" dy="1300" grid="1" gridSize="10" guides="1" tooltips="1" '
           'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="%d" pageHeight="%d" '
           'math="0" shadow="0">' % (total_w, total_h),
           '      <root>', '        <mxCell id="0" />', '        <mxCell id="1" parent="0" />']

    for p in dg.pools:
        pb = pool_box[p["id"]]
        pid = nid()
        ids[p["id"]] = pid
        style = S_POOL
        out.append('        <mxCell id="%s" parent="1" style="%s" value="%s" vertex="1">'
                   % (pid, style, esc_draw(p["name"])))
        out.append('          <mxGeometry x="%g" y="%g" width="%g" height="%g" as="geometry" />'
                   % (pb.x, pb.y, pb.w, pb.h))
        out.append('        </mxCell>')
        for lane in p["lanes"]:
            lb = lane_box[lane["id"]]
            lid = nid()
            ids[lane["id"]] = lid
            out.append('        <mxCell id="%s" parent="%s" style="%s" value="%s" vertex="1">'
                       % (lid, pid, S_LANE, esc_draw(lane["name"])))
            out.append('          <mxGeometry x="%g" y="%g" width="%g" height="%g" as="geometry" />'
                       % (LANE_TITLE, lb.y - pb.y, lb.w, lb.h))
            out.append('        </mxCell>')

    for n in dg.nodes:
        b = node_box[n["id"]]
        lb = lane_box[n["lane"]]
        rx, ry = b.x - lb.x, b.y - lb.y
        cid = nid()
        ids[n["id"]] = cid
        k = n["kind"]
        w, h = b.w, b.h
        if k == "task":
            style, value = S_TASK.format(marker=n["marker"]), n["label"]
        elif k == "call":
            style, value = S_CALL.format(marker="abstract"), n["label"]
        elif k == "gateway":
            sym, gt = GW_KIND[n["gtype"]]
            style, value = S_GW.format(symbol=sym, gwtype=gt), ""
        elif k == "event":
            outline, symbol = EVENT_KIND[n["etype"]]
            style, value = S_EVENT.format(outline=outline, symbol=symbol), n["label"]
            if n.get("lab") == "right":
                style += "labelPosition=right;verticalLabelPosition=middle;align=left;verticalAlign=middle;"
        elif k == "store":
            style, value = S_STORE, n["label"]
        else:
            br = n["_bracket"]
            rx, ry = br.x - lb.x, br.y - lb.y
            w, h = br.w, br.h
            style, value = S_NOTE, "\n".join(n["_lines"])
        out.append('        <mxCell id="%s" parent="%s" style="%s" value="%s" vertex="1">'
                   % (cid, ids[n["lane"]], style, esc_draw(value)))
        out.append('          <mxGeometry x="%g" y="%g" width="%g" height="%g" as="geometry" />'
                   % (rx, ry, w, h))
        out.append('        </mxCell>')
        if k == "gateway" and n["label"]:
            gl = label_box[n["id"]]
            out.append('        <mxCell id="%s" parent="%s" style="%s" value="%s" vertex="1">'
                       % (nid(), ids[n["lane"]], S_GWLABEL, esc_draw(n["label"])))
            out.append('          <mxGeometry x="%g" y="%g" width="%g" height="%g" as="geometry" />'
                       % (gl.x - lb.x, gl.y - lb.y, gl.w, gl.h))
            out.append('        </mxCell>')

    for f in dg.flows:
        rt = router.routes.get(f["id"])
        if not rt:
            continue
        base = {"seq": S_SEQ, "msg": S_MSG, "assoc": S_ASSOC}[f["kind"]]
        (ex, ey), (nx, ny) = _edge_ports(router, f, rt)
        style = base + "exitX=%g;exitY=%g;exitDx=0;exitDy=0;exitPerimeter=0;" \
                       "entryX=%g;entryY=%g;entryDx=0;entryDy=0;entryPerimeter=0;" % (ex, ey, nx, ny)
        eid = nid()
        src = ids[f["src"]]
        dst = ids[f["dst"]]
        out.append('        <mxCell id="%s" parent="1" source="%s" target="%s" style="%s" edge="1">'
                   % (eid, src, dst, style))
        out.append('          <mxGeometry relative="1" as="geometry">')
        inner = rt["points"][1:-1]
        if inner:
            out.append('            <Array as="points">')
            for (px, py) in inner:
                out.append('              <mxPoint x="%g" y="%g" />' % (px, py))
            out.append('            </Array>')
        out.append('          </mxGeometry>')
        out.append('        </mxCell>')
        lab = labels.get(f["id"])
        if lab:
            out.append('        <mxCell id="%s" connectable="0" parent="%s" style="%s" value="%s" vertex="1">'
                       % (nid(), eid, S_ELBL, esc_draw(f["label"])))
            out.append('          <mxGeometry x="%g" relative="1" as="geometry">'
                       '<mxPoint x="%g" y="%g" as="offset" /></mxGeometry>'
                       % (lab["rel"], lab["dx"], lab["dy"]))
            out.append('        </mxCell>')
    out += ['      </root>', '    </mxGraphModel>', '  </diagram>', '</mxfile>']
    return "\n".join(out)


# --------------------------------------------------------------------------
# Xuat BPMN 2.0 + BPMNDI
# --------------------------------------------------------------------------
NS = ('xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" '
      'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" '
      'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" '
      'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" '
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
      'targetNamespace="http://velura.vn/bpmn/admin"')


def to_bpmn(dg, router, labels):
    pool_box, lane_box, node_box, label_box = router.pool_box, router.lane_box, router.node_box, router.label_box
    slug = dg.slug
    x = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<bpmn:definitions id="Definitions_%s" name="%s" %s>' % (slug, esc(dg.title), NS)]
    x.append('  <bpmn:collaboration id="Collaboration_%s">' % slug)
    for p in dg.pools:
        if p["blackbox"]:
            x.append('    <bpmn:participant id="Participant_%s" name="%s" />' % (p["id"], esc(p["name"])))
        else:
            x.append('    <bpmn:participant id="Participant_%s" name="%s" processRef="Process_%s" />'
                     % (p["id"], esc(p["name"]), p["id"]))
    for f in dg.flows:
        if f["kind"] == "msg":
            dst = "Participant_" + f["dst"] if f["dst"] not in node_box else f["dst"]
            src = "Participant_" + f["src"] if f["src"] not in node_box else f["src"]
            x.append('    <bpmn:messageFlow id="%s" name="%s" sourceRef="%s" targetRef="%s" />'
                     % (f["id"], esc(f["label"].replace("\n", " ")), src, dst))
    x.append('  </bpmn:collaboration>')

    by_id = {n["id"]: n for n in dg.nodes}
    assoc_ids = {}
    for p in dg.pools:
        if p["blackbox"]:
            continue
        pid = p["id"]
        own = [n for n in dg.nodes if dg.pool_of_lane(n["lane"]) == pid]
        inner = [f for f in dg.flows if f["kind"] == "seq" and by_id[f["src"]] in own]
        x.append('  <bpmn:process id="Process_%s" isExecutable="false">' % pid)
        x.append('    <bpmn:laneSet id="LaneSet_%s">' % pid)
        for lane in p["lanes"]:
            x.append('      <bpmn:lane id="%s" name="%s">' % (lane["id"], esc(lane["name"])))
            for n in own:
                if n["lane"] == lane["id"] and n["kind"] != "note":
                    x.append('        <bpmn:flowNodeRef>%s</bpmn:flowNodeRef>' % n["id"])
            x.append('      </bpmn:lane>')
        x.append('    </bpmn:laneSet>')
        data_out = {}
        for f in dg.flows:
            if f["kind"] == "assoc" and f["src"] in by_id and f["dst"] in by_id \
                    and by_id[f["dst"]]["kind"] == "store":
                data_out.setdefault(f["src"], []).append(f)
        for n in own:
            k = n["kind"]
            nm = esc(n["label"].replace("\n", " "))
            inc = "".join("<bpmn:incoming>%s</bpmn:incoming>" % f["id"] for f in inner if f["dst"] == n["id"])
            outg = "".join("<bpmn:outgoing>%s</bpmn:outgoing>" % f["id"] for f in inner if f["src"] == n["id"])
            dout = "".join('<bpmn:dataOutputAssociation id="DataAssoc_%s"><bpmn:targetRef>%s</bpmn:targetRef>'
                           '</bpmn:dataOutputAssociation>' % (f["dst"], f["dst"])
                           for f in data_out.get(n["id"], []))
            if k in ("task", "call"):
                if k == "call":
                    x.append('    <bpmn:callActivity id="%s" name="%s">%s%s%s</bpmn:callActivity>'
                             % (n["id"], nm, inc, outg, dout))
                else:
                    tag = TASK_BPMN[n["marker"]]
                    x.append('    <bpmn:%s id="%s" name="%s">%s%s%s</bpmn:%s>' % (tag, n["id"], nm, inc, outg, dout, tag))
            elif k == "gateway":
                tag = {"xor": "exclusiveGateway", "and": "parallelGateway"}[n["gtype"]]
                x.append('    <bpmn:%s id="%s" name="%s">%s%s</bpmn:%s>' % (tag, n["id"], nm, inc, outg, tag))
            elif k == "event":
                et = n["etype"]
                if et == "start":
                    x.append('    <bpmn:startEvent id="%s" name="%s">%s</bpmn:startEvent>' % (n["id"], nm, outg))
                elif et == "msgstart":
                    x.append('    <bpmn:startEvent id="%s" name="%s">%s<bpmn:messageEventDefinition id="%s_md" />'
                             '</bpmn:startEvent>' % (n["id"], nm, outg, n["id"]))
                elif et == "end":
                    x.append('    <bpmn:endEvent id="%s" name="%s">%s</bpmn:endEvent>' % (n["id"], nm, inc))
                elif et == "terminate":
                    x.append('    <bpmn:endEvent id="%s" name="%s">%s<bpmn:terminateEventDefinition id="%s_td" />'
                             '</bpmn:endEvent>' % (n["id"], nm, inc, n["id"]))
                elif et == "timer":
                    x.append('    <bpmn:intermediateCatchEvent id="%s" name="%s">%s%s<bpmn:timerEventDefinition id="%s_td" />'
                             '</bpmn:intermediateCatchEvent>' % (n["id"], nm, inc, outg, n["id"]))
                elif et == "catch":
                    x.append('    <bpmn:intermediateCatchEvent id="%s" name="%s">%s%s<bpmn:messageEventDefinition id="%s_md" />'
                             '</bpmn:intermediateCatchEvent>' % (n["id"], nm, inc, outg, n["id"]))
                elif et == "throw":
                    x.append('    <bpmn:intermediateThrowEvent id="%s" name="%s">%s%s<bpmn:messageEventDefinition id="%s_md" />'
                             '</bpmn:intermediateThrowEvent>' % (n["id"], nm, inc, outg, n["id"]))
            elif k == "store":
                x.append('    <bpmn:dataStoreReference id="%s" name="%s" />' % (n["id"], nm))
            elif k == "note":
                x.append('    <bpmn:textAnnotation id="%s"><bpmn:text>%s</bpmn:text></bpmn:textAnnotation>'
                         % (n["id"], esc(" ".join(n["_lines"]))))
        for f in inner:
            x.append('    <bpmn:sequenceFlow id="%s" name="%s" sourceRef="%s" targetRef="%s" />'
                     % (f["id"], esc(f["label"].replace("\n", " ")), f["src"], f["dst"]))
        for f in dg.flows:
            if f["kind"] == "assoc" and by_id[f["src"]] in own:
                if by_id[f["dst"]]["kind"] == "store":
                    continue
                x.append('    <bpmn:association id="%s" sourceRef="%s" targetRef="%s" />'
                         % (f["id"], f["dst"], f["src"]) if by_id[f["src"]]["kind"] != "note" else
                         '    <bpmn:association id="%s" sourceRef="%s" targetRef="%s" />'
                         % (f["id"], f["dst"], f["src"]))
        x.append('  </bpmn:process>')

    x.append('  <bpmndi:BPMNDiagram id="BPMNDiagram_%s">' % slug)
    x.append('    <bpmndi:BPMNPlane id="BPMNPlane_%s" bpmnElement="Collaboration_%s">' % (slug, slug))

    def shape(eid, bel, r, extra="", label=None):
        s = '      <bpmndi:BPMNShape id="%s_di" bpmnElement="%s"%s><dc:Bounds x="%g" y="%g" width="%g" height="%g" />' \
            % (eid, bel, extra, r.x, r.y, r.w, r.h)
        if label is not None:
            s += '<bpmndi:BPMNLabel><dc:Bounds x="%g" y="%g" width="%g" height="%g" /></bpmndi:BPMNLabel>' \
                 % (label.x, label.y, label.w, label.h)
        return s + '</bpmndi:BPMNShape>'

    for p in dg.pools:
        x.append(shape("Participant_" + p["id"], "Participant_" + p["id"], pool_box[p["id"]], ' isHorizontal="true"'))
        for lane in p["lanes"]:
            x.append(shape(lane["id"], lane["id"], lane_box[lane["id"]], ' isHorizontal="true"'))
    for n in dg.nodes:
        r = node_box[n["id"]]
        extra = ' isMarkerVisible="true"' if n["kind"] == "gateway" else ""
        if n["kind"] == "note":
            r = n["_bracket"]
        x.append(shape(n["id"], n["id"], r, extra, label_box.get(n["id"])))
    for f in dg.flows:
        rt = router.routes.get(f["id"])
        if not rt:
            continue
        pts = rt["points"]
        if f["kind"] == "assoc" and by_id[f["dst"]]["kind"] == "store":
            eid, bel = "DataAssoc_%s_di" % f["dst"], "DataAssoc_%s" % f["dst"]
        else:
            eid, bel = f["id"] + "_di", f["id"]
        wp = "".join('<di:waypoint x="%g" y="%g" />' % p for p in pts)
        lab = labels.get(f["id"])
        lx = ""
        if lab:
            r = lab["rect"]
            lx = '<bpmndi:BPMNLabel><dc:Bounds x="%g" y="%g" width="%g" height="%g" /></bpmndi:BPMNLabel>' % (r.x, r.y, r.w, r.h)
        x.append('      <bpmndi:BPMNEdge id="%s" bpmnElement="%s">%s%s</bpmndi:BPMNEdge>' % (eid, bel, wp, lx))
    x.append('    </bpmndi:BPMNPlane>')
    x.append('  </bpmndi:BPMNDiagram>')
    x.append('</bpmn:definitions>')
    return "\n".join(x)


def build(dg, verbose=True):
    """Dinh tuyen, kiem dinh va tra ve (drawio_xml, bpmn_xml, bao cao)."""
    rule_errs = dg.check_rules()
    router = Router(dg)
    router.run()
    labels = place_labels(dg, router)
    geo_errs, warns, crossings = check_geometry(dg, router, labels)
    report = dict(rules=rule_errs, geometry=geo_errs, warnings=warns, crossings=crossings,
                  size=(max(b.r for b in router.pool_box.values()), max(b.b for b in router.pool_box.values())))
    return to_drawio(dg, router, labels), to_bpmn(dg, router, labels), report, router
