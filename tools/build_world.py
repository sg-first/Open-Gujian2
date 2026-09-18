# -*- coding: utf-8 -*-
"""
古剑奇谭二 资产 -> 开放世界世界数据
输出到 ../assets/:
  world.heights.bin   Uint16 高度场 (行主序, 0..65535 映射 hmin..hmax)
  world.colormap.png  地表颜色图 (同时用作 minimap 底图)
  world.meta.json     世界元数据 + 区域定义
  veg/<region>.png    植被图集 (原版 grass.dds, 4x4 cell)
  mapimg/<region>.png 原版区域地图 (ui/image/trmap)
  ui/...              物品/怪物/技能图标, 角色立绘, 剧情图
"""
import os, sys, json, math, random, shutil
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
from PIL import Image
import gj2

ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
M_PER_UNIT = 0.01            # 引擎单位 -> 米 (1 unit = 1 cm)
SPACING = 2.0                # 世界采样间距 米
MARGIN = 100.0               # 大陆外海宽度 米
SEAFLOOR = -14.0             # 海底高度
COAST = 170.0                 # 海岸过渡带宽 米
SEA = 0.0

# ---------------- 区域定义 ----------------
REGIONS = [
    # name, 显示名, 中心x, 中心z, 类型
    ('n04',   '沧澜山脉',    0.0,     0.0,  'mountain'),
    ('n01p1', '望仙台',      550.0, -1450.0, 'hill'),
    ('q08',   '断霄岭',     1550.0, -1250.0, 'mountain'),
    ('n08',   '镜湖秘境',  -1500.0,  -850.0, 'lake'),
    ('n01p2', '青萝谷',    -1500.0,   350.0, 'valley'),
    ('n12p3', '禾风平原',   1500.0,   450.0, 'plain'),
    ('q04b',  '赤岩荒原',   -350.0,  1650.0, 'desert'),
    ('q07',   '落霞坡',    -1400.0,  1300.0, 'hill'),
    ('n10',   '雾隐林',     1500.0,  1350.0, 'forest'),
]
REGION_BIOME = {
    'mountain': dict(rock=0.55, snow=240, tree=0.020, grass=0.16, tint=(0.62, 0.66, 0.50)),
    'hill':     dict(rock=0.62, snow=320, tree=0.10,  grass=0.30, tint=(0.55, 0.68, 0.42)),
    'lake':     dict(rock=0.60, snow=320, tree=0.07,  grass=0.34, tint=(0.50, 0.70, 0.45)),
    'valley':   dict(rock=0.60, snow=320, tree=0.12,  grass=0.32, tint=(0.48, 0.66, 0.40)),
    'plain':    dict(rock=0.75, snow=999, tree=0.012, grass=0.45, tint=(0.62, 0.72, 0.38)),
    'desert':   dict(rock=0.50, snow=999, tree=0.008, grass=0.10, tint=(0.72, 0.62, 0.42)),
    'forest':   dict(rock=0.65, snow=320, tree=0.22,  grass=0.38, tint=(0.42, 0.60, 0.36)),
}


def load_region_heights(name):
    H, cfg = gj2.map_heights(name)
    if H is None:
        return None, None
    nx, ny = cfg['nx'], cfg['ny']
    w = nx * cfg['sector'] * M_PER_UNIT
    h = ny * cfg['sector'] * M_PER_UNIT
    return H * M_PER_UNIT, (w, h)


def resample(H, out_w, out_h):
    im = Image.fromarray(H.astype(np.float32), mode='F')
    im = im.resize((out_w, out_h), Image.BILINEAR)
    return np.asarray(im, dtype=np.float64)


def value_noise(shape, cell, rng, octaves=4, persistence=0.5):
    """简单 fBm 值噪声"""
    out = np.zeros(shape)
    amp, total = 1.0, 0.0
    c = cell
    for _ in range(octaves):
        gw, gh = int(shape[1] / c) + 2, int(shape[0] / c) + 2
        g = rng.random((gh, gw))
        im = Image.fromarray((g * 255).astype(np.uint8), mode='L')
        im = im.resize((shape[1], shape[0]), Image.BILINEAR)
        out += (np.asarray(im, dtype=np.float64) / 255.0 - 0.5) * 2 * amp
        total += amp
        amp *= persistence
        c = max(2, c / 2)
    return out / total


