// env.js —— 原版环境参数（由 tools/build_env.py 从 Maps/<map>/<map>.vscene 抽出）
//   keyframes: 4 帧 = 晨(5) / 午(9) / 暮(15) / 夜(20)，含 vscene 里那套
//              LightAmbient / LightDiffuse / SunLum / FogColor / Filter*Color / Cloud*
//   water:     PlanarWater 节点材质串（brightWaterColor / chromaticExtinction / ...）
import * as THREE from 'three';

const DEFAULT_KEYS = {
  light: { ambient: [0.30, 0.36, 0.45], diffuse: [0.70, 0.68, 0.60], specular: [0.70, 0.74, 0.80] },
  sun: { color: [1, 0.95, 0.85], lum: 2.0 },
  fog: { color: [0.35, 0.45, 0.60], intensity: 0.3, colorMul: 1.0 },
  sky: { top: [0.30, 0.50, 0.90], middle: [0.55, 0.72, 0.88], bottom: [0.72, 0.80, 0.86] },
  cloud: { color: [1, 1, 1], alpha: 0.5, height: 5, curve: 0.2 },
};

function lerpArr(a, b, t) {
  if (!a) return b;
  if (!b) return a;
  const o = new Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] + (b[i] - a[i]) * t;
  return o;
}

function lerpKF(a, b, t) {
  const out = { hour: 0 };
  for (const grp of ['light', 'sun', 'fog', 'sky', 'cloud']) {
    const A = a[grp] || {};

    const B = b[grp] || {};
    out[grp] = {};
    const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
    for (const k of keys) {
      const va = A[k] !== undefined ? A[k] : B[k];
      const vb = B[k] !== undefined ? B[k] : A[k];
      if (typeof va === 'number' && typeof vb === 'number') out[grp][k] = va + (vb - va) * t;
      else if (Array.isArray(va) && Array.isArray(vb)) out[grp][k] = lerpArr(va, vb, t);
      else out[grp][k] = vb;
    }
  }
  return out;
}

/** 按 hour 在 4 个关键帧之间插值（首尾环绕） */
export function sampleKeyframes(kfs, hour) {
  if (!kfs || !kfs.length) return null;
  if (kfs.length === 1) return kfs[0];
  const hs = kfs.map((k) => k.hour);
  // 环绕段：最后一帧 -> 次日第一帧
  const wrapSpan = 24 - hs[hs.length - 1] + hs[0];
  let h = hour;
  if (h < hs[0]) h += 24;
  if (h >= hs[hs.length - 1]) {
    const t = ((h - hs[hs.length - 1]) % wrapSpan) / wrapSpan;
    return lerpKF(kfs[kfs.length - 1], kfs[0], t);
  }
  for (let i = 0; i < hs.length - 1; i++) {
    if (h >= hs[i] && h <= hs[i + 1]) {
      const t = (h - hs[i]) / (hs[i + 1] - hs[i]);
      return lerpKF(kfs[i], kfs[i + 1], t);
    }
  }
  return kfs[0];
}

export async function loadEnv() {
  const data = await (await fetch('./assets/env.json')).json();
  return new Env(data);
}

export class Env {
  constructor(data) {
    this.data = data;
    this.maps = data.maps || {};
    this.worldMaps = data.worldMaps || [];
    // 世界兜底：所有世界地图的平均（区域外/找不到时用）
    this.fallback = this.maps[this.worldMaps[0]] || { keyframes: [] };
    // 平滑用缓存
    this.cur = null;
  }

  /** 某地图在 hour 时刻的插值环境（未做时间平滑） */
  raw(mapName, hour) {
    const m = this.maps[mapName] || this.fallback;
    const kf = sampleKeyframes(m.keyframes, hour);
    if (!kf) return null;
    const out = { map: mapName, water: m.water || {}, sunDir: m.sunDir || [0.577, 0.577, 0.577] };
    for (const grp of ['light', 'sun', 'fog', 'sky', 'cloud']) {
      out[grp] = Object.assign({}, DEFAULT_KEYS[grp], kf[grp] || {});
    }
    out.hour = hour;
    return out;
  }

  /** 区域内插 + 时间低通平滑，避免跨区域/跨时段硬跳 */
  sample(world, x, z, hour, dt) {
    const r = world && world.regionAt ? world.regionAt(x, z) : null;
    const nxt = this.raw(r ? r.name : null, hour);
    if (!nxt) return this.cur;
    if (!this.cur) { this.cur = nxt; return this.cur; }
    const k = Math.min(1, dt * 1.6);
    const cur = this.cur;
    const blend = (grp, key) => {
      const a = cur[grp][key], b = nxt[grp][key];
      if (typeof b === 'number' && typeof a === 'number') cur[grp][key] = a + (b - a) * k;
      else if (Array.isArray(b)) cur[grp][key] = lerpArr(a, b, k);
    };
    for (const grp of ['light', 'sun', 'fog', 'sky', 'cloud']) {
      for (const key of Object.keys(nxt[grp])) blend(grp, key);
    }
    cur.map = nxt.map; cur.water = nxt.water; cur.hour = hour;
    cur.sunDir = lerpArr(cur.sunDir || nxt.sunDir, nxt.sunDir, k);
    return cur;
  }

  toColor(arr, out) {
    return (out || new THREE.Color()).setRGB(arr[0], arr[1], arr[2]);
  }
}
