# -*- coding: utf-8 -*-
"""深挖 n04.vscene SPHS/_SMI(静态网格实例) 记录结构"""
import struct, sys, os
sys.path.insert(0, os.path.dirname(__file__))
import gj2

p = os.path.join(gj2.ROOT, 'Maps', 'n04', 'n04.vscene')
d = open(p, 'rb').read()
# SPHS payload 从 762 开始
sph = 762
cnt = struct.unpack_from('<I', d, sph)[0]      # 2216?
c2, c3 = struct.unpack_from('<II', d, sph+4)
print('counts:', cnt, c2, c3, struct.unpack_from('<I', d, sph+12)[0])
o = sph + 16
ntypes = struct.unpack_from('<I', d, o)[0]; o += 4
types = []
for _ in range(ntypes):
    tag = d[o:o+4][::-1].decode(); o += 4
    n = struct.unpack_from('<I', d, o)[0]; o += 4
    types.append((tag, n))
print('sub-blocks:', types)

# 紧接着是 _ENT 实体数据。dump 第一条实体前后，寻找结构
print('\n--- raw from entity area (first 400 bytes) ---')
print(d[o:o+400].hex(' '))
print('\n--- as text ---')
print(''.join(chr(c) if 32 <= c < 127 else '.' for c in d[o:o+400]))

# 全文件搜 _SMI 引用字符串: 网格资源名通常以 .vmesh 结尾
import re
names = re.findall(rb'[A-Za-z0-9_\\/:.]{6,}\.vmesh', d)
print('\nvmesh refs:', len(names))
for n in names[:15]:
    print('  ', n.decode())
