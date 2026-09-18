# -*- coding: utf-8 -*-
"""Gujian2 原版场景建筑导出: models/{building/<region>,bridge,d01z2,biliren}/*.vmesh
                                                     -> webapp/assets/props/

坐标系: 源资产 Z-up, 导出时转 three.js 的 Y-up   (x,y,z) -> (x, z, -y)
输出:  props.bin   每个道具 4 字节对齐:
                    POS f32×3 | NRM f32×3 | UV f32×2 | IDX (u16 或 u32)
       index.json  偏移 / 数量 / 区域标签 / 原始尺寸 / 贴图

UV 约定: 导出时写 (u, 1-v)。原版 D3D 约定 v=0 是 DDS 首行(顶行)；three.js 贴图默认
         flipY=true 会把 v 对到底行，所以这里预翻一次，运行时用默认 flipY 即可。
         另外原版 UV 可越界(建筑瓦片 u∈[-15,18])，运行时必须 RepeatWrapping。
"""
import os
import sys
import json
import glob
import struct
import hashlib
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vmesh import parse_vmesh
from dds import dds_to_png

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
SRC = os.path.abspath(os.path.join(ROOT, '..'))          # RPGproject
MODELS = os.path.join(SRC, 'models')
OUT = os.path.join(ROOT, 'assets', 'props')
TEXOUT = os.path.join(OUT, 'tex')
SCALE = 0.01

# --------- 策展参数 ---------
NV_MIN, NV_MAX = 90, 16000        # 顶点数区间：滤掉碎块与 20 万顶点的巨型体
VERT_BUDGET = 1_250_000           # 全体顶点预算（约 40MB bin）
TEX_SIZE = 256                    # 建筑贴图边长上限（引擎贴图本来就是平铺的，256 足够）
# 每个区域目录最多取几个（再按顶点预算全局截断）
CAP = {
    'm00': 20, 'm03': 18, 'm04': 1, 'm10': 8, 'm11': 8, 'm12': 14, 'm43': 10,
    'm44': 8, 'm45': 6, 'm47': 2, 'm48': 4, 'm50': 5,
    'n01': 16, 'n02': 8, 'n03': 10, 'n05': 9, 'n06': 14, 'n07': 9, 'n08': 8,
    'n09': 8, 'n10': 12, 'n12': 14, 'n13': 18, 'n14': 8,
    'q01': 14, 'q02': 6, 'q03': 8, 'q04': 16, 'q05': 6, 'q06': 9, 'q07': 14,
    'q08': 4, 'q09': 14, 'q10': 3, 'q11': 12,
    'bridge': 18, 'd01z2': 6, 'biliren': 2,
}
# 只需导出世界地图实际用到的区域 + 通用补充（build_world.py 的 REGIONS）
NEEDED = ['m00', 'm03', 'm10', 'm12', 'm43',
          'n01', 'n06', 'n08', 'n10', 'n12', 'n13',
          'q01', 'q04', 'q07', 'q08', 'q09', 'q11',
          'bridge', 'd01z2', 'biliren']
# 世界区域 -> 建筑目录候选（按优先级）。n04 无专属建筑目录，用主城/山城建筑顶替。
REGION_BUILDINGS = {
    'n04':    ['m00', 'm03', 'n13'],
    'n01p1':  ['n01', 'm10'],
    'q08':    ['q08', 'q07', 'q11'],
    'n08':    ['n08', 'n06'],
    'n01p2':  ['n01', 'n12'],
    'n12p3':  ['n12', 'q01'],
    'q04b':   ['q04', 'q09'],
    'q07':    ['q07', 'q11'],
    'n10':    ['n10', 'n06'],
}
SHARED = ['m00', 'm03', 'bridge', 'd01z2', 'n13', 'q01', 'q09', 'n06', 'm43']


