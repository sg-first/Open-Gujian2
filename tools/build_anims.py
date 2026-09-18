#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build_anims.py —— 把原版 XSM 骨骼动画烘焙成 webapp 可用的 JSON。

源: RPGproject/Characters/101/*.xsm  (EmotionFX skeletal motion)
出: webapp/assets/chars/anims/<name>.json

每帧四元数为"相对父骨骼的局部旋转"(与 XAC 骨架一致)，quat16/32767 归一化。
Bip01(根) 位置轨道保留相对首帧的 y 起伏，x/z 归零(原地循环，位移由游戏逻辑驱动)。
压缩: 贪心抽稀(旋转误差 < 0.35° / 位置误差 < 0.15cm 内的中间帧删除)，
      循环动画 y 起伏线性扣除首尾差保证无缝循环。

动画选型(由骨骼摆幅/时长/根位移分析得出):
  idle   y09    2.67s 待机呼吸
  walk   y01    1.20s 行走循环
  run    y02    0.80s 跑步循环
  sprint fast   0.47s 冲刺循环
  attack j01a   1.33s 剑法·挥砍
  jump   y04a   0.67s 起跳
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

ROT_EPS = 0.35      # 抽稀保留的旋转误差(度)
POS_EPS = 0.15      # 抽稀保留的位置误差(cm，模型为厘米级)


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


# ---------- 插值用工具 ----------
def nlerp(a, b, u):
    return [a[i] * (1 - u) + b[i] * u for i in range(len(a))]


def quat_angle_deg(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    return math.degrees(2 * math.acos(max(-1.0, min(1.0, abs(dot)))))


def thin_rot(keys):
    """keys: [(t, x, y, z, w)] 贪心抽稀，保证任意删除帧与重建插值误差 < ROT_EPS 度。"""
    n = len(keys)
    if n <= 2:
        return keys
    keep = [0]
    i = 0
    while i < n - 1:
        j = n - 1
        # 从最远往回找第一个满足误差约束的 j
        for k in range(n - 1, i, -1):
            u0, u1 = keys[i][0], keys[k][0]
            ok = True
            for m in range(i + 1, k):
                u = (keys[m][0] - u0) / (u1 - u0) if u1 > u0 else 0
                c = nlerp(keys[i][1:], keys[k][1:], u)
                if quat_angle_deg(c, keys[m][1:]) > ROT_EPS:
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


def build():
    os.makedirs(OUT, exist_ok=True)
    skeleton = json.load(open(os.path.join(ROOT, 'assets', 'chars', '101.json'), encoding='utf-8'))
    bone_names = set(b['name'] for b in skeleton['bones'])
    print('skeleton bones:', len(bone_names))

    manifest = {}
    for aname, (cid, fname, loop) in ANIMS.items():
        src = os.path.join(SRC, cid, fname)
        tracks = parse_xsm_tracks(src)
        dur = max([k[0] for tr in tracks.values() for k in tr.get('rot', [])] +
                  [k[0] for tr in tracks.values() for k in tr.get('pos', [])] or [0])
        out = {'dur': round(dur, 4), 'loop': loop, 'tracks': {}}
        used = nkeys = 0
        for bname, tr in tracks.items():
            if bname not in bone_names:
                continue
            o = {}
            if 'rot' in tr:
                r = tr['rot']
                if max(quat_angle_deg(k[1:], r[0][1:]) for k in r) > 0.4:
                    rk = thin_rot(r)
                    # 循环动画：把结尾强制对齐首帧，保证无缝
                    if loop and quat_angle_deg(rk[-1][1:], rk[0][1:]) > 0.01:
                        rk = rk[:-1] + [(dur,) + tuple(rk[0][1:])]
                    o['r'] = [[round(k[0], 3)] + [round(v, 4) for v in k[1:]] for k in rk]
                    nkeys += len(rk)
            if 'pos' in tr and bname == 'Bip01':
                pp = tr['pos']
                y0 = pp[0][2]
                # 循环动画: y 起伏扣除首尾差(线性)，保证 y(0)==y(dur)
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
        manifest[aname] = {'dur': out['dur'], 'loop': loop}
        print('%-8s %-18s dur=%.2fs tracks=%-3d keys=%-4d %4dKB' % (
            aname, fname, dur, used, nkeys, kb))
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, separators=(',', ':'))
    print('done ->', OUT)


if __name__ == '__main__':
    build()
