# -*- coding: utf-8 -*-
"""探测 n04.vscene 的块结构与放置数据"""
import struct, sys, os
sys.path.insert(0, os.path.dirname(__file__))
import gj2

def blocks(d, off=12):
    out = []
    n = len(d)
    while off + 20 <= n:
        tag = d[off:off+4]
        if not all(32 <= c < 127 for c in tag):
            break
        size, flag = struct.unpack_from('<II', d, off+4)
        out.append((tag.decode(), flag, off+12, size))
        off += 20 + size
        if size == 0:
            off += 8
    return out

p = os.path.join(gj2.ROOT, 'Maps', 'n04', 'n04.vscene')
d = open(p, 'rb').read()
print('file', len(d))
bs = blocks(d)
for tag, flag, o, s in bs[:40]:
    print(tag, 'flag=%08x' % flag, 'off=%d size=%d' % (o, s))

# 找大的块，dump 其 payload 头部
for tag, flag, o, s in bs:
    if s > 1000:
        print('----', tag, s)
        print(d[o:o+200].hex(' '))
