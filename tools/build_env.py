# -*- coding: utf-8 -*-
"""从 Maps/<map>/<map>.vscene 抽取原版环境参数 -> assets/env.json

vscene = VBIN 容器，正文内嵌 XML：
  <Zones><Zone><Area Name="<map>" Key="0">
      <Variable Name=".." Type=".." Value=".." />        <- Area 级（全局：太阳角度、天空贴图、水面）
      <KeyFrame Index="0..3"> <Variable .../> </KeyFrame> <- 时段级，4 帧 = 晨(5)/午(9)/暮(15)/夜(20)
  </Area>

颜色 Value 形如 "R/G/B/A"（0-255）。水面参数在 PlanarWater 节点的材质串中。
"""
import os
import re
import sys
import json
import struct

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_world import REGIONS

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
ASSETS = os.path.join(ROOT, 'webapp', 'assets')
HOURS = [5.0, 9.0, 15.0, 20.0]

# Variable 名 -> (分组, 键)
VMAP = {
    'LightAmbient': ('light', 'ambient'), 'LightMultiplier': ('light', 'ambientMul'),
    'LightDiffuse': ('light', 'diffuse'), 'LightMultiplierDif': ('light', 'diffuseMul'),
    'LightSpecular': ('light', 'specular'), 'LightMultiplierSpe': ('light', 'specularMul'),
    'SunColor': ('sun', 'color'), 'SunLum': ('sun', 'lum'), 'SunSize': ('sun', 'size'),
    'MoonLumScale': ('sun', 'moonLum'),
    'ActorAmbient': ('actor', 'ambient'), 'ActorDiffuse': ('actor', 'diffuse'),
    'ActorSpecular': ('actor', 'specular'), 'ActorRimColor': ('actor', 'rimColor'),
    'ActorSpecularPower': ('actor', 'specularPower'), 'ActorRimRange': ('actor', 'rimRange'),
    'FogColor': ('fog', 'color'), 'FogIntensity': ('fog', 'intensity'),
    'FogColorMultiplier': ('fog', 'colorMul'), 'FogDensityOffset': ('fog', 'densityOffset'),
    'FogWaterHeight': ('fog', 'waterHeight'), 'FogAtomsphereHeight': ('fog', 'atmosHeight'),
    'FilterTopColor': ('sky', 'top'), 'FilterMiddleColor': ('sky', 'middle'),
    'FilterBottomColor': ('sky', 'bottom'),
    'SkyLumScale': ('sky', 'lumScale'), 'SkyInscatterScale': ('sky', 'inscatter'),
    'CloudColor': ('cloud', 'color'), 'CloudAlpha': ('cloud', 'alpha'),
    'CloudHeight': ('cloud', 'height'), 'CloudCurve': ('cloud', 'curve'),
    'CloudGranularity': ('cloud', 'granularity'),
    'GodRayColor': ('godray', 'color'), 'GodRayColorFactor': ('godray', 'factor'),
    'RainParticleColor': ('weather', 'rainColor'), 'SnowParticleColor': ('weather', 'snowColor'),
    'SSAOIntensity': ('post', 'ssao'), 'CHDRBloomThreshold': ('post', 'bloomThreshold'),
}
COLOR_KEYS = {'light.ambient', 'light.diffuse', 'light.specular', 'sun.color',
              'actor.ambient', 'actor.diffuse', 'actor.specular', 'actor.rimColor',
              'fog.color', 'sky.top', 'sky.middle', 'sky.bottom', 'cloud.color',
              'godray.color', 'weather.rainColor', 'weather.snowColor'}

VRE = re.compile(r'<Variable\s+Name="([^"]*)"\s+Type="([^"]*)"\s+Value="([^"]*)"\s*/?>')


def color(v):
    p = [float(x) for x in v.split('/')]
    return [round(p[0] / 255.0, 4), round(p[1] / 255.0, 4), round(p[2] / 255.0, 4)]


def num(v):
    try:
        return round(float(v), 5)
    except ValueError:
        return None


def parse_kv(s):
    out = {}
    for part in s.split(';'):
        if '=' not in part:
            continue
        k, val = part.split('=', 1)
        vals = [x.strip() for x in val.split(',')]
        nums = []
        for x in vals:
            try:
                nums.append(round(float(x), 6))
            except ValueError:
                nums.append(x)
        if not nums:
            continue
        out[k.strip()] = nums[0] if len(nums) == 1 else nums
    return out


def fill(body, dst):
    for m in VRE.finditer(body):
        name, ty, val = m.group(1), m.group(2), m.group(3)
        path = VMAP.get(name)
        if not path:
            continue
        grp, key = path
        v = color(val) if (ty == '132' and ('%s.%s' % (grp, key)) in COLOR_KEYS) else (
            num(val) if ty in ('2', '0') else val.strip())
        if v is None:
            continue
        dst.setdefault(grp, {})[key] = v
    return dst


