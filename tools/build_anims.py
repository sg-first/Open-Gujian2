#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build_anims.py —— 把原版 XSM 骨骼动画烘焙成 webapp 可用的 JSON。

源: RPGproject/Characters/101/*.xsm  (EmotionFX skeletal motion)
出: webapp/assets/chars/anims/<name>.json

每帧四元数为"相对父骨骼的局部旋转"(与 XAC 骨架一致)，quat16/32767 归一化。
Bip01(根) 位置轨道保留相对首帧的 y 起伏，x/z 归零(原地循环，位移由游戏逻辑驱动)。

同时标定两个 ALS 关键参数(见 tools 说明)：
  stride —— 动画固有地面速度(m/s)：支撑脚着地期间的向后速度中位数。
              播放速率 = 实际速度 / stride  →  脚不打滑。
  cphase —— 触地相位(0..1)：脚最低点所在相位。多个移动动画共用一条腿部循环
              相位，按 cphase 对齐后切换/混合即可保持步态连续(不跳脚)。

压缩：贪心抽稀(旋转 < 0.35° / 位置 < 0.15cm 误差内删除中间帧)，
      循环动画 y 起伏线性扣除首尾差以保证无缝。
"""
import os, sys, json, struct, math

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SRC = os.path.abspath(os.path.join(ROOT, '..', 'Characters'))
OUT = os.path.join(ROOT, 'assets', 'chars', 'anims')

ANIMS = {
    'idle':   ('101', 'y09.exported.xsm',  True),
    'walk':   ('101', 'y01.xsm',           True),
    'run':    ('101', 'y02.xsm',           True),
    'sprint': ('101', 'fast.exported.xsm', True),
    'attack': ('101', 'j01a.exported.xsm', False),
    'jump':   ('101', 'y04a.exported.xsm', False),
}
GAITS = ('walk', 'run', 'sprint')      # 需要标定步幅/触地相位的移动动画
FOOT_BONES = ('Bip01 L Foot', 'Bip01 R Foot')

# 由 tools/probe_stride.js 在真实渲染环境(three.js)实测的原生步速，作为权威值。
# 本文件的 FK 标定是离线近似（受插值/根位移处理差异影响，偏差可达 ~20%），
# 若两者差异过大只提示不覆盖 —— 以实测为准，保证游戏里脚不打滑。
VERIFIED_STRIDE = {'walk': 1.05, 'run': 4.18, 'sprint': 6.33}

ROT_EPS = 0.35      # 抽稀保留的旋转误差(度)
POS_EPS = 0.15      # 抽稀保留的位置误差(cm，模型为厘米级)
MESH_SCALE = 0.01   # 模型厘米 -> 世界米


# ============================ XSM 解析 ============================
def rd_str(d, o):
    n = struct.unpack_from('<I', d, o)[0]
    return d[o + 4:o + 4 + n].decode('utf-8', 'replace'), o + 4 + n


def parse_xsm_tracks(path):
    """返回 {boneName: {'rot':[(t,x,y,z,w)], 'pos':[(t,x,y,z)]}}，只含有动画的轨道。"""
    d = open(path, 'rb').read()
    if d[:4] != b'XSM ':
        raise ValueError('not XSM: ' + path)
    o = 8
    while o + 12 <= len(d):
        t, ln, ver = struct.unpack_from('<iii', d, o)
        o += 12
        if t == 0xCA:
            break
        o += ln
    else:
        raise ValueError('no motion chunk')
    p = o
    n = struct.unpack_from('<i', d, p)[0]
    p += 4
    tracks = {}
    for _ in range(n):
        np_, nr_, nscl, nsr = struct.unpack_from('<4i', d, p + 80)
        p += 100
        name, p = rd_str(d, p)
        pos = []
        for _ in range(np_):
            v = struct.unpack_from('<3f', d, p)
            tt = struct.unpack_from('<f', d, p + 12)[0]
            pos.append((tt, v[0], v[1], v[2]))
            p += 16
        rot = []
        for _ in range(nr_):
            q = struct.unpack_from('<4h', d, p)
            tt = struct.unpack_from('<f', d, p + 8)[0]
            rot.append((tt, q[0] / 32767.0, q[1] / 32767.0,
                        q[2] / 32767.0, q[3] / 32767.0))
            p += 12
        p += nscl * 16 + nsr * 12
        if rot or pos:
            tr = {}
            if rot:
                tr['rot'] = rot
            if pos:
                tr['pos'] = pos
            tracks[name] = tr
    return tracks


# ============================ 插值与 FK ============================
def nlerp(a, b, u):
    return [a[i] * (1 - u) + b[i] * u for i in range(len(a))]


def quat_angle_deg(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    return math.degrees(2 * math.acos(max(-1.0, min(1.0, abs(dot)))))


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def qnorm(q):
    n = math.sqrt(sum(v * v for v in q)) or 1.0
    return tuple(v / n for v in q)


def qslerp(a, b, u):
    d = sum(x * y for x, y in zip(a, b))
    if d < 0:
        b = tuple(-v for v in b); d = -d
    if d > 0.9995:
        return qnorm(tuple(a[i] + (b[i] - a[i]) * u for i in range(4)))
    th = math.acos(max(-1.0, min(1.0, d)))
    s = math.sin(th)
    return qnorm(tuple(a[i] * (math.sin((1 - u) * th) / s) +
                       b[i] * (math.sin(u * th) / s) for i in range(4)))


def q2m(q):
    """四元数 -> 旋转矩阵(列向量约定, 与 three.js 一致)"""
    x, y, z, w = q
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]


def mvec(A, v):
    return [sum(A[i][k] * v[k] for k in range(3)) for i in range(3)]


def sample_rot(keys, t):
    if not keys:
        return None
    if t <= keys[0][0]:
        return tuple(keys[0][1:])
    if t >= keys[-1][0]:
        return tuple(keys[-1][1:])
    lo, hi = 0, len(keys) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if keys[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    t0, t1 = keys[lo][0], keys[hi][0]
    u = (t - t0) / (t1 - t0) if t1 > t0 else 0
    return qslerp(keys[lo][1:], keys[hi][1:], u)


def sample_pos(keys, t):
    if not keys:
        return None
    if t <= keys[0][0]:
        return keys[0][1:]
    if t >= keys[-1][0]:
        return keys[-1][1:]
    lo, hi = 0, len(keys) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if keys[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    t0, t1 = keys[lo][0], keys[hi][0]
    u = (t - t0) / (t1 - t0) if t1 > t0 else 0
    return [keys[lo][1 + i] + (keys[hi][1 + i] - keys[lo][1 + i]) * u for i in range(3)]


def bone_chain(bones, idx):
    chain = []
    i = idx
    while i >= 0:
        chain.append(i)
        i = bones[i]['parent']
    chain.reverse()
    return chain


def chain_world(bones, chain, tracks, t):
    """自根向下组合局部变换，返回末端骨骼原点的模型空间坐标(厘米)。"""
    pos = [0.0, 0.0, 0.0]
    rot = (0.0, 0.0, 0.0, 1.0)
    for ci in chain:
        b = bones[ci]
        lp = list(b['p'])
        if b['parent'] < 0:
            pp = tracks.get(b['name'], {}).get('pos')
            if pp:
                off = sample_pos(pp, t)
                lp = [b['p'][0], b['p'][1] + off[1], b['p'][2]]
        lq = sample_rot(tracks.get(b['name'], {}).get('rot'), t) or tuple(b['q'])
        wl = [pos[i] + mvec(q2m(rot), lp)[i] for i in range(3)]
        rot = qnorm(qmul(rot, lq))
        pos = wl
    return pos


def calibrate(bones, tracks, dur, idx_of, fps=120):
    """标定 stride(米/秒) 与 cphase(触地相位)。

    做法：先在模型空间（角色原地播放）找出"触地点(脚趾)贴地"的连续区间，
    再取每个区间内触地点的【净后向位移 / 时长】——即支撑脚相对身体的后向速度。
    该值就是动画的原生移动速度：以此速度播放时支撑脚在世界空间零漂移(不打滑)。
    取各区间的中位数，抗噪且与动画内部速度波动无关。
    """
    n = int(dur * fps) + 1
    def traj_of(name):
        if name not in idx_of:
            return None
        chain = bone_chain(bones, idx_of[name])
        return [(min(dur, k / fps), chain_world(bones, chain, tracks, min(dur, k / fps)))
                for k in range(n)]

    combos = [('Bip01 L Toe0', 'Bip01 L Foot'), ('Bip01 R Toe0', 'Bip01 R Foot')]
    strides, cphases, ranges = [], [], []
    for toe_name, foot_name in combos:
        toe = traj_of(toe_name)
        foot = traj_of(foot_name)
        if toe is None or foot is None:
            continue
        cy = [p[1] for _, p in toe]
        thr = min(cy) + max(1.0, (max(cy) - min(cy)) * 0.10)   # 触地窄带(厘米)
        # 收集连续触地区间
        intervals = []
        k0 = None
        for k in range(len(toe)):
            if toe[k][1][1] <= thr:
                if k0 is None:
                    k0 = k
            elif k0 is not None:
                intervals.append((k0, k - 1)); k0 = None
        if k0 is not None:
            intervals.append((k0, len(toe) - 1))
        vals = []
        for a, b in intervals:
            dt = toe[b][0] - toe[a][0]
            if dt < 0.04:
                continue
            # 模型前方为 -Z，触地点向 +Z(身后)移动 = 身体前进速度
            vals.append((toe[b][1][2] - toe[a][1][2]) / dt)
        vals.sort()
        strides.append((vals[len(vals) // 2] * MESH_SCALE) if vals else 0.0)
        kmin = min(range(len(cy)), key=lambda i: cy[i])
        cphases.append(toe[kmin][0] / dur)
        fy = [p[1] for _, p in foot]
        ranges.append((min(fy), max(fy)))
    stride = sum(strides) / max(1, len(strides))
    cphase = cphases[0] if cphases else 0.0
    return stride, cphase, ranges


# ============================ 压缩 ============================
def thin_rot(keys):
    n = len(keys)
    if n <= 2:
        return keys
    keep = [0]
    i = 0
    while i < n - 1:
        j = n - 1
        for k in range(n - 1, i, -1):
            u0, u1 = keys[i][0], keys[k][0]
            ok = True
            for m in range(i + 1, k):
                u = (keys[m][0] - u0) / (u1 - u0) if u1 > u0 else 0
                if quat_angle_deg(nlerp(keys[i][1:], keys[k][1:], u), keys[m][1:]) > ROT_EPS:
                    ok = False
                    break
            if ok:
                j = k
                break
        keep.append(j)
        i = j
    return [keys[k] for k in keep]


def thin_pos(keys):
    n = len(keys)
    if n <= 2:
        return keys
    keep = [0]
    i = 0
    while i < n - 1:
        j = n - 1
        for k in range(n - 1, i, -1):
            u0, u1 = keys[i][0], keys[k][0]
            ok = True
            for m in range(i + 1, k):
                u = (keys[m][0] - u0) / (u1 - u0) if u1 > u0 else 0
                c = nlerp(keys[i][1:], keys[k][1:], u)
                if any(abs(c[q] - keys[m][q + 1]) > POS_EPS for q in range(3)):
                    ok = False
                    break
            if ok:
                j = k
                break
        keep.append(j)
        i = j
    return [keys[k] for k in keep]


# ============================ 烘焙 ============================
def build():
    os.makedirs(OUT, exist_ok=True)
    skeleton = json.load(open(os.path.join(ROOT, 'assets', 'chars', '101.json'), encoding='utf-8'))
    bones = skeleton['bones']
    bone_names = set(b['name'] for b in bones)
    idx_of = {b['name']: i for i, b in enumerate(bones)}
    print('skeleton bones:', len(bone_names))

    manifest = {}
    for aname, (cid, fname, loop) in ANIMS.items():
        tracks = parse_xsm_tracks(os.path.join(SRC, cid, fname))
        dur = max([k[0] for tr in tracks.values() for k in tr.get('rot', [])] +
                  [k[0] for tr in tracks.values() for k in tr.get('pos', [])] or [0])
        out = {'dur': round(dur, 4), 'loop': loop, 'stride': 0.0, 'cphase': 0.0, 'tracks': {}}
        if aname in GAITS:
            stride, cphase, ranges = calibrate(bones, tracks, dur, idx_of)
            ref = VERIFIED_STRIDE.get(aname)
            if ref is not None:
                dev = abs(stride - ref) / ref * 100
                if dev > 10:
                    print('   [warn] FK 估算步幅 %.3f 与实测 %.3f 偏差 %.0f%%，采用实测值'
                          % (stride, ref, dev))
                stride = ref
            out['stride'] = round(stride, 3)
            out['cphase'] = round(cphase, 3)
            print('   [calib] 步幅速度 %.3f m/s  触地相位 %.3f  踝高 %.1f..%.1f cm' % (
                stride, cphase, ranges[0][0], ranges[0][1]))

        used = nkeys = 0
        for bname, tr in tracks.items():
            if bname not in bone_names:
                continue
            o = {}
            if 'rot' in tr:
                r = tr['rot']
                if max(quat_angle_deg(k[1:], r[0][1:]) for k in r) > 0.4:
                    rk = thin_rot(r)
                    if loop and quat_angle_deg(rk[-1][1:], rk[0][1:]) > 0.01:
                        rk = rk[:-1] + [(dur,) + tuple(rk[0][1:])]
                    o['r'] = [[round(k[0], 3)] + [round(v, 4) for v in k[1:]] for k in rk]
                    nkeys += len(rk)
            if 'pos' in tr and bname == 'Bip01':
                pp = tr['pos']
                y0 = pp[0][2]
                cyc = (pp[-1][2] - y0) / dur if (loop and dur > 0) else 0.0
                pp = [(k[0], 0.0, k[2] - y0 - cyc * k[0], 0.0) for k in pp]
                pk = thin_pos(pp)
                o['p'] = [[round(k[0], 3)] + [round(v, 4) for v in k[1:]] for k in pk]
                nkeys += len(pk)
            if o:
                out['tracks'][bname] = o
                used += 1
        with open(os.path.join(OUT, aname + '.json'), 'w', encoding='utf-8') as f:
            json.dump(out, f, separators=(',', ':'))
        kb = os.path.getsize(os.path.join(OUT, aname + '.json')) // 1024
        manifest[aname] = {'dur': out['dur'], 'loop': loop,
                           'stride': out['stride'], 'cphase': out['cphase']}
        print('%-8s %-18s dur=%.2fs stride=%.2f cphase=%.2f tracks=%-3d keys=%-4d %4dKB' % (
            aname, fname, dur, out['stride'], out['cphase'], used, nkeys, kb))
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, separators=(',', ':'))
    print('done ->', OUT)


if __name__ == '__main__':
    build()
