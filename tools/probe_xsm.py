#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Gujian2 .xsm (EmotionFX Skeletal Motion) parser
格式(逆向 + Project-Alice docs/xac_xtec_xsm.md):
  file:  "XSM " + u8 major + u8 minor + u8 endian + u8 pad
  chunk: int32 type | int32 length | int32 version | data
  chunk 0xC9 v2 (motion info):
    float unused=1.0; float durationOrErr; int32 fps;
    bytes exporterVer[4]; strings: app / origFile / exportDate / motionName
  chunk 0xCA v2 (skeletal motion):
    int32 numSubMotions
    per sub-motion:
      quat16 poseRot, bindPoseRot, poseScaleRot, bindPoseScaleRot   (4 x 4xi16)
      vec3f posePos, poseScale, bindPosePos, bindPoseScale         (4 x 3f)
      int32 numPosKeys, numRotKeys, numScaleKeys, numScaleRotKeys
      float fMaxError
      string nodeName (u32 len + chars)
      PosKey[numPosKeys]     { vec3f pos;  float t }
      RotKey[numRotKeys]     { quat16 rot; float t }
      ScaleKey[numScaleKeys] { vec3f; float t }
      ScaleRotKey[...]       { quat16; float t }
    quat16 分量 / 32767 得到四元数分量。
用法: python probe_xsm.py <file.xsm>
"""
import struct, sys, json


def rd_str(d, o):
    n = struct.unpack_from('<I', d, o)[0]
    s = d[o + 4:o + 4 + n].decode('utf-8', 'replace')
    return s, o + 4 + n


def parse_xsm(path):
    d = open(path, 'rb').read()
    if d[:4] != b'XSM ':
        raise ValueError('not XSM')
    res = {'submotions': []}
    o = 8
    while o + 12 <= len(d):
        t, ln, ver = struct.unpack_from('<iii', d, o)
        o += 12
        if t == 0xC9:
            f0, f1 = struct.unpack_from('<ff', d, o)
            fps = struct.unpack_from('<i', d, o + 8)[0]
            res['meta'] = {'f0': f0, 'f1': f1, 'fps': fps}
            # strings follow; skip them structurally
            p = o + 8 + 4 + 4
            try:
                for _ in range(4):
                    s, p = rd_str(d, p)
            except Exception:
                pass
        elif t == 0xCA:
            p = o
            n = struct.unpack_from('<i', d, p)[0]
            res['numSubMotions'] = n
            p += 4
            for i in range(n):
                # 4 x quat16 = 32 bytes
                p += 32
                # 4 x vec3 = 48 bytes
                pose = struct.unpack_from('<3f', d, p)
                p += 12
                bind = struct.unpack_from('<3f', d, p)
                p += 36
                np_, nr_, ns_, nsr_ = struct.unpack_from('<4i', d, p)
                p += 16
                fmax = struct.unpack_from('<f', d, p)[0]
                p += 4
                name, p = rd_str(d, p)
                pos = []
                for _ in range(np_):
                    v = struct.unpack_from('<3f', d, p)
                    tt = struct.unpack_from('<f', d, p + 12)[0]
                    pos.append((v, tt))
                    p += 16
                rot = []
                for _ in range(nr_):
                    q = struct.unpack_from('<4h', d, p)
                    tt = struct.unpack_from('<f', d, p + 8)[0]
                    rot.append((q, tt))
                    p += 12
                for _ in range(ns_):
                    p += 16
                for _ in range(nsr_):
                    p += 12
                res['submotions'].append(dict(
                    name=name, npos=np_, nrot=nr_, nscl=ns_, nsr=nsr_,
                    pose=pose, fmax=fmax, pos=pos, rot=rot))
            res['dataEnd'] = p
            res['fileEnd'] = len(d)
        o += ln
    return res


if __name__ == '__main__':
    for path in sys.argv[1:]:
        r = parse_xsm(path)
        sm = r['submotions']
        animated = [s for s in sm if s['nrot'] or s['npos']]
        maxT = max([k[1] for s in animated for k in s['rot']] or [0])
        # 根位移范围
        pelvis = next((s for s in sm if 'Pelvis' in s['name']), None)
        pinfo = ''
        if pelvis and pelvis['pos']:
            xs = [k[0][0] for k in pelvis['pos']]
            zs = [k[0][2] for k in pelvis['pos']]
            pinfo = ' pelvisPos x[%.2f..%.2f] z[%.2f..%.2f]' % (
                min(xs), max(xs), min(zs), max(zs))
        print('== %s: nsub=%d animated=%d maxKeyT=%.3f%s' % (
            path.split('/')[-1].split('\\')[-1], len(sm), len(animated), maxT, pinfo))
        for s in animated[:8]:
            print('    %-22s rot=%-4d pos=%-3d' % (s['name'], s['nrot'], s['npos']))
