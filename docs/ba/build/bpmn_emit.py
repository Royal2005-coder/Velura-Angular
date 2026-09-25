# -*- coding: utf-8 -*-
"""Bo xuat: mot Model -> .drawio (mxGraph) va .bpmn (BPMN 2.0 + BPMNDI)."""

from bpmn_build import (
    GW, LANE_TITLE,
    S_LANE, S_EVENT, S_GW, S_TASK, S_TEXT, S_STORE, S_NOTE,
    S_SEQ, S_MSG, S_ASSOC, S_ELBL, EVENT_KIND, TASK_BPMN,
    esc, esc_draw,
)


# ---------------------------------------------------------------------------
# draw.io
# ---------------------------------------------------------------------------
def to_drawio(models):
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<mxfile host="app.diagrams.net">']
    for di, m in enumerate(models, start=1):
        pool_box, lane_box, node_box = m.geometry()
        ids, seq = {}, [0]

        def nid():
            seq[0] += 1
            return "c%d_%d" % (di, seq[0])

        total_w = int(max(b[0] + b[2] for b in pool_box.values()) + 80)
        total_h = int(max(b[1] + b[3] for b in pool_box.values()) + 80)
        out.append('  <diagram name="%s" id="diagram%d">' % (esc(m.name), di))
        out.append('    <mxGraphModel dx="2200" dy="1300" grid="1" gridSize="10" guides="1" '
                   'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" '
                   'pageWidth="%d" pageHeight="%d" math="0" shadow="0">' % (total_w, total_h))
        out.append('      <root>')
        out.append('        <mxCell id="0" />')
        out.append('        <mxCell id="1" parent="0" />')

        for p in m.pools:
            px, py, pw, ph = pool_box[p["id"]]
            pid = nid()
            ids[p["id"]] = pid
            out.append('        <mxCell id="%s" parent="1" style="%s" value="%s" vertex="1">'
                       % (pid, S_LANE, esc_draw(p["name"])))
            out.append('          <mxGeometry x="%g" y="%g" width="%g" height="%g" as="geometry" />'
                       % (px, py, pw, ph))
            out.append('        </mxCell>')
            solo = len(p["lanes"]) == 1 and p["lanes"][0]["name"] == p["name"]
            for lane in p["lanes"]:
                lx, ly, lw, lh = lane_box[lane["id"]]
                lid = nid()
                ids[lane["id"]] = lid
                lane_style = S_LANE.replace("startSize=30", "startSize=0") if solo else S_LANE
                lane_name = "" if solo else lane["name"]
                out.append('        <mxCell id="%s" parent="%s" style="%s" value="%s" vertex="1">'
                           % (lid, pid, lane_style, esc_draw(lane_name)))
                out.append('          <mxGeometry x="%g" y="%g" width="%g" height="%g" as="geometry" />'
                           % (LANE_TITLE, ly - py, lw, lh))
                out.append('        </mxCell>')

        for n in m.nodes:
            bx, by, bw, bh = node_box[n["id"]]
            lx, ly = lane_box[n["lane"]][0], lane_box[n["lane"]][1]
            rx, ry = bx - lx, by - ly
            cid = nid()
            ids[n["id"]] = cid
            kind = n["kind"]
            if kind == "task":
                style, value = S_TASK.format(marker=n["marker"]), n["label"]
            elif kind == "gateway":
                style, value = S_GW, ""
            elif kind.startswith("event:"):
                outline, symbol = EVENT_KIND[kind.split(":")[1]]
                style, value = S_EVENT.format(outline=outline, symbol=symbol), n["label"]
            elif kind == "store":
                style, value = S_STORE, n["label"]
            else:
                style, value = S_NOTE, n["label"]
            out.append('        <mxCell id="%s" parent="%s" style="%s" value="%s" vertex="1">'
                       % (cid, ids[n["lane"]], style, esc_draw(value)))
            out.append('          <mxGeometry x="%g" y="%g" width="%g" height="%g" as="geometry" />'
                       % (rx, ry, bw, bh))
            out.append('        </mxCell>')
            if kind == "gateway":
                out.append('        <mxCell id="%s" parent="%s" style="%s" value="%s" vertex="1">'
                           % (nid(), ids[n["lane"]], S_TEXT, esc_draw(n["label"])))
                out.append('          <mxGeometry x="%g" y="%g" width="150" height="40" as="geometry" />'
                           % (rx + GW / 2.0 - 75, ry - 50))
                out.append('        </mxCell>')

        for f in m.flows:
            style = {"seq": S_SEQ, "msg": S_MSG, "assoc": S_ASSOC}[f["kind"]]
            eid = nid()
            out.append('        <mxCell id="%s" parent="1" source="%s" target="%s" style="%s" edge="1">'
                       % (eid, ids[f["src"]], ids[f["dst"]], style))
            out.append('          <mxGeometry relative="1" as="geometry" />')
            out.append('        </mxCell>')
            if f["label"]:
                out.append('        <mxCell id="%s" connectable="0" parent="%s" style="%s" value="%s" vertex="1">'
                           % (nid(), eid, S_ELBL, esc_draw(f["label"])))
                out.append('          <mxGeometry relative="1" as="geometry">'
                           '<mxPoint as="offset" /></mxGeometry>')
                out.append('        </mxCell>')

        out.append('      </root>')
        out.append('    </mxGraphModel>')
        out.append('  </diagram>')
    out.append('</mxfile>')
    return "\n".join(out)