def smoothstep(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def tiling_value_noise(size, cells, rng):
    """无缝平铺值噪声 (0..1)"""
    g = rng.random((cells, cells))
    ys = np.arange(size) * cells / size
    x0 = np.floor(ys).astype(int); fx = ys - x0
    sx = fx * fx * (3 - 2 * fx)
    A = np.array([g[x0[i] % cells] * (1 - sx[i]) + g[(x0[i] + 1) % cells] * sx[i]
                  for i in range(size)])
    xc = np.arange(size) * cells / size
    x0c = np.floor(xc).astype(int); fc = xc - x0c
    sc = fc * fc * (3 - 2 * fc)
    B = np.zeros((size, size))
    for j in range(size):
        j0, j1 = x0c[j] % cells, (x0c[j] + 1) % cells
        B[:, j] = A[:, j0] * (1 - sc[j]) + A[:, j1] * sc[j]
    return (B - B.min()) / (B.max() - B.min() + 1e-9)


def main():
    random.seed(7)
    rng = np.random.default_rng(7)
    os.makedirs(ASSETS, exist_ok=True)
    for sub in ['veg', 'mapimg', 'ui/item', 'ui/monster', 'ui/skill', 'ui/face', 'ui/story']:
        os.makedirs(os.path.join(ASSETS, sub), exist_ok=True)

    # ---------- 1. 计算世界范围 ----------
    infos = []
    for name, disp, cx, cz, biome in REGIONS:
        H, (w, h) = load_region_heights(name)
        if H is None:
            print('skip', name); continue
        infos.append(dict(name=name, disp=disp, cx=cx, cz=cz, w=w, h=h,
                          biome=biome, H=H))
        print(f'{name:6s} {disp}  {w:.0f}x{h:.0f} m  h {H.min():.0f}..{H.max():.0f} m')
    x0 = min(i['cx'] - i['w'] / 2 for i in infos) - MARGIN
    x1 = max(i['cx'] + i['w'] / 2 for i in infos) + MARGIN
    z0 = min(i['cz'] - i['h'] / 2 for i in infos) - MARGIN
    z1 = max(i['cz'] + i['h'] / 2 for i in infos) + MARGIN
    WORLD_W = math.ceil((x1 - x0) / SPACING)
    WORLD_H = math.ceil((z1 - z0) / SPACING)
    print(f'world {WORLD_W}x{WORLD_H} samples, {(x1-x0):.0f}x{(z1-z0):.0f} m')

    world = np.full((WORLD_H, WORLD_W), SEAFLOOR, dtype=np.float64)

    # ---------- 2. 放置区域 ----------
    for info in infos:
        H = info['H']
        # 高度偏移: 让区域 5% 分位略高于海面, 形成海岸
        base = np.percentile(H, 5)
        H = H - base + 4.0
        ow, oh = int(round(info['w'] / SPACING)), int(round(info['h'] / SPACING))
        Hr = resample(H, ow, oh)
        gx = int(round((info['cx'] - info['w'] / 2 - x0) / SPACING))
        gz = int(round((info['cz'] - info['h'] / 2 - z0) / SPACING))
        gx0, gz0 = max(gx, 0), max(gz, 0)
        gx1, gz1 = min(gx + ow, WORLD_W), min(gz + oh, WORLD_H)
        sub = Hr[gz0 - gz:gz1 - gz, gx0 - gx:gx1 - gx]
        # 海岸过渡: 距边缘越近越压向海底
        fy = np.minimum(np.arange(sub.shape[0])[:, None], np.arange(sub.shape[0])[:, None][::-1])
        fx = np.minimum(np.arange(sub.shape[1])[None, :], np.arange(sub.shape[1])[None, :][::-1])
        d = np.minimum(fx, fy) * SPACING
        k = smoothstep(d / COAST)
        sub = SEAFLOOR + (sub - SEAFLOOR) * k
        world[gz0:gz1, gx0:gx1] = sub
        info.update(gx=gx, gz=gz, ow=ow, oh=oh)

    # ---------- 3. 细节噪声 + 平滑 ----------
    land = world > SEA - 2
    n1 = value_noise(world.shape, 24, rng, octaves=4)
    world += np.where(land, n1 * 1.4, 0.0)
    # 轻平滑去接缝
    K = np.array([[1, 2, 1], [2, 4, 2], [1, 2, 1]], dtype=np.float64) / 16.0
    from numpy.lib.stride_tricks import sliding_window_view
    pad = np.pad(world, 1, mode='edge')
    world = (sliding_window_view(pad, (3, 3)) * K).sum(axis=(2, 3))

    hmin, hmax = -40.0, 420.0
    q = np.clip((world - hmin) / (hmax - hmin), 0, 1)
    (q * 65535).astype('<u2').tofile(os.path.join(ASSETS, 'world.heights.bin'))
    print('heights.bin', os.path.getsize(os.path.join(ASSETS, 'world.heights.bin')) // 1024, 'KB')

    # ---------- 4. 颜色图 ----------
    zz = world
    gy, gx = np.gradient(zz, SPACING)
    slope = np.sqrt(gx * gx + gy * gy)
    ny, nx = zz.shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    noise = value_noise(zz.shape, 13, rng, octaves=3)

    col = np.zeros((ny, nx, 3))
    deep = np.array([0.08, 0.19, 0.32]); shallow = np.array([0.16, 0.38, 0.52])
    sand = np.array([0.78, 0.72, 0.52]); grass = np.array([0.36, 0.50, 0.26])
    grass2 = np.array([0.30, 0.44, 0.22]); rock = np.array([0.44, 0.42, 0.40])
    snow = np.array([0.92, 0.93, 0.95])

    t_water = smoothstep((zz + 14) / 14.0)          # 深浅水
    t_sand = smoothstep((zz - 0.5) / 2.5)
    t_grass = smoothstep((zz - 2) / 5.0)
    t_rock = smoothstep((slope - 0.68) / 0.32)
    t_snow = smoothstep((zz - 250) / 45.0)
    base_g = grass + (grass2 - grass) * (noise * 0.5 + 0.5)[..., None]
    c = deep + (shallow - deep) * t_water[..., None]
    c = c + (sand - c) * t_sand[..., None]
    c = c + (base_g - c) * t_grass[..., None]
    c = c + (rock - c) * t_rock[..., None]
    c = c + (snow - c) * t_snow[..., None]
    # 区域色调
    for info in infos:
        tint = np.array(REGION_BIOME[info['biome']]['tint'])
        gx0, gz0, gx1, gz1 = info['gx'], info['gz'], info['gx'] + info['ow'], info['gz'] + info['oh']
        gx0c, gz0c = max(gx0, 0), max(gz0, 0)
        gx1c, gz1c = min(gx1, nx), min(gz1, ny)
        if gx1c <= gx0c or gz1c <= gz0c:
            continue
        reg = c[gz0c:gz1c, gx0c:gx1c]
        k = 0.25 * t_grass[gz0c:gz1c, gx0c:gx1c, None]
        reg[:] = reg * (1 - k) + reg * tint[None, None, :] * 1.6 * k
    # 山体阴影 (西北光)
    light = np.array([-0.6, -0.6, 0.53]); light /= np.linalg.norm(light)
    nrm = np.dstack([-gx / SPACING, -gy / SPACING, np.ones_like(zz)])
    nrm /= np.linalg.norm(nrm, axis=2, keepdims=True)
    shade = np.clip((nrm @ light) * 0.55 + 0.62, 0.35, 1.25)
    col = np.clip(c * shade[..., None] * 255, 0, 255).astype(np.uint8)
    Image.fromarray(col).save(os.path.join(ASSETS, 'world.colormap.png'), optimize=True)
    print('colormap done')

    # ---------- 5. 植被图集 ----------
    ref_atlas = None
    for info in infos:
        src = os.path.join(gj2.ROOT, 'Maps', info['name'], f"{info['name']}_grass.dds")
        if not os.path.exists(src):
            src = os.path.join(gj2.ROOT, 'Maps', 'n04', 'n04_grass.dds')
        im = Image.open(src)
        if im.mode != 'RGBA':
            im = im.convert('RGBA')
        im = im.resize((1024, 1024), Image.LANCZOS)
        # 修补空 cell (alpha 均值过低): 用 n04 图集对应 cell 替换
        if ref_atlas is None:
            r0 = Image.open(os.path.join(gj2.ROOT, 'Maps', 'n04', 'n04_grass.dds')).convert('RGBA')
            ref_atlas = r0.resize((1024, 1024), Image.LANCZOS)
        a = np.asarray(im)
        patched = a.copy()
        for r in range(4):
            for c in range(4):
                cell = a[r * 256:(r + 1) * 256, c * 256:(c + 1) * 256, 3]
                if cell.mean() < 8:
                    ref = np.asarray(ref_atlas)[r * 256:(r + 1) * 256, c * 256:(c + 1) * 256]
                    patched[r * 256:(r + 1) * 256, c * 256:(c + 1) * 256] = ref
        im = Image.fromarray(patched)
        im.save(os.path.join(ASSETS, 'veg', f"{info['name']}.png"))
        info['veg'] = f"veg/{info['name']}.png"
        print('veg', info['name'], 'from', os.path.basename(src))

    # ---------- 5b. 地面细节纹理 ----------
    dn = (tiling_value_noise(256, 24, rng) * 0.6 +
          tiling_value_noise(256, 64, rng) * 0.4)
    Image.fromarray((dn * 255).astype(np.uint8)).save(
        os.path.join(ASSETS, 'detail.png'), optimize=True)

    # ---------- 6. 原版区域地图 ----------
    for info in infos:
        src = os.path.join(gj2.ROOT, 'ui', 'image', 'trmap', f"{info['name']}.dds")
        if os.path.exists(src):
            im = Image.open(src).convert('RGB')
            im.thumbnail((768, 768), Image.LANCZOS)
            im.save(os.path.join(ASSETS, 'mapimg', f"{info['name']}.png"))

    # ---------- 7. UI 资产 ----------
    def cp(src_dir, dst_dir, prefix, limit, exts=('.png',)):
        fs = [f for f in os.listdir(os.path.join(gj2.ROOT, src_dir)) if f.lower().endswith(exts)]
        fs.sort()
        step = max(1, len(fs) // limit)
        for i, f in enumerate(fs[::step][:limit]):
            shutil.copy(os.path.join(gj2.ROOT, src_dir, f),
                        os.path.join(ASSETS, dst_dir, f"{prefix}{i:02d}{os.path.splitext(f)[1]}"))
        return min(limit, len(fs[::step]))
    n_item = cp('ui/image/tritem', 'ui/item', 'item_', 48)
    n_mon = cp('ui/image/monster', 'ui/monster', 'mon_', 24)
    n_skill = cp('ui/image/trcombat/icon', 'ui/skill', 'skill_', 24)
    n_story = cp('ui/image/trstory', 'ui/story', 'story_', 8)
    n_face = 0
    for c in ['101', '102', '103', '104', '105', '106', '107']:
        p = os.path.join(gj2.ROOT, 'Characters', c, f'{c}_face_000_d.dds')
        if os.path.exists(p):
            im = Image.open(p).convert('RGB'); im.thumbnail((256, 256), Image.LANCZOS)
            im.save(os.path.join(ASSETS, 'ui/face', f'face_{c}.png')); n_face += 1

    # ---------- 8. 出生点 ----------
    info0 = infos[0]
    spawn = [info0['cx'], info0['cz']]

    meta = dict(
        spacing=SPACING, width=WORLD_W, height=WORLD_H,
        worldW=WORLD_W * SPACING, worldH=WORLD_H * SPACING,
        originX=x0, originZ=z0, hmin=hmin, hmax=hmax, seaLevel=SEA,
        spawn=spawn,
        regions=[dict(name=i['name'], disp=i['disp'], cx=i['cx'], cz=i['cz'],
                      w=i['w'], h=i['h'], biome=i['biome'], veg=i['veg'],
                      **REGION_BIOME[i['biome']]) for i in infos],
        ui=dict(items=n_item, monsters=n_mon, skills=n_skill, story=n_story, faces=n_face),
    )
    with open(os.path.join(ASSETS, 'world.meta.json'), 'w', encoding='utf8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print('meta written; regions:', len(meta['regions']))


if __name__ == '__main__':
    main()
