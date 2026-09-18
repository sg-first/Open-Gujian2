# -*- coding: utf-8 -*-
"""纯 stdlib 的 DDS(DXT1/3/5/未压缩) 解码 + PNG 编码。无第三方依赖。"""
import os
import struct
import zlib

DDS_MAGIC = b'DDS '


class DDS:
    def __init__(self, path):
        self.path = path
        d = open(path, 'rb').read()
        if d[:4] != DDS_MAGIC:
            raise ValueError('not a dds: %s' % path)
        (self.hdrSize, self.flags, self.height, self.width,
         self.pitch, self.depth, self.mipCount) = struct.unpack_from('<7I', d, 4)
        off = 76
        (pfsz, pfflags, fourcc, self.bitCount,
         self.rmask, self.gmask, self.bmask, self.amask) = struct.unpack_from('<8I', d, off)
        self.fourcc = struct.pack('<I', fourcc).decode('latin1').rstrip('\0')
        self.caps = struct.unpack_from('<I', d, 108)[0]
        self.dataOff = 4 + self.hdrSize
        # DX10 扩展头
        if self.fourcc == 'DX10':
            (self.dxgiFmt, self.dim, self.misc, self.arraySz, self.misc2) = \
                struct.unpack_from('<5I', d, self.dataOff)
            self.dataOff += 20
        if self.mipCount == 0:
            self.mipCount = 1
        self.data = d
        self.levels = self._levels()

    def _levels(self):
        """返回 [(offset, size, w, h), ...]"""
        w, h, off, out = self.width, self.height, self.dataOff, []
        bs = 16 if self.fourcc in ('DXT1',) else 16
        for i in range(self.mipCount):
            if self.fourcc in ('DXT1', 'DXT2', 'DXT3', 'DXT4', 'DXT5'):
                sz = max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * (8 if self.fourcc == 'DXT1' else 16)
            else:
                bpp = self.bitCount // 8
                sz = w * h * bpp
            out.append((off, sz, w, h))
            off += sz
            w = max(1, w >> 1)
            h = max(1, h >> 1)
        return out

    def pick_level(self, max_size):
        """选一个宽高都 <= max_size 的最大 mip 层索引"""
        for i, (o, s, w, h) in enumerate(self.levels):
            if w <= max_size and h <= max_size:
                return i
        return 0

    def decode(self, level=0, flip_y=False):
        o, s, w, h = self.levels[level]
        blk = self.data[o:o + s]
        if self.fourcc == 'DXT1':
            px = _dxt1(blk, w, h)
        elif self.fourcc == 'DXT3':
            px = _dxt3(blk, w, h)
        elif self.fourcc == 'DXT5':
            px = _dxt5(blk, w, h)
        elif self.bitCount in (24, 32):
            px = _raw(blk, w, h, self.bitCount // 8, self.rmask, self.gmask, self.bmask, self.amask)
        else:
            raise ValueError('unsupported dds fmt %s %dbpp' % (self.fourcc, self.bitCount))
        if flip_y:
            px = _flip(px, w, h)
        return w, h, px


# ---------- block decoders ----------

def _c565(c):
    r = (c >> 11) & 31
    g = (c >> 5) & 63
    b = c & 31
    return (r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)


def _dxt1(blk, w, h):
    bw, bh = (w + 3) // 4, (h + 3) // 4
    out = bytearray(w * h * 4)
    p = 0
    for by in range(bh):
        for bx in range(bw):
            c0, c1 = struct.unpack_from('<HH', blk, p)
            bits = struct.unpack_from('<I', blk, p + 4)[0]
            p += 8
            r0, g0, b0 = _c565(c0)
            r1, g1, b1 = _c565(c1)
            pal = [(r0, g0, b0, 255), (r1, g1, b1, 255)]
            if c0 > c1:
                pal.append(((2 * r0 + r1) // 3, (2 * g0 + g1) // 3, (2 * b0 + b1) // 3, 255))
                pal.append(((r0 + 2 * r1) // 3, (g0 + 2 * g1) // 3, (b0 + 2 * b1) // 3, 255))
            else:
                pal.append(((r0 + r1) // 2, (g0 + g1) // 2, (b0 + b1) // 2, 255))
                pal.append((0, 0, 0, 0))
            for y in range(4):
                yy = by * 4 + y
                if yy >= h:
                    p += 0
                    continue
                for x in range(4):
                    xx = bx * 4 + x
                    if xx >= w:
                        continue
                    i = (bits >> (2 * (y * 4 + x))) & 3
                    r, g, b, a = pal[i]
                    o = (yy * w + xx) * 4
                    out[o:o + 4] = bytes((r, g, b, a))
    return bytes(out)


def _alpha_tbl(a0, a1):
    t = [a0, a1]
    if a0 > a1:
        for i in range(1, 7):
            t.append(((7 - i) * a0 + i * a1) // 7)
    else:
        for i in range(1, 5):
            t.append(((5 - i) * a0 + i * a1) // 5)
        t.append(0)
        t.append(255)
    return t


def _dxt3(blk, w, h):
    bw, bh = (w + 3) // 4, (h + 3) // 4
    out = bytearray(w * h * 4)
    p = 0
    for by in range(bh):
        for bx in range(bw):
            ab = blk[p:p + 8]
            p += 8
            c0, c1 = struct.unpack_from('<HH', blk, p)
            bits = struct.unpack_from('<I', blk, p + 4)[0]
            p += 8
            r0, g0, b0 = _c565(c0)
            r1, g1, b1 = _c565(c1)
            pal = [(r0, g0, b0), (r1, g1, b1),
                   ((2 * r0 + r1) // 3, (2 * g0 + g1) // 3, (2 * b0 + b1) // 3),
                   ((r0 + 2 * r1) // 3, (g0 + 2 * g1) // 3, (b0 + 2 * b1) // 3)]
            for y in range(4):
                yy = by * 4 + y
                if yy >= h:
                    continue
                for x in range(4):
                    xx = bx * 4 + x
                    if xx >= w:
                        continue
                    i = (bits >> (2 * (y * 4 + x))) & 3
                    r, g, b = pal[i]
                    a = (ab[y] >> (4 * x)) & 15
                    a = a * 17
                    o = (yy * w + xx) * 4
                    out[o:o + 4] = bytes((r, g, b, a))
    return bytes(out)


def _dxt5(blk, w, h):
    bw, bh = (w + 3) // 4, (h + 3) // 4
    out = bytearray(w * h * 4)
    p = 0
    for by in range(bh):
        for bx in range(bw):
            a0, a1 = blk[p], blk[p + 1]
            abits = int.from_bytes(blk[p + 2:p + 8], 'little')
            p += 8
            at = _alpha_tbl(a0, a1)
            c0, c1 = struct.unpack_from('<HH', blk, p)
            bits = struct.unpack_from('<I', blk, p + 4)[0]
            p += 8
            r0, g0, b0 = _c565(c0)
            r1, g1, b1 = _c565(c1)
            pal = [(r0, g0, b0), (r1, g1, b1),
                   ((2 * r0 + r1) // 3, (2 * g0 + g1) // 3, (2 * b0 + b1) // 3),
                   ((r0 + 2 * r1) // 3, (g0 + 2 * g1) // 3, (b0 + 2 * b1) // 3)]
            for y in range(4):
                yy = by * 4 + y
                if yy >= h:
                    continue
                ar = abits >> (3 * (y * 4)) & 0xFFFFFFFF
                rowa = (abits >> (12 * y)) & 0xFFF
                for x in range(4):
                    xx = bx * 4 + x
                    if xx >= w:
                        continue
                    i = (bits >> (2 * (y * 4 + x))) & 3
                    r, g, b = pal[i]
                    a = at[(rowa >> (3 * x)) & 7]
                    o = (yy * w + xx) * 4
                    out[o:o + 4] = bytes((r, g, b, a))
    return bytes(out)


def _raw(blk, w, h, bpp, rm, gm, bm, am):
    out = bytearray(w * h * 4)
    def sh(m):
        if m == 0:
            return 0, 0
        s = 0
        while not (m >> s) & 1:
            s += 1
        n = 0
        while (m >> (s + n)) & 1:
            n += 1
        return s, n
    rs, rn = sh(rm)
    gs, gn = sh(gm)
    bs, bn = sh(bm)
    as_, an = sh(am)
    for i in range(w * h):
        o = i * bpp
        v = int.from_bytes(blk[o:o + bpp], 'little')
        def ext(s, n):
            if n == 0:
                return 0
            val = (v >> s) & ((1 << n) - 1)
            if n >= 8:
                return val & 255
            return (val * 255) // ((1 << n) - 1)
        out[i * 4:i * 4 + 4] = bytes((ext(rs, rn), ext(gs, gn), ext(bs, bn),
                                      ext(as_, an) if am else 255))
    return bytes(out)


def _flip(px, w, h):
    stride = w * 4
    out = bytearray(len(px))
    for y in range(h):
        out[y * stride:(y + 1) * stride] = px[(h - 1 - y) * stride:(h - y) * stride]
    return bytes(out)


# ---------- PNG ----------

def write_png(path, w, h, rgba):
    raw = bytearray()
    stride = w * 4
    prev = bytes(stride)
    for y in range(h):
        line = rgba[y * stride:(y + 1) * stride]
        raw.append(4)          # filter type 4 = Paeth（下面用的就是 Paeth）
        filt = bytearray(stride)
        for i in range(stride):
            a = line[i - 4] if i >= 4 else 0
            b = prev[i]
            c = prev[i - 4] if i >= 4 else 0
            pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
            pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
            filt[i] = (line[i] - pr) & 0xFF
        raw += filt
        prev = line
    comp = zlib.compress(bytes(raw), 6)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', comp)
    png += chunk(b'IEND', b'')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'wb').write(png)
    return path


def dds_to_png(src, dst, max_size=1024):
    im = DDS(src)
    lv = im.pick_level(max_size)
    w, h, px = im.decode(lv)
    write_png(dst, w, h, px)
    return w, h


if __name__ == '__main__':
    import sys
    a, b = sys.argv[1], sys.argv[2]
    print(dds_to_png(a, b))
