#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Gujian2 (Vision Engine / EmotionFX) .rawXAC parser
XAC = EmotionFX Actor: skeleton hierarchy + skinned meshes + materials.

Format reference (chunked, little endian):
  file: "XAC " + u8 major + u8 minor + u8 bigEndian + u8 multiplyOrder
  chunk: int32 chunkType | int32 length | int32 version | data[length]
"""
import struct, sys, os, json

# ---------------- binary reader ----------------
class R:
    def __init__(self, d, off=0):
        self.d = d; self.o = off
    def u8(self):
        v = self.d[self.o]; self.o += 1; return v
    def i16(self):
        v = struct.unpack_from('<h', self.d, self.o)[0]; self.o += 2; return v
    def i32(self):
        v = struct.unpack_from('<i', self.d, self.o)[0]; self.o += 4; return v
    def u32(self):
        v = struct.unpack_from('<I', self.d, self.o)[0]; self.o += 4; return v
    def f32(self):
        v = struct.unpack_from('<f', self.d, self.o)[0]; self.o += 4; return v
    def vec3(self):
        v = struct.unpack_from('<3f', self.d, self.o); self.o += 12; return v
    def vec4(self):
        v = struct.unpack_from('<4f', self.d, self.o); self.o += 16; return v
    def mat44(self):
        v = struct.unpack_from('<16f', self.d, self.o); self.o += 64; return v
    def s(self):
        n = self.u32()
        v = self.d[self.o:self.o + n]
        self.o += n
        return v.decode('utf-8', 'replace')
    def raw(self, n):
        v = self.d[self.o:self.o + n]; self.o += n; return v
    def skip(self, n):
        self.o += n


def chunks(d):
    out = []
    off = 8
    n = len(d)
    while off + 12 <= n:
        t = struct.unpack_from('<i', d, off)[0]
        ln = struct.unpack_from('<i', d, off + 4)[0]
        ver = struct.unpack_from('<i', d, off + 8)[0]
        if ln < 0 or off + 12 + ln > n + 64:
            break
        out.append({'type': t, 'len': ln, 'ver': ver, 'off': off + 12})
        off += 12 + ln
    return out


# ---------------- node hierarchy (chunk 0xB) ----------------
def parse_nodes(d, off):
    r = R(d, off)
    num = r.i32()
    roots = r.i32()
    nodes = []
    for i in range(num):
        rot = r.vec4()            # quat
        srot = r.vec4()           # quat scaleRotation
        pos = r.vec3()
        scale = r.vec3()
        r.skip(12)                # float unused[3]
        r.skip(4)                 # int32 -1
        r.skip(4)                 # int32 -1
        parent = r.i32()
        nchild = r.i32()
        inbounds = r.i32()
        m = r.mat44()             # transform
        imp = r.f32()
        name = r.s()
        nodes.append(dict(i=i, name=name, parent=parent, pos=pos, rot=rot,
                          srot=srot, scale=scale, m=m, imp=imp))
    return nodes, roots


# ---------------- materials (chunk 3) ----------------
# NOTE: chunk "length" for materials does NOT cover the Layer[] array
# (the exporter writes it wrong). We therefore parse structurally and
# return the real end offset.
def _try_layers(d, off, nlay, nfloats):
    r = R(d, off)
    layers = []
    for _ in range(nlay):
        fs = [r.f32() for _ in range(nfloats)]
        mid = r.i16(); mtype = r.u8(); r.u8()
        try:
            tex = r.s()
        except Exception:
            return None
        if not tex or len(tex) > 96 or any(ord(c) < 32 or ord(c) > 126 for c in tex):
            return None
        if mtype > 16 or mid < -1 or mid > 64:
            return None
        layers.append(dict(amount=fs[0], uv=fs[1:], mapType=mtype,
                           matId=mid, tex=tex))
    return layers, r.o


def parse_material(d, off):
    r = R(d, off)
    amb = r.vec4(); diff = r.vec4(); spec = r.vec4(); emis = r.vec4()
    shine = r.f32(); shineStr = r.f32(); opacity = r.f32(); ior = r.f32()
    extra = r.f32()
    dbl = r.u8(); wire = r.u8(); pad = r.u8(); nlay = r.u8()
    name = r.s()
    best = None
    for nf in (6, 5, 4, 7):
        got = _try_layers(d, r.o, nlay, nf)
        if got:
            best = (nf, got)
            break
    if best is None:
        return dict(name=name, diffuse=diff, nlay=nlay, layers=[]), r.o
    nf, (layers, end) = best
    return dict(name=name, diffuse=diff, specular=spec, opacity=opacity,
                nlay=nlay, layers=layers), end


# ---------------- mesh (chunk 1) ----------------
ATTR_KIND = {0: 'pos', 1: 'nrm', 2: 'tan', 3: 'uv', 4: 'col32', 5: 'infl', 6: 'col128'}


def parse_mesh(d, off, ver=1):
    """v1: nodeId,numInflRanges,numVerts,numIdx,numSubs,numLayers,coll+pad
       v2: nodeId,numInflRanges,numOrgVerts,numVerts,numIdx,numSubs,numLayers,+4"""
    r = R(d, off)
    nodeId = r.i32()
    numInflRanges = r.i32()
    if ver >= 2:
        numOrgVerts = r.i32()
    else:
        numOrgVerts = None
    numVerts = r.i32()
    numIdx = r.i32()
    numSubs = r.i32()
    numLayers = r.i32()
    r.skip(4)                      # v1: coll+pad ; v2: float (~3.53)
    if numOrgVerts is None:
        numOrgVerts = numVerts
    if not (0 < numVerts < 4_000_000 and 0 <= numIdx < 8_000_000
            and 0 <= numSubs < 4096 and 0 <= numLayers <= 32):
        raise ValueError('bad mesh header %s' % ((nodeId, numVerts, numIdx, numSubs, numLayers),))
    attribs = []
    for _ in range(numLayers):
        t = r.i32(); size = r.i32()
        keep = r.u8(); scaleFactor = r.u8(); r.skip(2)
        if not (0 <= t <= 16 and 0 < size <= 64):
            raise ValueError('bad attrib %d/%d' % (t, size))
        data = r.raw(numVerts * size)
        attribs.append(dict(type=t, size=size, data=data))
    # NOTE: submeshes are stored INTERLEAVED: header, indices, boneIds, next...
    subs = []
    for _ in range(numSubs):
        ni = r.i32(); nv = r.i32(); mat = r.i32(); nb = r.i32()
        b = r.raw(ni * 4)
        idx = list(struct.unpack('<%di' % ni, b)) if ni else []
        b = r.raw(nb * 4)
        bones = list(struct.unpack('<%di' % nb, b)) if nb else []
        subs.append(dict(numIdx=ni, numVerts=nv, mat=mat, numBones=nb,
                         idx=idx, bones=bones))
    # sanity: indices must address the vertex buffer
    mx = 0
    for s in subs:
        if s['idx']:
            mx = max(mx, max(s['idx']))
    return dict(nodeId=nodeId, numInflRanges=numInflRanges, numOrgVerts=numOrgVerts,
                numVerts=numVerts, numIdx=numIdx, maxIdx=mx,
                attribs=attribs, subs=subs)


# ---------------- skinning (chunk 2) ----------------
# v4 header is 20 bytes: nodeId, ?, numLocalBones, numInfluences, const
def parse_skin(d, off, numRanges=0):
    r = R(d, off)
    nodeId = r.i32()
    r.i32()
    numLocalBones = r.i32()
    numInfluences = r.i32()
    r.skip(4)
    infl = []
    for _ in range(numInfluences):
        w = r.f32(); b = r.i16(); r.skip(2)
        infl.append((b, w))
    ranges = []
    for _ in range(numRanges):
        a = r.i32(); b = r.i32()
        ranges.append((a, b))
    return dict(nodeId=nodeId, numLocalBones=numLocalBones, infl=infl, ranges=ranges)


KNOWN = {1, 2, 3, 7, 0xB, 0xC, 0xD}


def resync(d, off):
    """material chunk lengths are unreliable -> scan forward for next header"""
    n = len(d)
    end = min(off + 8192, n - 12)
    for k in range(off, end):
        t = struct.unpack_from('<i', d, k)[0]
        if t not in KNOWN:
            continue
        ln = struct.unpack_from('<i', d, k + 4)[0]
        ver = struct.unpack_from('<i', d, k + 8)[0]
        if not (0 <= ln < n) or not (0 <= ver <= 16):
            continue
        return k
    return None


def parse_xac(path, want_summary=True):
    d = open(path, 'rb').read()
    if d[:4] != b'XAC ':
        raise ValueError('not XAC: %s' % path)
    res = dict(nodes=[], roots=0, mats=[], meshes=[], skins=[], metas=[],
               chunkTypes=[])
    off = 8
    guard = 0
    while off + 12 <= len(d) and guard < 400:
        guard += 1
        t = struct.unpack_from('<i', d, off)[0]
        ln = struct.unpack_from('<i', d, off + 4)[0]
        ver = struct.unpack_from('<i', d, off + 8)[0]
        if t not in KNOWN or not (0 <= ln < len(d)):
            nk = resync(d, off + 1)
            if nk is None:
                break
            off = nk
            continue
        data = off + 12
        res['chunkTypes'].append('%s(v%d)' % (hex(t), ver))
        nxt = None
        if t == 7:
            res['metas'].append(dict(off=data, len=ln, ver=ver))
        elif t == 0xB:
            res['nodes'], res['roots'] = parse_nodes(d, data)
            nxt = data + ln
        elif t == 3:
            m, nxt = parse_material(d, data)
            res['mats'].append(m)
        elif t == 1:
            try:
                res['meshes'].append(parse_mesh(d, data, ver))
            except Exception as e:
                res['meshes'].append(dict(error=str(e), off=data))
        elif t == 2:
            nodeId = struct.unpack_from('<i', d, data)[0]
            nr = 0
            for m in res['meshes']:
                if isinstance(m, dict) and m.get('nodeId') == nodeId:
                    nr = m['numOrgVerts']
            try:
                res['skins'].append(parse_skin(d, data, nr))
            except Exception as e:
                res['skins'].append(dict(error=str(e)))
        off = nxt if nxt else off + 12 + ln
    return res


if __name__ == '__main__':
    p = sys.argv[1]
    x = parse_xac(p)
    print('chunk types:', x['chunkTypes'])
    print('nodes:', len(x['nodes']), 'roots:', x['roots'])
    for n in x['nodes'][:14]:
        print('  %3d parent=%-4s %-24s pos=%s' % (n['i'], n['parent'], n['name'],
              tuple(round(v, 3) for v in n['pos'])))
    print('materials:', len(x['mats']))
    for m in x['mats']:
        print('  ', m.get('name'), '->', [(l['mapType'], l['tex']) for l in m.get('layers', [])])
        for l in m.get('layers', []):
            print('        mapType=%d matId=%d amount=%.2f tex=%s' % (l['mapType'], l['matId'], l['amount'], l['tex']))
    print('meshes:', len(x['meshes']))
    for m in x['meshes']:
        if 'error' in m:
            print('  ERR', m); continue
        print('  node=%d verts=%d(org %d) idx=%d maxIdx=%d subs=%d layers=%s sizes=%s' % (
            m['nodeId'], m['numVerts'], m['numOrgVerts'], m['numIdx'], m['maxIdx'], len(m['subs']),
            [ATTR_KIND.get(a['type'], a['type']) for a in m['attribs']],
            [a['size'] for a in m['attribs']]))
        for s in m['subs']:
            print('     sub idx=%d verts=%d mat=%d bones=%d' % (s['numIdx'], s['numVerts'], s['mat'], s['numBones']))
    print('skins:', len(x['skins']))
    for s in x['skins']:
        if 'error' in s:
            print('  ERR', s); continue
        print('  node=%d infl=%d ranges=%d' % (s['nodeId'], len(s['infl']), len(s['ranges'])))
