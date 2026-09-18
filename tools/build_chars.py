#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Gujian2 character exporter: .rawXAC -> webapp runtime format.

Emits for each character:
  assets/chars/<id>.json   skeleton + mesh groups + material texture refs
  assets/chars/<id>.bin    packed vertex / index buffers
  assets/chars/tex/*.png   diffuse textures (converted from .dds, downscaled)
"""
import os, sys, json, struct, shutil, math

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xac import parse_xac
from dds import dds_to_png          # 纯 stdlib DDS(DXT1/3/5) -> PNG

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SRC = os.path.abspath(os.path.join(ROOT, '..'))          # RPGproject
OUT = os.path.join(ROOT, 'assets', 'chars')
CHAR_IDS = ['101', '102', '103', '104', '105', '106', '107']

ATTR_POS, ATTR_NRM, ATTR_TAN, ATTR_UV, ATTR_INFL = 0, 1, 2, 3, 5
DIFFUSE_MAPTYPES = (2, 4)     # 2 = diffuse, 4 = ? (also diffuse in these files)


def index_textures(*dirs):
    """lowercased stem -> dds path"""
    idx = {}
    for base in dirs:
        if not os.path.isdir(base):
            continue
        for root, _ds, files in os.walk(base):
            for f in files:
                if f.lower().endswith('.dds'):
                    idx.setdefault(os.path.splitext(f)[0].lower(),
                                   os.path.join(root, f))
    return idx


# 角色材质经常复用其它角色 / 公共目录的贴图（如 105 用 103_body01_d、
# 107 用 OJ073_01d），所以建一份全局贴图索引做兜底。
_global_tex = None
def global_textures():
    global _global_tex
    if _global_tex is None:
        _global_tex = index_textures(os.path.join(SRC, 'Characters'),
                                     os.path.join(SRC, 'models'))
    return _global_tex


def pick_diffuse(mat):
    for l in mat.get('layers', []):
        if l['mapType'] in DIFFUSE_MAPTYPES:
            return l['tex']
    if mat.get('layers'):
        return mat['layers'][0]['tex']
    return None


def build_char(cid):
    char_dir = os.path.join(SRC, 'Characters', cid)
    # 必须用 <id>.rawXAC: 它是"本体+头部+武器"的完整合成 actor。
    # <id>_body.xac 只有身体/头发，**不含头部网格**（头在 rawXAC / _face.xac 里），
    # 用它导出会得到没有头皮肤的角色（脸部只剩嘴唇贴片）。
    xac_path = os.path.join(char_dir, cid + '.rawXAC')
    if not os.path.exists(xac_path):
        xac_path = os.path.join(char_dir, cid + '_body.xac')
    x = parse_xac(xac_path)
    nodes = x['nodes']
    tex_idx = index_textures(char_dir)

    # ---- skeleton ----
    def fin(v, d=0.0):
        # 部分 rawXAC 的未使用节点(武器挂点/Nub)带 NaN/Inf，
        # 直接 dump 会产生非法 JSON(浏览器 JSON.parse 拒绝 NaN 字面量)
        return float(v) if math.isfinite(v) else d

    bones = []
    for n in nodes:
        q = n['rot']            # xyzw
        s = n['scale']
        bones.append(dict(name=n['name'], parent=n['parent'],
                          p=[fin(v) for v in n['pos']],
                          q=[fin(q[0]), fin(q[1]), fin(q[2]), fin(q[3], 1.0)],
                          s=[fin(v, 1.0) for v in s]))

    # ---- skinning lookup per node ----
    skin_of = {}
    for sk in x['skins']:
        if 'error' in sk:
            continue
        skin_of[sk['nodeId']] = sk

    # ---- collect visual meshes ----
    groups = []
    POS, NRM, UV, BI, BW, IDX = [], [], [], [], [], []
    vbase = 0
    tex_used = {}
    for m in x['meshes']:
        if 'error' in m or m['numVerts'] < 400:
            continue                                  # skip collision boxes
        nid = m['nodeId']
        sk = skin_of.get(nid)
        atr = {}
        for a in m['attribs']:
            atr.setdefault(a['type'], a)
        if ATTR_POS not in atr:
            continue
        a_pos = atr[ATTR_POS]
        a_nrm = atr.get(ATTR_NRM)
        a_uv = atr.get(ATTR_UV)
        a_inf = atr.get(ATTR_INFL)
        nv = m['numVerts']

        # 蒙皮骨骼索引说明（已用骨骼名验证）:
        # - influences 属性(type5)是"新顶点 -> 原顶点"的 remap 表
        #   (distinct 值个数 == numOrgVerts)，ranges 按原顶点索引；
        # - skin 块的 influence 对是 (boneId:int, weight:float)，
        #   boneId **直接就是节点索引**（脸部顶点全绑 Bip01 Head、
        #   身体绑 R Hand/Finger/Clavicle），不做任何调色板间接映射。
        # - submesh 的 bones 数组只是该 submesh 用到的节点列表
        #   (去重并集 == numLocalBones)，不用于解释 influence。

        pos = struct.unpack('<%df' % (nv * 3), a_pos['data'])
        nrm = (struct.unpack('<%df' % (nv * 3), a_nrm['data'])
               if a_nrm else (0.0,) * (nv * 3))
        uv = (struct.unpack('<%df' % (nv * 2), a_uv['data'])
              if a_uv else (0.0,) * (nv * 2))
        inf = (struct.unpack('<%dI' % nv, a_inf['data'])
               if a_inf else (0,) * nv)

        # expand skinning
        for i in range(nv):
            bi = [0, 0, 0, 0]
            bw = [0.0, 0.0, 0.0, 0.0]
            if sk:
                ri = inf[i]
                if 0 <= ri < len(sk['ranges']):
                    first, cnt = sk['ranges'][ri]
                    cand = []
                    for j in range(min(cnt, 16)):
                        k = first + j
                        if k >= len(sk['infl']):
                            break
                        b, w = sk['infl'][k]
                        if w > 0:
                            cand.append((w, b))
                    cand.sort(reverse=True)
                    for t, (w, b) in enumerate(cand[:4]):
                        bw[t] = w
                        bi[t] = b if 0 <= b < len(bones) else 0
                    ssum = sum(bw)
                    if ssum > 1e-6:
                        bw = [v / ssum for v in bw]
                    else:
                        bw = [1.0, 0, 0, 0]
            POS.append([v if math.isfinite(v) else 0.0
                        for v in pos[i * 3:i * 3 + 3]])
            NRM.append([v if math.isfinite(v) else 0.0
                        for v in nrm[i * 3:i * 3 + 3]])
            UV.append([v if math.isfinite(v) else 0.0
                       for v in uv[i * 2:i * 2 + 2]])
            BI.append(bi)
            BW.append(bw)

        # XAC 的 submesh 索引是"子网格内局部索引": 顶点属性按 submesh 顺序连续排布,
        # 每个 submesh 自带 numVerts, 索引从 0 起。因此偏移 = 全局基址 + 该 mesh 内已累计的顶点数。
        local = 0
        for s in m['subs']:
            nsub = s.get('numVerts') or 0
            if not s['idx']:
                local += nsub
                continue
            mat_id = s['mat']
            tex = None
            if 0 <= mat_id < len(x['mats']):
                tex = pick_diffuse(x['mats'][mat_id])
            key = (tex or 'default').lower()
            if tex:
                tex_used[key] = tex
            start = len(IDX)
            base = vbase + local
            for ix in s['idx']:
                IDX.append(ix + base)
            groups.append(dict(start=start, count=len(s['idx']), tex=key))
            local += nsub
        vbase += nv

    if not groups:
        return None

    # ---- pack binary ----
    N = len(POS)
    out = bytearray()
    off = {}

    def put(arr, fmt):
        nonlocal out
        o = len(out)
        out += struct.pack('<%d%s' % (len(arr), fmt), *arr)
        return o

    flat = [v for t in POS for v in t]
    off['pos'] = put(flat, 'f')
    flat = [v for t in NRM for v in t]
    off['nrm'] = put(flat, 'f')
    flat = [v for t in UV for v in t]
    off['uv'] = put(flat, 'f')
    flat = [v for t in BI for v in t]
    off['bi'] = put(flat, 'H')
    flat = [v for t in BW for v in t]
    off['bw'] = put(flat, 'f')
    off['idx'] = put(IDX, 'I')
    off['end'] = len(out)

    # ---- textures ----
    texdir = os.path.join(OUT, 'tex')
    os.makedirs(texdir, exist_ok=True)
    texmap = {}
    for key, tex in tex_used.items():
        src = tex_idx.get(key) or global_textures().get(key)
        if not src:
            print('    tex MISSING %s' % key)
            continue
        dst = os.path.join(texdir, '%s_%s.png' % (cid, key))
        try:
            size = dds_to_png(src, dst, 512)
            texmap[key] = 'tex/%s_%s.png' % (cid, key)
            print('    tex %-14s %s -> %s' % (key, os.path.basename(src), size))
        except Exception as e:
            print('    tex FAIL %s: %s' % (key, e))

    # ---- bounds ----
    xs = [t[0] for t in POS]; ys = [t[1] for t in POS]; zs = [t[2] for t in POS]
    meta = dict(id=cid, scale=0.01,
                bones=bones,
                groups=[g for g in groups],
                tex=texmap,
                counts=dict(verts=N, idx=len(IDX)),
                offsets=off,
                bounds=dict(min=[min(xs), min(ys), min(zs)],
                            max=[max(xs), max(ys), max(zs)]))
    with open(os.path.join(OUT, cid + '.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False)
    with open(os.path.join(OUT, cid + '.bin'), 'wb') as f:
        f.write(out)
    print('  -> %s: %d verts / %d idx / %d groups / %d bones / %.1f KB' % (
        cid, N, len(IDX), len(groups), len(bones), len(out) / 1024))
    return meta


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    all_meta = {}
    for cid in CHAR_IDS:
        print('== character', cid)
        try:
            m = build_char(cid)
            if m:
                all_meta[cid] = {k: v for k, v in m.items() if k != 'bones'}
        except Exception as e:
            import traceback
            traceback.print_exc()
            print('  FAILED', cid, e)
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(all_meta, f, ensure_ascii=False, indent=1)
    print('done')
