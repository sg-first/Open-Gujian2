# -*- coding: utf-8 -*-
"""探测 n04 资源清单引用的贴图是否落盘（判断原版地形贴图可得性）"""
import re, os, collections

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
p = os.path.join(ROOT, 'Maps', 'n04', 'reslist.vres')
d = open(p, 'rb').read()
toks = re.findall(rb'[\x20-\x7e]{6,}', d)
names = [t.decode('latin1') for t in toks]

ext = collections.Counter(os.path.splitext(n)[1].lower() for n in names)
print('tokens %d' % len(names))
print('ext:', ext.most_common(14))

dds = [n for n in names if n.lower().endswith('.dds')]
print('dds refs %d' % len(dds))
pref = collections.Counter()
for n in dds:
    b = os.path.basename(n.replace('\\', '/')).lower()
    pref[re.sub(r'\d+', '#', b)[:20]] += 1
for k, v in pref.most_common(24):
    print('   %-24s %d' % (k, v))

print()
# 所有 dds 在磁盘上的 basename 集合
have = set()
for root, _, fs in os.walk(ROOT):
    for f in fs:
        if f.lower().endswith('.dds'):
            have.add(f.lower())
print('on-disk dds basenames %d' % len(have))
miss = [n for n in dds if os.path.basename(n.replace('\\', '/')).lower() not in have]
print('MISSING %d / %d dds refs' % (len(miss), len(dds)))
print('missing samples:', [os.path.basename(n.replace('\\', '/')) for n in miss[:10]])
nonterr = [n for n in dds if 'textures\\terrain' not in n.lower().replace('/', '\\')]
print('非 terrain 目录的 dds 引用 %d，例如 %s' % (len(nonterr),
      [os.path.basename(n.replace('\\', '/')) for n in nonterr[:10]]))
