# -*- coding: utf-8 -*-
"""联合拟合：顶点区(连续有效 pos+nrm) + 紧随其后的 u16 索引区(max==nvert-1)。"""
import struct
import sys

path = sys.argv[1] if len(sys.argv) > 1 else r'E:/BaiduNetdiskDownload/Gujian.2/RPGproject/models/bridge/bridge_015.vmesh'
d = open(path, 'rb').read()


def blocks(d):
    off = 12
    while off + 12 <= len(d):
        tag = d[off:off + 4]
        size = struct.unpack_from('<I', d, off + 4)[0]
        flag = struct.unpack_from('<I', d, off + 8)[0]
        yield tag, flag, d[off + 12:off + 12 + size], off
        off += 20 + size


B = {}
for t, f, p, o in blocks(d):
    B.setdefault(t, []).append((f, p, o))

p = B[b'HSMV'][0][1]
m = B[b'MBUS'][0][1]
bmin = struct.unpack_from('<3f', m, 44)
bmax = struct.unpack_from('<3f', m, 56)
N = len(p)
pad = 1.0
lo = [v - pad for v in bmin]
hi = [v + pad for v in bmax]
print('bbox', ['%.1f' % v for v in bmin], '->', ['%.1f' % v for v in bmax], 'payload', N)


def valid_at(o):
    x, y, z, nx, ny, nz = struct.unpack_from('<6f', p, o)
    if not (lo[0] <= x <= hi[0] and lo[1] <= y <= hi[1] and lo[2] <= z <= hi[2]):
        return False
    L = nx * nx + ny * ny + nz * nz
    return 0.85 < L < 1.15


res = []
for S in range(24, 72, 4):
    for st in range(0x40, min(0x400, N - 24), 4):
        if not valid_at(st):
            continue
        K = 0
        o = st
        while o + 24 <= N and valid_at(o):
            K += 1
            o += S
        if K < 20:
            continue
        vEnd = st + K * S
        # 索引区：vEnd 附近（允许 0..32 字节对齐填充）
        for io in range(vEnd, min(vEnd + 48, N - 6)):
            nmax = (N - io) // 2
            vals = struct.unpack_from('<%dH' % min(nmax, 100000), p, io)
            # 找一处：连续三角形索引都 < K，且最大值 == K-1
            mx = max(vals[:min(len(vals), 3000)])
            if mx != K - 1:
                continue
            # 统计连续满足 <K 的长度
            run = 0
            for v in vals:
                if v < K:
                    run += 1
                else:
                    break
            if run % 3 == 0 and run >= 30:
                res.append((K, run, st, S, io))
                break
res.sort(reverse=True)
for r in res[:6]:
    print('  nverts=%d nidx=%d vstart=0x%X stride=%d idxoff=0x%X' % r)
if res:
    K, run, st, S, io = res[0]
    for i in range(2):
        print('   vert[%d] %s' % (i, ' '.join('%.4f' % v for v in struct.unpack_from('<%df' % (S // 4), p, st + i * S))))
    print('   idx', struct.unpack_from('<12H', p, io))
