# -*- coding: utf-8 -*-
"""从 zpkg 里直接"雕刻" DDS：DDS 头部自带宽高/格式/mip 数，整文件长度可精确算出。

用法:  python carve_dds.py <zpkg> [--dirs] [--max MB] [--out 目录] [--test 前N个]
不带 --out 时只做统计（不落盘）。
"""
import os
import re
import sys
import struct
import argparse

MAGIC = b'DDS '


def dds_total_size(d, off):
    """返回 (total_bytes, width, height, fourcc) 或 None"""
    if d[off:off + 4] != MAGIC:
        return None
    if off + 128 > len(d):
        return None
    (hdrSize, flags, height, width, pitch, depth, mipCount) = struct.unpack_from('<7I', d, off + 4)
    if hdrSize != 124 or not (0 < width <= 16384) or not (0 < height <= 16384):
        return None
    fourcc_i = struct.unpack_from('<I', d, off + 84)[0]
    fourcc = struct.pack('<I', fourcc_i).decode('latin1').rstrip('\0')
    flags_pf = struct.unpack_from('<I', d, off + 80)[0]
    bitCount = struct.unpack_from('<I', d, off + 88)[0]
    dataOff = 128
    if fourcc == 'DX10':
        dataOff += 20
    if mipCount == 0 or mipCount > 20:
        mipCount = 1
    total = 0
    w, h = width, height
    for _ in range(mipCount):
        if fourcc in ('DXT1', 'DXT2', 'DXT3', 'DXT4', 'DXT5'):
            total += max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * (8 if fourcc == 'DXT1' else 16)
        elif bitCount in (24, 32):
            total += w * h * (bitCount // 8)
        elif bitCount == 8:
            total += w * h
        else:
            return None
        w = max(1, w >> 1)
        h = max(1, h >> 1)
    if not (128 < total < 64 * 1024 * 1024):
        return None
    if off + dataOff + total > len(d):
        return None
    return (dataOff + total, width, height, fourcc, bitCount)


def walk_names(d, off, span=220):
    """在 DDS 头部附近找可打印路径串（zpkg 常在条目里带原始文件名）"""
    seg = d[max(0, off - span):off + span]
    return [t.decode('latin1') for t in re.findall(rb'[\x20-\x7e]{5,120}', seg)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('zpkg')
    ap.add_argument('--out', default='')
    ap.add_argument('--maxmb', type=int, default=64)
    ap.add_argument('--test', type=int, default=0, help='只处理前 N 个')
    ap.add_argument('--filter', default='', help='只导出名字里含该子串的（用附近可打印串判断）')
    a = ap.parse_args()

    d = open(a.zpkg, 'rb').read()
    print('%s  %.1f MB' % (os.path.basename(a.zpkg), len(d) / 1048576))
    hits = []
    pos = 0
    while True:
        i = d.find(MAGIC, pos)
        if i < 0:
            break
        pos = i + 4
        info = dds_total_size(d, i)
        if info:
            hits.append((i, info))
    print('carved candidates: %d' % len(hits))
    if not hits:
        # 判断是否被压缩：看头 64 字节
        print('head:', d[:64].hex())
        return
    import collections
    cnt = collections.Counter((h[1][3], h[1][1], h[1][2]) for h in hits)
    print('top (fourcc,w,h):', cnt.most_common(12))
    tot = sum(h[1][0] for h in hits)
    print('carved total %.1f MB / archive %.1f MB' % (tot / 1048576, len(d) / 1048576))

    if a.test:
        for i, info in hits[:a.test]:
            names = walk_names(d, i)
            print('  off=%d size=%d %dx%d %s bpp=%d  ctx=%s'
                  % (i, info[0], info[1], info[2], info[3], info[4], names[:3]))

    if a.out:
        os.makedirs(a.out, exist_ok=True)
        n = 0
        for i, info in hits:
            size, w, h, fourcc, bpp = info
            names = walk_names(d, i)
            label = ''
            if a.filter:
                joined = ' '.join(names).lower()
                if a.filter.lower() not in joined:
                    continue
                label = re.sub(r'[^0-9A-Za-z_.]+', '_', names[0])[:60] if names else ''
            fn = 'carve_%08x%s.dds' % (i, ('_' + label) if label else '')
            open(os.path.join(a.out, fn), 'wb').write(d[i:i + size])
            n += 1
            if n % 200 == 0:
                print('  ...%d' % n)
        print('written %d' % n)


if __name__ == '__main__':
    main()
