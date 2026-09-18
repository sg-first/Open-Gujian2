# -*- coding: utf-8 -*-
"""逐 mesh 检查: numVerts vs numOrgVerts, skin 对齐, 蒙皮展开失败统计"""
import os, sys, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xac import parse_xac

SRC = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ATTR_INFL = 5

for cid in ['101', '102']:
    p = os.path.join(SRC, 'Characters', cid, cid + '.rawXAC')
    x = parse_xac(p)
    skin_of = {s['nodeId']: s for s in x['skins'] if 'error' not in s}
    nodes = x['nodes']
    print('==', cid, 'nodes=%d' % len(nodes), 'node0:', nodes[0]['name'] if nodes else None)
    for m in x['meshes']:
        if 'error' in m or m['numVerts'] < 400:
            continue
        sk = skin_of.get(m['nodeId'])
        atr = {}
        for a in m['attribs']:
            atr.setdefault(a['type'], a)
        a_inf = atr.get(ATTR_INFL)
        inf = struct.unpack('<%dI' % m['numVerts'], a_inf['data']) if a_inf else None
        nr = len(sk['ranges']) if sk else 0
        oob = sum(1 for i in range(m['numVerts']) if inf and not (0 <= inf[i] < nr))
        print('  node=%-3d %-22s verts=%-6d org=%-6d skin=%-5s ranges=%-6d infl=%-6d ri_oob=%d' % (
            m['nodeId'], nodes[m['nodeId']]['name'][:22], m['numVerts'], m['numOrgVerts'],
            sk is not None, nr, len(sk['infl']) if sk else 0, oob))
