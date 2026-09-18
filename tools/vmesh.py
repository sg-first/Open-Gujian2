# -*- coding: utf-8 -*-
""".vmesh (VBIN/HSMV 容器) 解析：静态场景网格。

文件结构:  "VBIN" u32 u32  |  块: TAG(4) size(4) flag(4) payload(size) TAG(4) u32(0)
HSMV 载荷:
  0x00 u32=1 | 0x04 magic 0x4455ABCD | 0x08 u32=1
  0x0c  0b 0a 02 01        (版本标记)
  0x10  30 00 00 00
  0x14  [stride:u8][00][00][30]      <- 顶点步长
  0x18  ++声明表++: 每项 2 字节 [offset:u8][code:u8]，code=0xff 表示该槽未用
        code → 分量: 0x00=4 字节(u8×4 顶点色)  0x20=f32×2(UV)  0x30=f32×3(法线/切线)
        position 固定为 offset 0 的 f32×3，不进表。
        表长不固定（不同资产用到的 UV 套数不同），用"连续铺满 stride"来切分。
  0x48  u32 numVerts
  0x51  u32 numIdx
  0x68  顶点[numVerts] (stride 字节)  然后 u16 索引[numIdx]
"""
import os
import struct

MAGIC = b'VBIN'

# 顶点元素 code -> 字节数
ELEM_SIZE = {0x00: 4, 0x20: 8, 0x30: 12}
CODE_COLOR, CODE_UV, CODE_VEC3 = 0x00, 0x20, 0x30


def blocks(d):
    off = 12
    out = []
    while off + 12 <= len(d):
        tag = d[off:off + 4]
        size = struct.unpack_from('<I', d, off + 4)[0]
        flag = struct.unpack_from('<I', d, off + 8)[0]
        out.append((tag, flag, d[off + 12:off + 12 + size]))
        off += 20 + size
        if size == 0:
            break
    return out


def parse_decl(h, stride):
    """解析顶点声明表 -> {offset: code}；position 隐含在 offset 0。

    表项不保证连续排列（有的槽位是 0xffff），因此从 0x18 起扫描一段窗口，
    再挑出能"无缝铺满 [0, stride)"的那一组，避免把表尾的杂散字节当成元素。
    """
    cand = []
    for k in range(24):
        o = h[0x18 + k * 2]
        c = h[0x18 + k * 2 + 1]
        if c in ELEM_SIZE and o not in [x[0] for x in cand]:
            cand.append((o, c))
    cand.sort()
    out = {0: CODE_VEC3}           # position: 3×f32 @0
    cur = 12
    for o, c in cand:
        if o != cur:
            continue
        out[o] = c
        cur = o + ELEM_SIZE[c]
        if cur >= stride:
            break
    return out if cur == stride else None


def parse_hsmv(p):
    """返回 dict: verts(原始字节起点), numVerts, numIdx, stride, idxOff, vstart"""
    if len(p) < 0x70 or struct.unpack_from('<I', p, 4)[0] != 0x4455ABCD:
        return None
    numVerts = struct.unpack_from('<I', p, 0x48)[0]
    numIdx = struct.unpack_from('<I', p, 0x51)[0]
    if not (0 < numVerts < 4_000_000 and 0 < numIdx < 8_000_000):
        return None
    vstart = 0x68
    # 头部 0x14 直接给出 stride；校验它与文件长度自洽，不自洽再回退拟合
    S = struct.unpack_from('<I', p, 0x14)[0] & 0xFF
    if not (24 <= S <= 512) or len(p) - (vstart + numVerts * S + numIdx * 2) != 32:
        best = None
        for T in range(24, 80, 4):
            resid = len(p) - (vstart + numVerts * T + numIdx * 2)
            if resid < 0:
                continue
            if best is None or resid < best[0]:
                best = (resid, T)
        if best is None:
            return None
        S = best[1]
    return dict(vstart=vstart, numVerts=numVerts, numIdx=numIdx,
                stride=S, idxOff=vstart + numVerts * S, resid=len(p) - (vstart + numVerts * S + numIdx * 2))


