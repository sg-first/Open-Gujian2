# -*- coding: utf-8 -*-
"""用原版地形数据重建地表 —— assets/terrain/

来源（全部是原版资产）：
  Maps/<map>/TerrainData/AuxiliaryTextures/Normalmap_x_y.dds   逐 sector 法线图 68x68
                                                                (1px apron + 66x66 核心)
  assets/props/tex/*.png   原版建筑里"扁而宽"的地面/石作片材，改作可平铺的地面细节

产出：
  assets/terrain.normal.png   与世界网格 1:1 对齐的地形法线图（2000x2050，2m/texel）
  assets/terrain/dirt.png     泥土平铺细节
  assets/terrain/stone.png    石作平铺细节

对齐规则与 build_world.py 完全一致：sector 索引 -> map_heights 的数组布局 -> 世界矩形，
保证法线图与高度场、colormap 三者像素级对齐。
"""
import os
import sys
import glob
import json
import struct
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gj2
from build_world import (REGIONS, ASSETS, M_PER_UNIT, SPACING, MARGIN, SEAFLOOR, SEA,
                         resample, load_region_heights)
from dds import DDS

SECTOR_SIDE = 66
STEP = SECTOR_SIDE - 1
APRON = 1                      # Normalmap 68x68 = 1px 边框 + 66x66 核心
FLAT = (128, 128, 255)

# 从原版建筑贴图里挑出的可平铺地面/石作细节（候选见 tools/groundcands.png）
DETAIL = {
    'dirt.png': 'd7f15321bb',     # 土黄泥地 + 碎石
    'stone.png': 'ceac5548ae',    # 石砌墙面
    'slab.png': '29805c097c',     # 石板路
}


def map_normals(map_name):
    """按 map_heights 的同一布局拼出法线数组，返回 (N[...,3] float, cfg)"""
    md = os.path.join(gj2.ROOT, 'Maps', map_name)
    cfg = gj2.terrain_config(os.path.join(md, 'TerrainData', 'Config.vtc'))
    if cfg is None:
        return None, None
    aux = os.path.join(md, 'TerrainData', 'AuxiliaryTextures')
    files = glob.glob(os.path.join(aux, 'Normalmap_*.dds'))
    if not files:
        return None, cfg
    secs = []
    for f in files:
        base = os.path.basename(f)[len('Normalmap_'):-len('.dds')]
        try:
            ix, iy = (int(v) for v in base.split('_'))
        except ValueError:
            continue
        secs.append((f, ix, iy))
    if not secs:
        return None, cfg
    x0 = min(s[1] for s in secs); x1 = max(s[1] for s in secs)
    y0 = min(s[2] for s in secs); y1 = max(s[2] for s in secs)
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    N = np.zeros((ny * STEP + 1, nx * STEP + 1, 3), dtype=np.float64)
    N[..., 0] = FLAT[0]; N[..., 1] = FLAT[1]; N[..., 2] = FLAT[2]
    got = 0
    for f, ix, iy in secs:
        w, h, px = DDS(f).decode(0)
        a = np.frombuffer(px, dtype=np.uint8).reshape(h, w, 4)[:, :, :3].astype(np.float64)
        core = a[APRON:APRON + SECTOR_SIDE, APRON:APRON + SECTOR_SIDE]
        if core.shape[0] != SECTOR_SIDE:
            continue
        N[(iy - y0) * STEP:(iy - y0) * STEP + SECTOR_SIDE,
          (ix - x0) * STEP:(ix - x0) * STEP + SECTOR_SIDE] = core
        got += 1
    cfg = dict(cfg, x0=x0, y0=y0, nx=nx, ny=ny, sectors=got)
    return N, cfg


