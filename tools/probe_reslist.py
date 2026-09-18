# -*- coding: utf-8 -*-
"""解析 Maps/<map>/reslist.vres (XML) 的 Texture 资源，检查是否落盘。"""
import os, re, sys, collections
import xml.etree.ElementTree as ET

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
mp = sys.argv[1] if len(sys.argv) > 1 else 'n04'
p = os.path.join(ROOT, 'Maps', mp, 'reslist.vres')
txt = open(p, 'rb').read().decode('utf-8', 'replace')
root = ET.fromstring(txt)

print('map', mp, 'count', root.attrib.get('Count'), 'pathType', root.attrib.get('PathType'))

mgr = collections.Counter()
tex = []
for r in root.iter('Resource'):
    m = r.attrib.get('Manager', '?')
    mgr[m] += 1
    if m == 'Textures':
        tex.append(r.attrib.get('Filename', ''))
print('managers:', mgr.most_common(12))
print('textures:', len(tex))

have = set()
for rt, _, fs in os.walk(ROOT):
    for f in fs:
        if f.lower().endswith('.dds'):
            have.add(f.lower())

def base(n):
    return os.path.basename(n.replace('\\', '/')).lower()

miss = [n for n in tex if base(n) not in have]
print('MISSING %d / %d' % (len(miss), len(tex)))
pat = collections.Counter(re.sub(r'\d+', '#', base(n)) for n in tex)
print('pattern sample:')
for k, v in pat.most_common(18):
    print('   %-30s %d' % (k, v))
print('first 30 tex names:')
for n in tex[:30]:
    print('   ', n, os.path.exists(os.path.join(ROOT, n.replace('\\', '/'))))
print('missing first 12:', [base(n) for n in miss[:12]])