def find_uv_off(p, info, count=64):
    """在 stride 内找 uv: 取一段顶点, 找一对 float 落在 [-8,8] 且非全等"""
    S = info['stride']
    nf = S // 4
    cands = {}
    for k in range(6, nf - 1):
        ok = 0
        tot = 0
        vals = []
        for i in range(0, min(count, info['numVerts'])):
            u, v = struct.unpack_from('<2f', p, info['vstart'] + i * S + k * 4)
            tot += 1
            if -16.0 < u < 16.0 and -16.0 < v < 16.0 and (u != 0.0 or v != 0.0):
                ok += 1
                vals.append((u, v))
        cands[k] = (ok / max(1, tot), vals[:4])
    best = max(cands.items(), key=lambda kv: kv[1][0])
    return best[0], best[1]


def parse_vmesh(path):
    d = open(path, 'rb').read()
    if d[:4] != MAGIC:
        raise ValueError('not vmesh: %s' % path)
    B = {}
    for tag, flag, p in blocks(d):
        B.setdefault(tag, []).append(p)
    info = parse_hsmv(B[b'HSMV'][0])
    if info is None:
        return None
    p = B[b'HSMV'][0]
    mats = parse_srtm(B[b'SRTM'][0]) if b'SRTM' in B else []
    S = info['stride']
    decl = parse_decl(p, S)
    if decl:
        info['decl'] = decl
        uvoff = min(o for o, c in decl.items() if c == CODE_UV)
        info['uvOff'] = uvoff // 4
        info['colOff'] = next((o for o, c in decl.items() if c == CODE_COLOR), None)
        info['uvExact'] = True
    else:
        # 声明表解析失败时回退到扫描启发式
        uvo, uvinfo = find_uv_off(p, info)
        info['decl'] = None
        info['uvOff'] = uvo
        info['colOff'] = None
        info['uvExact'] = False
        info['uvSample'] = uvinfo[1]
    info['mats'] = mats
    info['payload'] = p
    # 索引
    info['idx'] = struct.unpack_from('<%dH' % info['numIdx'], p, info['idxOff'])
    return info

def _u32str(p, o):
    n = struct.unpack_from('<I', p, o)[0]
    if n > 4096:
        return ''
    return p[o + 4:o + 4 + n].decode('gbk', 'replace')


def parse_srtm(p):
    """材质表 -> [{name, diffuse, normal}]"""
    n = struct.unpack_from('<I', p, 0)[0]
    mats = []
    q = 4
    for i in range(n):
        if q + 8 > len(p):
            break
        sz = struct.unpack_from('<I', p, q + 4)[0]
        body = p[q + 8:q + 8 + sz]
        nl = struct.unpack_from('<I', body, 2)[0]
        name = body[6:6 + nl].decode('gbk', 'replace') if 0 < nl < 256 else ''
        rest = body[6 + nl:]
        # rest 内是若干 u32len+string：diffuse / normal / spec ...
        strs = []
        o = 0
        while o + 4 <= len(rest):
            L = struct.unpack_from('<I', rest, o)[0]
            if 0 < L <= 512 and o + 4 + L <= len(rest):
                s = rest[o + 4:o + 4 + L]
                if all(32 <= c < 127 or c == 92 for c in s):
                    strs.append(s.decode('gbk', 'replace'))
                    o += 4 + L
                    continue
            o += 1
        mats.append(dict(name=name, tex=strs))
        q += 8 + sz
    return mats


if __name__ == '__main__':
    import glob
    root = r'E:/BaiduNetdiskDownload/Gujian.2/RPGproject/models'
    files = []
    for sub in ('bridge', 'building', 'd01z2', 'biliren'):
        dd = os.path.join(root, sub)
        files += sorted(glob.glob(os.path.join(dd, '*.vmesh')))
        for g in sorted(glob.glob(os.path.join(dd, '*'))):
            if os.path.isdir(g):
                files += sorted(glob.glob(os.path.join(g, '*.vmesh')))
    ok = bad = 0
    for f in files:
        try:
            r = parse_vmesh(f)
        except Exception as e:
            print('%-34s ERR %s' % (os.path.basename(f), e))
            bad += 1
            continue
        if not r:
            bad += 1
            continue
        if r['uvExact']:
            ok += 1
        else:
            bad += 1
            if bad <= 12:
                print('%-34s (fallback) nv=%-6d ni=%-6d S=%-3d resid=%-5d uv@%d'
                      % (os.path.basename(f), r['numVerts'], r['numIdx'],
                         r['stride'], r['resid'], r['uvOff']))
    print('total %d, exact-declaration %d, fallback/failed %d' % (len(files), ok, bad))