def main():
    flipg = '--flipg' in sys.argv
    metap = os.path.join(ASSETS, 'world.meta.json')
    meta = json.load(open(metap, encoding='utf-8'))
    W, Hh = meta['width'], meta['height']
    ox, oz = meta['originX'], meta['originZ']
    print('world grid %dx%d, %.0fx%.0f m' % (W, Hh, meta['worldW'], meta['worldH']))

    nrm = np.zeros((Hh, W, 3), dtype=np.float64)
    nrm[..., 0] = FLAT[0]; nrm[..., 1] = FLAT[1]; nrm[..., 2] = FLAT[2]
    covered = np.zeros((Hh, W), dtype=bool)

    total_sec = 0
    for (name, disp, cx, cz, biome) in REGIONS:
        N, cfg = map_normals(name)
        if N is None:
            print('  %-7s no normalmaps' % name); continue
        Hreg, _ = load_region_heights(name)
        rr, cc = Hreg.shape
        if (rr, cc) != N.shape[:2]:
            # 高度场与法线场尺寸不一致时，按较小者裁齐
            r2, c2 = min(rr, N.shape[0]), min(cc, N.shape[1])
            N = N[:r2, :c2]
        w = cfg['nx'] * cfg['sector'] * M_PER_UNIT
        h = cfg['ny'] * cfg['sector'] * M_PER_UNIT
        ow = int(round(w / SPACING)); oh = int(round(h / SPACING))
        gx = int(round((cx - w / 2 - ox) / SPACING))
        gz = int(round((cz - h / 2 - oz) / SPACING))
        gx0, gz0 = max(gx, 0), max(gz, 0)
        gx1, gz1 = min(gx + ow, W), min(gz + oh, Hh)
        if gx1 <= gx0 or gz1 <= gz0:
            continue
        # 各通道分别重采样（与高度场/colormap 使用同一条路径）
        chans = []
        for c in range(3):
            im = Image.fromarray(N[:, :, c].astype(np.float32), mode='F')
            im = im.resize((ow, oh), Image.BILINEAR)
            chans.append(np.asarray(im, dtype=np.float64))
        stack = np.stack(chans, axis=2)
        sub = stack[gz0 - gz:gz1 - gz, gx0 - gx:gx1 - gx]
        nrm[gz0:gz1, gx0:gx1] = sub
        covered[gz0:gz1, gx0:gx1] = True
        total_sec += cfg['sectors']
        print('  %-7s %-6s sectors=%-5d grid=%dx%d  rect x[%d,%d) z[%d,%d)'
              % (name, disp, cfg['sectors'], N.shape[0], N.shape[1], gx0, gx1, gz0, gz1))

    # 法线编码：tangent-space，RGB = n*0.5+0.5
    v = nrm.copy()
    ln = np.linalg.norm(v, axis=2, keepdims=True)
    ln[ln < 1e-6] = 1.0
    v = v / ln
    if flipg:
        v[..., 1] = -v[..., 1]
    out = np.clip(v * 0.5 + 0.5, 0, 1) * 255
    img = Image.fromarray(out.astype(np.uint8), mode='RGB')
    p = os.path.join(ASSETS, 'terrain.normal.png')
    img.save(p, optimize=True)
    print('terrain.normal.png %dx%d  %.2f MB  flipG=%s  sectors=%d  covered=%.1f%%'
          % (W, Hh, os.path.getsize(p) / 1048576, flipg, total_sec,
             100.0 * covered.mean()))

    # ---- 可平铺细节贴图 ----
    d = os.path.join(ASSETS, 'terrain')
    os.makedirs(d, exist_ok=True)
    for out_name, key in DETAIL.items():
        src = os.path.join(ASSETS, 'props', 'tex', key + '.png')
        if not os.path.exists(src):
            print('  detail missing', src); continue
        im = Image.open(src).convert('RGB').resize((512, 512), Image.LANCZOS)
        im.save(os.path.join(d, out_name), optimize=True)
        print('  terrain/%s  <- props/tex/%s.png' % (out_name, key))

    # ---- 水面法线（可选）----
    # 注：原版水面法线 `Water\perlinNormalHeight.dds` 在加密的 zpkg 内、未落盘，
    #     这里按 fBm 值噪声生成一张等价用途的平铺法线图作为替身。
    if '--nonormal' not in sys.argv:
        make_water_normal(os.path.join(d, 'water.normal.png'))


def make_water_normal(path, size=256, seed=11):
    rng = np.random.default_rng(seed)
    acc = np.zeros((size, size), dtype=np.float64)
    amp = 1.0
    tot = 0.0
    for cells in (4, 8, 16, 32):
        g = rng.random((cells, cells))
        im = Image.fromarray((g * 255).astype(np.uint8), mode='L').resize((size, size), Image.BICUBIC)
        acc += (np.asarray(im, dtype=np.float64) / 255.0) * amp
        tot += amp
        amp *= 0.62
    hgt = acc / tot
    gy, gx = np.gradient(hgt * 6.0)
    nx, ny, nz = -gx, -gy, np.ones_like(hgt)
    n = np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.stack([(nx / n * 0.5 + 0.5), (ny / n * 0.5 + 0.5), (nz / n * 0.5 + 0.5)], axis=2)
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), mode='RGB').save(path, optimize=True)
    print('  terrain/water.normal.png %dx%d (fBm 替身)' % (size, size))


if __name__ == '__main__':
    main()