def area_slice(txt, map_name):
    """截取 <Area Name="map_name" ...> ... </Area> 的内部文本"""
    m = re.search(r'<Area\s+Name="%s"[^>]*>' % re.escape(map_name), txt)
    if not m:
        return None
    i = m.end()
    j = txt.find('</Area>', i)
    return txt[i:j if j > 0 else i + 400000]


def parse_vscene(map_name):
    p = os.path.join(ROOT, 'Maps', map_name, '%s.vscene' % map_name)
    if not os.path.exists(p):
        return None
    txt = open(p, 'rb').read().decode('latin1')
    body = area_slice(txt, map_name)
    if body is None:                       # n10_2 这类分区，退回第一个 <Area>
        m = re.search(r'<Area\s+Name="[^"]*"[^>]*>', txt)
        if not m:
            return None
        j = txt.find('</Area>', m.end())
        body = txt[m.end():j if j > 0 else m.end() + 400000]

    # Area 级变量（KeyFrame 之前）
    kfpos = [m.start() for m in re.finditer(r'<KeyFrame\s+Index="\d+">', body)]
    head = body[:kfpos[0]] if kfpos else body
    env = {'global': fill(head, {})}
    env['keyframes'] = []
    for k, st in enumerate(kfpos):
        end = kfpos[k + 1] if k + 1 < len(kfpos) else len(body)
        if len(env['keyframes']) >= 4:
            break
        env['keyframes'].append(fill(body[st:end], {}))

    # 太阳方向：取水面材质的 sunDirection（显式向量，Z-up）
    g = env['global']
    for grp in ('light', 'sky', 'fog'):
        g.setdefault(grp, {})
    for idx, kf in enumerate(env['keyframes']):
        for grp in ('light', 'sun', 'fog', 'sky', 'cloud'):
            kf.setdefault(grp, {})
        kf['hour'] = HOURS[idx] if idx < len(HOURS) else 0.0

    # 水面材质串
    i = txt.find('NormalMap=')
    if i < 0:
        i = txt.find('brightWaterColor')
    water = {}
    if i >= 0:
        j = txt.rfind('\\', 0, i)
        seg = txt[i:i + 2000]
        stop = len(seg)
        for k, ch in enumerate(seg):
            if ord(ch) < 32 or ord(ch) > 126:
                stop = k
                break
        water = parse_kv(seg[:stop])
    env['water'] = water

    # 由 sunDirection 求 Y-up 单位向量（源 Z-up: (x,y,z) -> (x, z, -y)）
    sd = water.get('sunDirection')
    if isinstance(sd, list) and len(sd) == 3:
        x, y, z = sd
        n = (x * x + y * y + z * z) ** 0.5 or 1.0
        env['sunDir'] = [round(x / n, 4), round(z / n, 4), round(-y / n, 4)]

    lp, ly = g.get('light', {}).get('pitch'), None
    return env


def main():
    maps_dir = os.path.join(ROOT, 'Maps')
    allmaps = sorted(d for d in os.listdir(maps_dir) if os.path.isdir(os.path.join(maps_dir, d)))
    out, ok = {}, []
    for m in allmaps:
        e = parse_vscene(m)
        if e and e['keyframes']:
            out[m] = e
            ok.append(m)
    worldMaps = [r[0] for r in REGIONS if r[0] in out]
    data = dict(hours=HOURS, maps=out, worldMaps=worldMaps)
    os.makedirs(ASSETS, exist_ok=True)
    with open(os.path.join(ASSETS, 'env.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    print('env.json: %d maps, %.1f KB' % (len(ok), os.path.getsize(os.path.join(ASSETS, 'env.json')) / 1024))
    print('world maps:', worldMaps)
    for m in worldMaps:
        e = out[m]
        kf = e['keyframes']
        print('  %-7s kf=%d sunDir=%s' % (m, len(kf), e.get('sunDir')))
        for k in kf:
            s, f_, sk = k.get('sun', {}), k.get('fog', {}), k.get('sky', {})
            print('     h=%-5s lum=%-7s diffuse=%-16s fog=%-16s i=%-6s skyTop=%s'
                  % (k.get('hour'), s.get('lum'), k.get('light', {}).get('diffuse'),
                     f_.get('color'), f_.get('intensity'), sk.get('top')))
        w = e['water']
        print('     water: opacity=%s bright=%s dark=%s ext=%s caustics=%s refl=%s'
              % (w.get('waterOpacity'), w.get('brightWaterColor'), w.get('darkWaterColor'),
                 w.get('chromaticExtinction'), w.get('causticsParams'), w.get('reflectionParams')))


if __name__ == '__main__':
    main()
