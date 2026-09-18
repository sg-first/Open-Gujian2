# -*- coding: utf-8 -*-
"""验证: 每个 skinned mesh 的 submesh.bones 去重并集 == skin.numLocalBones"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xac import parse_xac

SRC = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CHARS = ['101', '102', '103', '104', '105', '106', '107']

for cid in CHARS:
    p = os.path.join(SRC, 'Characters', cid, cid + '.rawXAC')
    if not os.path.exists(p):
        print(cid, 'no rawXAC'); continue
    x = parse_xac(p)
    skin_of = {s['nodeId']: s for s in x['skins'] if 'error' not in s}
    ok = bad = nopal = 0
    for m in x['meshes']:
        if 'error' in m:
            continue
        sk = skin_of.get(m['nodeId'])
        if not sk:
            continue
        pal = []
        seen = set()
        for s in m['subs']:
            for b in s['bones']:
                if b not in seen:
                    seen.add(b); pal.append(b)
        if len(pal) == sk['numLocalBones']:
            ok += 1
        else:
            bad += 1
            print('  %s mesh node=%d palette=%d numLocalBones=%d' % (
                cid, m['nodeId'], len(pal), sk['numLocalBones']))
    print('%s: match=%d mismatch=%d' % (cid, ok, bad))