# ---------------------------------------------------------------------------
# BPMN 2.0 + BPMNDI
# ---------------------------------------------------------------------------
NS = ('xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" '
      'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" '
      'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" '
      'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" '
      'targetNamespace="http://velura.vn/bpmn/khuyenmai"')


def to_bpmn(m, slug):
    pool_box, lane_box, node_box = m.geometry()
    proc_of_pool = {p["id"]: "Process_" + p["id"] for p in m.pools}
    pool_of_node = {n["id"]: m.pool_of_lane(n["lane"]) for n in m.nodes}

    x = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<bpmn:definitions id="Definitions_%s" %s>' % (slug, NS)]

    x.append('  <bpmn:collaboration id="Collaboration_%s">' % slug)
    for p in m.pools:
        x.append('    <bpmn:participant id="Participant_%s" name="%s" processRef="%s" />'
                 % (p["id"], esc(p["name"]), proc_of_pool[p["id"]]))
    for f in m.flows:
        if f["kind"] == "msg":
            x.append('    <bpmn:messageFlow id="%s" name="%s" sourceRef="%s" targetRef="%s" />'
                     % (f["id"], esc(f["label"]), f["src"], f["dst"]))
    x.append('  </bpmn:collaboration>')

    for p in m.pools:
        pid = p["id"]
        own = [n for n in m.nodes if pool_of_node[n["id"]] == pid]
        notes = [n for n in own if n["kind"] == "note"]
        flow_nodes = [n for n in own if n["kind"] not in ("note", "store")]
        stores = [n for n in own if n["kind"] == "store"]
        inner = [f for f in m.flows if f["kind"] == "seq" and pool_of_node[f["src"]] == pid]
        assocs = [f for f in m.flows if f["kind"] == "assoc" and pool_of_node[f["src"]] == pid]

        x.append('  <bpmn:process id="%s" isExecutable="false">' % proc_of_pool[pid])
        x.append('    <bpmn:laneSet id="LaneSet_%s">' % pid)
        for lane in p["lanes"]:
            x.append('      <bpmn:lane id="%s" name="%s">' % (lane["id"], esc(lane["name"])))
            for n in own:
                if n["lane"] == lane["id"] and n["kind"] != "note":
                    x.append('        <bpmn:flowNodeRef>%s</bpmn:flowNodeRef>' % n["id"])
            x.append('      </bpmn:lane>')
        x.append('    </bpmn:laneSet>')

        for n in flow_nodes + stores:
            inc = [f["id"] for f in inner if f["dst"] == n["id"]]
            outg = [f["id"] for f in inner if f["src"] == n["id"]]
            body = ("".join("<bpmn:incoming>%s</bpmn:incoming>" % i for i in inc)
                    + "".join("<bpmn:outgoing>%s</bpmn:outgoing>" % o for o in outg))
            kind, name = n["kind"], esc(n["label"].replace("\n", " "))
            if kind == "task":
                tag = TASK_BPMN[n["marker"]]
                x.append('    <bpmn:%s id="%s" name="%s">%s</bpmn:%s>' % (tag, n["id"], name, body, tag))
            elif kind == "gateway":
                x.append('    <bpmn:exclusiveGateway id="%s" name="%s">%s</bpmn:exclusiveGateway>'
                         % (n["id"], name, body))
            elif kind == "event:start":
                x.append('    <bpmn:startEvent id="%s" name="%s">%s</bpmn:startEvent>' % (n["id"], name, body))
            elif kind == "event:end":
                x.append('    <bpmn:endEvent id="%s" name="%s">%s</bpmn:endEvent>' % (n["id"], name, body))
            elif kind == "event:timer":
                x.append('    <bpmn:intermediateCatchEvent id="%s" name="%s">%s'
                         '<bpmn:timerEventDefinition id="%s_td" /></bpmn:intermediateCatchEvent>'
                         % (n["id"], name, body, n["id"]))
            elif kind == "event:catch":
                x.append('    <bpmn:intermediateCatchEvent id="%s" name="%s">%s'
                         '<bpmn:messageEventDefinition id="%s_md" /></bpmn:intermediateCatchEvent>'
                         % (n["id"], name, body, n["id"]))
            elif kind == "store":
                x.append('    <bpmn:dataStoreReference id="%s" name="%s" />' % (n["id"], name))

        for n in notes:
            x.append('    <bpmn:textAnnotation id="%s"><bpmn:text>%s</bpmn:text></bpmn:textAnnotation>'
                     % (n["id"], esc(n["label"].replace("\n", " "))))
        for f in inner:
            x.append('    <bpmn:sequenceFlow id="%s" name="%s" sourceRef="%s" targetRef="%s" />'
                     % (f["id"], esc(f["label"]), f["src"], f["dst"]))
        for f in assocs:
            x.append('    <bpmn:association id="%s" sourceRef="%s" targetRef="%s" />'
                     % (f["id"], f["src"], f["dst"]))
        x.append('  </bpmn:process>')

    x.append('  <bpmndi:BPMNDiagram id="BPMNDiagram_%s">' % slug)
    x.append('    <bpmndi:BPMNPlane id="BPMNPlane_%s" bpmnElement="Collaboration_%s">' % (slug, slug))
    for p in m.pools:
        px, py, pw, ph = pool_box[p["id"]]
        x.append('      <bpmndi:BPMNShape id="Participant_%s_di" bpmnElement="Participant_%s" '
                 'isHorizontal="true"><dc:Bounds x="%g" y="%g" width="%g" height="%g" />'
                 '</bpmndi:BPMNShape>' % (p["id"], p["id"], px, py, pw, ph))
        for lane in p["lanes"]:
            lx, ly, lw, lh = lane_box[lane["id"]]
            x.append('      <bpmndi:BPMNShape id="%s_di" bpmnElement="%s" isHorizontal="true">'
                     '<dc:Bounds x="%g" y="%g" width="%g" height="%g" /></bpmndi:BPMNShape>'
                     % (lane["id"], lane["id"], lx, ly, lw, lh))
    for n in m.nodes:
        bx, by, bw, bh = node_box[n["id"]]
        extra = ' isMarkerVisible="true"' if n["kind"] == "gateway" else ""
        x.append('      <bpmndi:BPMNShape id="%s_di" bpmnElement="%s"%s>'
                 '<dc:Bounds x="%g" y="%g" width="%g" height="%g" /></bpmndi:BPMNShape>'
                 % (n["id"], n["id"], extra, bx, by, bw, bh))
    for f in m.flows:
        sx, sy, sw, sh = node_box[f["src"]]
        tx, ty, tw, th = node_box[f["dst"]]
        if tx >= sx:
            p1 = (sx + sw, sy + sh / 2.0)
            p2 = (tx, ty + th / 2.0)
        else:
            p1 = (sx, sy + sh / 2.0)
            p2 = (tx + tw, ty + th / 2.0)
        x.append('      <bpmndi:BPMNEdge id="%s_di" bpmnElement="%s">'
                 '<di:waypoint x="%g" y="%g" /><di:waypoint x="%g" y="%g" />'
                 '<di:waypoint x="%g" y="%g" /></bpmndi:BPMNEdge>'
                 % (f["id"], f["id"], p1[0], p1[1], p2[0], p1[1], p2[0], p2[1]))
    x.append('    </bpmndi:BPMNPlane>')
    x.append('  </bpmndi:BPMNDiagram>')
    x.append('</bpmn:definitions>')
    return "\n".join(x)
