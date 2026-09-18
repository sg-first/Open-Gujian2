# -*- coding: utf-8 -*-
"""dump Maps/<map>/<map>.vscene 内嵌的 XML 与变量表。"""
import os, re, sys, collections

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
mp = sys.argv[1] if len(sys.argv) > 1 else 'n04'
grep = sys.argv[2] if len(sys.argv) > 2 else ''
p = os.path.join(ROOT, 'Maps', mp, '%s.vscene' % mp)
d = open(p, 'rb').read()
print('%s  %.1f KB' % (p, len(d) / 1024))

# VBIN 块
if d[:4] == b'VBIN':
    import struct
    off, n = 12, 0
    while off + 12 <= len(d):
        tag = d[off:off + 4]
        size = struct.unpack_from('<I', d, off + 4)[0]
        print('  block %-6s size=%d' % (tag.decode('latin1'), size))
        off += 20 + size
        n += 1
        if size == 0 or n > 40:
            break

txt = d.decode('latin1')
vars_ = re.findall(r'<Variable\s+Name="([^"]*)"\s+Type="([^"]*)"\s+Value="([^"]*)"\s*/?>', txt)
print('variables: %d' % len(vars_))
for nm, ty, va in vars_:
    if not grep or grep.lower() in nm.lower() or grep.lower() in va.lower():
        print('   %-34s %-10s %s' % (nm, ty, va[:90]))

for tag in ('Water', 'Area', 'Zone', 'KeyFrame', 'Sky', 'Fog', 'Light'):
    for m in re.finditer(r'<%s[^>]*>' % tag, txt):
        seg = txt[m.start():m.start() + 700]
        print('--- %s ---' % tag)
        print(seg[:700])
        break
