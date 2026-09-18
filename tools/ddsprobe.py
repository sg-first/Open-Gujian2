import struct, os, glob

def probe(p):
    d = open(p, 'rb').read(148)
    if d[:4] != b'DDS ':
        return None
    size, flags, h, w, pitch, depth, mips = struct.unpack_from('<7I', d, 4)
    pf = d[76:76 + 32]
    pfsz, pfflags, fourcc, rgbbitcnt, rmask, gmask, bmask, amask = struct.unpack_from('<8I', pf, 0)
    fc = struct.pack('<I', fourcc).decode('latin1').rstrip('\0')
    return dict(w=w, h=h, mips=mips, fourcc=fc,
                bit=rgbbitcnt, pfflags=hex(pfflags), rmask=hex(rmask), amask=hex(amask))


for base in [r'E:/BaiduNetdiskDownload/Gujian.2/RPGproject/Characters/101',
             r'E:/BaiduNetdiskDownload/Gujian.2/RPGproject/models/Textures']:
    print('==', base)
    for p in sorted(glob.glob(base + '/*.dds'))[:12]:
        print(' ', os.path.basename(p), probe(p))
