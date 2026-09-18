# -*- coding: utf-8 -*-
"""古剑奇谭二 (Vision Engine) 资产解析基础库"""
import os, struct, glob
import numpy as np

ROOT = r'E:\BaiduNetdiskDownload\Gujian.2\RPGproject'


# ---------- VBIN 容器 ----------
def vbin_chunks(data):
    """chunk = TAG(4) + size(4) + flag(4) + payload(size) + TAG(4) + u32(0)"""
    off, out = 12, []
    n = len(data)
    while off + 20 <= n:
        tag = data[off:off + 4]
        if not all(32 <= c < 127 for c in tag):
            break
        size, flag = struct.unpack_from('<II', data, off + 4)
        if off + 12 + size + 8 > n:
            break
        out.append((tag.decode('latin1'), flag, data[off + 12:off + 12 + size]))
        off += 20 + size
    return out


def terrain_config(vtc_path):
    """返回地形配置: sector 网格数 / 尺寸 / 原点"""
    for tag, flag, pay in vbin_chunks(open(vtc_path, 'rb').read()):
        if tag != 'FNOC':
            continue
        o = 0
        ln = struct.unpack_from('<I', pay, o)[0]; o += 4
        name = pay[o:o + ln].decode('latin1', 'ignore'); o += ln
        sx, sy = struct.unpack_from('<II', pay, o); o += 8
        f = struct.unpack_from('<8f', pay, o)
        return dict(name=name, sx=sx, sy=sy, sector=f[0], origin=(f[2], f[3]),
                    hmin=f[4], hmax=f[5], far=f[6])
    return None


def load_hmap(path):
    d = open(path, 'rb').read()
    _a, cnt = struct.unpack_from('<II', d, 0)
    side = int(round(cnt ** 0.5))
    return np.frombuffer(d, dtype='<f4', count=side * side, offset=8).reshape(side, side)


def map_heights(map_name):
    """把某张地图的所有 sector 拼成一整块高度场 (单位: cm)"""
    md = os.path.join(ROOT, 'Maps', map_name)
    cfg = terrain_config(os.path.join(md, 'TerrainData', 'Config.vtc'))
    if cfg is None:
        return None, None
    side = 66
    step = side - 1                      # 65 唯一顶点 + 1 与邻块共享
    secs = []
    for f in glob.glob(os.path.join(md, 'TerrainData', 'Sectors', '*.hmap')):
        base = os.path.basename(f)[len('Sector_'):-len('.hmap')]
        try:
            ix, iy = (int(v) for v in base.split('_'))
        except ValueError:
            continue
        secs.append((f, ix, iy))
    if not secs:
        return None, cfg
    # sector 索引允许为负（LOD 外扩环），按实际范围建数组
    x0 = min(s[1] for s in secs); x1 = max(s[1] for s in secs)
    y0 = min(s[2] for s in secs); y1 = max(s[2] for s in secs)
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    H = np.full((ny * step + 1, nx * step + 1), np.nan, dtype=np.float64)
    for f, ix, iy in secs:
        a = load_hmap(f)
        H[(iy - y0) * step:(iy - y0) * step + side,
          (ix - x0) * step:(ix - x0) * step + side] = a
    cfg = dict(cfg, x0=x0, y0=y0, nx=nx, ny=ny)
    # 填补缺失 sector
    if np.isnan(H).any():
        m = np.isnan(H)
        idx = np.where(~m, np.arange(H.size).reshape(H.shape), 0)
        np.maximum.accumulate(idx, axis=0, out=idx)
        np.maximum.accumulate(idx, axis=1, out=idx)
        H[m] = H.ravel()[np.maximum(idx[m], 0)] if (~m).any() else 0.0
        H = np.nan_to_num(H, nan=0.0)
    return H, cfg