def subdirs():
    out = []
    for base in ('building', 'bridge', 'd01z2', 'biliren'):
        d = os.path.join(MODELS, base)
        if not os.path.isdir(d):
            continue
        if base == 'building':
            for g in sorted(os.listdir(d)):
                gd = os.path.join(d, g)
                if os.path.isdir(gd) and glob.glob(os.path.join(gd, '*.vmesh')):
                    out.append((g, gd))
        else:
            if glob.glob(os.path.join(d, '*.vmesh')):
                out.append((base, d))
    return out


def build_tex_index():
    """basename(lower) -> [abs path, ...]，一次遍历 models 全树"""
    idx = {}
    for root, _, fs in os.walk(MODELS):
        for f in fs:
            if f.lower().endswith('.dds'):
                idx.setdefault(f.lower(), []).append(os.path.join(root, f))
    return idx


def pick_texture(mats, vmesh_path, tidx):
    """从材质表里挑 diffuse。约定 `*d.dds` 是漫反射、`*n.dds` 是法线。"""
    names = []
    for m in mats:
        for t in m.get('tex', []):
            b = os.path.basename(t.replace('\\', '/')).lower()
            if b.endswith('.dds'):
                names.append(b)
    if not names:
        return None
    cand = [n for n in names if n.endswith('d.dds')] or \
           [n for n in names if not n.endswith('n.dds')] or names
    vd = os.path.dirname(os.path.abspath(vmesh_path)).lower()
    best, best_score = None, -1
    for n in cand:
        for p in tidx.get(n, []):
            # 与 vmesh 同目录树优先（大城里同名贴图很多，就近取最不容易串味）
            score = len(os.path.commonprefix([vd, os.path.dirname(p).lower()]))
            if score > best_score:
                best, best_score = p, score
    return best


def collect(nv_range):
    """返回 [(region, path, nv)]，每目录按顶点数「均匀抽样」取 CAP 个，保证大小层次丰富"""
    picked = []
    for name, d in subdirs():
        if name not in NEEDED:
            continue
        cands = []
        for f in sorted(glob.glob(os.path.join(d, '*.vmesh'))):
            try:
                r = parse_vmesh(f)
            except Exception:
                continue
            if not r:
                continue
            nv = r['numVerts']
            if nv_range[0] <= nv <= nv_range[1]:
                cands.append((nv, f))
        cands.sort()
        cap = min(CAP.get(name, 8), len(cands))
        if cap <= 0:
            continue
        # 均匀抽样：从最小的到最大的铺开，避免全是一个体量
        for i in range(cap):
            j = int(round(i * (len(cands) - 1) / max(1, cap - 1)))
            picked.append((name, cands[j][1], cands[j][0]))
    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0, help='只导出前 N 个（验证用）')
    ap.add_argument('--budget', type=int, default=VERT_BUDGET)
    ap.add_argument('--texsize', type=int, default=TEX_SIZE)
    ap.add_argument('--nvmax', type=int, default=NV_MAX)
    a = ap.parse_args()

    os.makedirs(TEXOUT, exist_ok=True)
    tidx = build_tex_index()
    print('texture index: %d unique dds names / %d files'
          % (len(tidx), sum(len(v) for v in tidx.values())))

    cands = collect((NV_MIN, a.nvmax))
    # 大目录优先拿名额，但整体再按顶点预算截断：先按「顶点少」排序保证覆盖面
    cands.sort(key=lambda t: (t[2], t[0], t[1]))
    picked, vtot = [], 0
    for name, path, nv in cands:
        if vtot + nv > a.budget:
            continue
        picked.append((name, path, nv))
        vtot += nv
        if a.limit and len(picked) >= a.limit:
            break
    print('candidates %d -> picked %d, verts %d (%.1f MB raw)'
          % (len(cands), len(picked), vtot, (vtot * 32) / 1048576))

    props, blob, texcache, failed = [], bytearray(), {}, 0
    per_region = {}

    def align4():
        while len(blob) % 4:
            blob.append(0)

    for region, path, nv_hint in picked:
        name = os.path.splitext(os.path.basename(path))[0]
        try:
            r = parse_vmesh(path)
        except Exception as e:
            print('  ERR %s: %s' % (name, e))
            failed += 1
            continue
        if not r:
            failed += 1
            continue
        p, S = r['payload'], r['stride']
        nv, ni, uvk = r['numVerts'], r['numIdx'], r['uvOff']
        vs = r['vstart']
        u3f = struct.Struct('<3f').unpack_from
        u2f = struct.Struct('<2f').unpack_from

        # --- pass 1: 包围盒（Z-up -> Y-up: X=x, Y=z, Z=-y） ---
        mnx = mny = mnz = 1e30
        mxx = mxy = mxz = -1e30
        for i in range(nv):
            o = vs + i * S
            x, y, z = u3f(p, o)
            X, Y, Z = x, z, -y
            if X < mnx: mnx = X
            if X > mxx: mxx = X
            if Y < mny: mny = Y
            if Y > mxy: mxy = Y
            if Z < mnz: mnz = Z
            if Z > mxz: mxz = Z
        cx, cz = (mnx + mxx) / 2, (mnz + mxz) / 2
        size = [round((mxx - mnx) * SCALE, 3), round((mxy - mny) * SCALE, 3),
                round((mxz - mnz) * SCALE, 3)]

        # --- pass 2: 顶点 ---
        POS = bytearray(nv * 12)
        NRM = bytearray(nv * 12)
        UV = bytearray(nv * 8)
        p3 = struct.Struct('<3f').pack_into
        p2 = struct.Struct('<2f').pack_into
        for i in range(nv):
            o = vs + i * S
            x, y, z = u3f(p, o)
            p3(POS, i * 12, (x - cx) * SCALE, (z - mny) * SCALE, (-y - cz) * SCALE)
            nx, ny, nz = u3f(p, o + 12)
            p3(NRM, i * 12, nx, nz, -ny)
            u, v = u2f(p, o + uvk * 4)
            p2(UV, i * 8, u, 1.0 - v)

        idx = list(struct.unpack_from('<%dH' % ni, p, r['idxOff']))
        for k in range(0, len(idx) - 2, 3):        # Z-up 右手 -> Y-up 需翻绕序
            idx[k + 1], idx[k + 2] = idx[k + 2], idx[k + 1]

        align4()
        vOff = len(blob); blob += POS
        nOff = len(blob); blob += NRM
        uOff = len(blob); blob += UV
        align4()
        iOff = len(blob)
        i16 = nv <= 0xFFFF
        blob += struct.pack('<%dH' % ni, *idx) if i16 else struct.pack('<%dI' % ni, *idx)

        tex = None
        tsrc = pick_texture(r.get('mats', []), path, tidx)
        if tsrc:
            key = hashlib.md5(os.path.relpath(tsrc, SRC).encode('utf-8')).hexdigest()[:10]
            if key not in texcache:
                rel = 'tex/%s.png' % key
                try:
                    dds_to_png(tsrc, os.path.join(TEXOUT, key + '.png'), a.texsize)
                    texcache[key] = rel
                except Exception as e:
                    print('    tex FAIL %s: %s' % (os.path.basename(tsrc), e))
                    texcache[key] = None
            tex = texcache[key]

        props.append(dict(name=name, region=region, cat=region, vOff=vOff, nOff=nOff,
                          uOff=uOff, iOff=iOff, nv=nv, ni=ni, i16=i16, tex=tex,
                          size=size, exact=bool(r.get('uvExact'))))
        per_region[region] = per_region.get(region, 0) + 1

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, 'props.bin'), 'wb') as f:
        f.write(blob)
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(dict(scale=SCALE, regionBuildings=REGION_BUILDINGS,
                       shared=SHARED, props=props), f, ensure_ascii=False, indent=1)

    ntex = sum(1 for v in texcache.values() if v)
    print('props %d, verts %d, bin %.1f MB, tex %d'
          % (len(props), sum(x['nv'] for x in props), len(blob) / 1048576, ntex))
    print('per region:', ' '.join('%s=%d' % kv for kv in sorted(per_region.items())))
    if failed:
        print('failed %d' % failed)


if __name__ == '__main__':
    main()
