// world.js —— 地形 / 植被 / 水 / 天空
import * as THREE from 'three';

export const CHUNK = 64;          // 每 chunk 采样数

export class World {
  constructor(meta, heights, colormapTex) {
    this.meta = meta;
    this.W = meta.width; this.H = meta.height;
    this.spacing = meta.spacing;
    this.worldW = meta.worldW; this.worldH = meta.worldH;
    this.originX = meta.originX; this.originZ = meta.originZ;
    this.hmin = meta.hmin; this.hmax = meta.hmax;
    this.sea = meta.seaLevel;
    this.heights = heights;                 // Float32Array W*H (米)
    this.colormapTex = colormapTex;
    this.chunks = new Map();
    this.vegMatCache = new Map();
    this.vegDist = 420;                     // 植被可见距离
    this.group = new THREE.Group();
  }

  idx(ix, iz) { return iz * this.W + ix; }

  heightAt(x, z) {
    const fx = (x - this.originX) / this.spacing;
    const fz = (z - this.originZ) / this.spacing;
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    if (x0 < 0 || z0 < 0 || x0 >= this.W - 1 || z0 >= this.H - 1) return this.sea - 6;
    const tx = fx - x0, tz = fz - z0;
    const h = this.heights;
    const a = h[this.idx(x0, z0)], b = h[this.idx(x0 + 1, z0)];
    const c = h[this.idx(x0, z0 + 1)], d = h[this.idx(x0 + 1, z0 + 1)];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  normalAt(x, z, out) {
    const e = this.spacing;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    out.set(hl - hr, 2 * e, hd - hu).normalize();
    return out;
  }

  slopeAt(x, z) {
    const n = this.normalAt(x, z, _tmpN);
    return 1 - n.y;
  }

  regionAt(x, z) {
    for (const r of this.meta.regions) {
      if (Math.abs(x - r.cx) <= r.w / 2 + 40 && Math.abs(z - r.cz) <= r.h / 2 + 40) return r;
    }
    return null;
  }

  // ---------- 地形 chunk ----------
  buildChunkGeometry(cx, cz, stride) {
    const pos = [], uv = [], idxArr = [], slopeArr = [], altArr = [];
    const ix0 = cx * CHUNK, iz0 = cz * CHUNK;
    const n = Math.floor((CHUNK - 1) / stride) + 1;
    const step = stride * this.spacing;
    const skirt = 6 + stride * 2;
    const ox = this.originX, oz = this.originZ;
    const W = this.W, H = this.H, hs = this.heights;
    // 顶点 (n+2)^2 含裙边
    for (let j = -1; j <= n; j++) {
      for (let i = -1; i <= n; i++) {
        const inner = i >= 0 && i < n && j >= 0 && j < n;
        const gi = Math.min(Math.max(ix0 + i * stride, 0), W - 1);
        const gj = Math.min(Math.max(iz0 + j * stride, 0), H - 1);
        const h = hs[this.idx(gi, gj)];
        const wx = ox + gi * this.spacing, wz = oz + gj * this.spacing;
        const y = inner ? h : h - skirt;
        pos.push(wx, y, wz);
        uv.push((wx - ox) / this.worldW, (wz - oz) / this.worldH);
        // 坡度 / 高度：喂给地表着色器做岩石、积雪、沙岸分层
        const gl = hs[this.idx(Math.max(gi - 1, 0), gj)], gr = hs[this.idx(Math.min(gi + 1, W - 1), gj)];
        const gd = hs[this.idx(gi, Math.max(gj - 1, 0))], gu = hs[this.idx(gi, Math.min(gj + 1, H - 1))];
        const dx = (gr - gl) / (2 * this.spacing), dz = (gu - gd) / (2 * this.spacing);
        slopeArr.push(1.0 - 1.0 / Math.sqrt(dx * dx + dz * dz + 1.0));
        altArr.push(this.hmin + (h - this.hmin) / (this.hmax - this.hmin));
      }
    }
    const row = n + 2;
    for (let j = 0; j < n + 1; j++) {
      for (let i = 0; i < n + 1; i++) {
        const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
        idxArr.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aSlope', new THREE.Float32BufferAttribute(slopeArr, 1));
    g.setAttribute('aAlt', new THREE.Float32BufferAttribute(altArr, 1));
    g.setIndex(idxArr);
    g.computeVertexNormals();
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(ox + (ix0 + CHUNK / 2) * this.spacing, 0, oz + (iz0 + CHUNK / 2) * this.spacing),
      CHUNK * this.spacing * 0.75 + 400);
    return g;
  }

  update(px, pz) {
    const ncx = Math.floor((px - this.originX) / (CHUNK * this.spacing));
    const ncz = Math.floor((pz - this.originZ) / (CHUNK * this.spacing));
    const R = 10;
    const want = new Map();
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const cx = ncx + dx, cz = ncz + dz;
      if (cx < 0 || cz < 0 || cx * CHUNK >= this.W || cz * CHUNK >= this.H) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 > R * R + 4) continue;
      const stride = d2 <= 2 ? 1 : d2 <= 6 ? 2 : d2 <= 20 ? 4 : 8;
      want.set(cx + ',' + cz, stride);
    }
    // 移除不需要的
    for (const [key, entry] of this.chunks) {
      if (!want.has(key)) {
        this.group.remove(entry.mesh); entry.mesh.geometry.dispose();
        if (entry.veg) { this.group.remove(entry.veg); entry.veg.geometry.dispose(); }
        this.chunks.delete(key);
      } else if (want.get(key) !== entry.stride) {
        const oldGeo = entry.mesh.geometry;
        entry.mesh.geometry = this.buildChunkGeometry(entry.cx, entry.cz, want.get(key));
        entry.stride = want.get(key);
        oldGeo.dispose();
      }
    }
    // 新建
    for (const [key, stride] of want) {
      if (this.chunks.has(key)) continue;
      const [cx, cz] = key.split(',').map(Number);
      const mesh = new THREE.Mesh(this.buildChunkGeometry(cx, cz, stride), this.terrainMat);
      mesh.matrixAutoUpdate = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      const entry = { cx, cz, stride, mesh, veg: null, vegBuilt: false };
      this.chunks.set(key, entry);
    }
    // 植被
    for (const [key, entry] of this.chunks) {
      const [cx, cz] = [entry.cx, entry.cz];
      const mx = this.originX + (cx + 0.5) * CHUNK * this.spacing;
      const mz = this.originZ + (cz + 0.5) * CHUNK * this.spacing;
      const d2 = (mx - px) ** 2 + (mz - pz) ** 2;
      if (!entry.vegBuilt && d2 < this.vegDist * this.vegDist) {
        entry.veg = this.buildVegetation(entry);
        if (entry.veg) this.group.add(entry.veg);
        entry.vegBuilt = true;
      }
    }
  }

  // ---------- 植被 ----------
  buildVegetation(entry) {
    const { cx, cz } = entry;
    const midX = this.originX + (cx + 0.5) * CHUNK * this.spacing;
    const midZ = this.originZ + (cz + 0.5) * CHUNK * this.spacing;
    const reg = this.regionAt(midX, midZ);
    const vegKey = reg ? reg.veg : 'veg/n04.png';
    const bio = reg || { tree: 0.05, grass: 0.2, snow: 240 };
    let mat = this.vegMatCache.get(vegKey);
    if (!mat) {
      const tex = new THREE.TextureLoader().load('assets/' + vegKey);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
      mat = new THREE.MeshStandardMaterial({
        map: tex, alphaTest: 0.45, side: THREE.DoubleSide,
        roughness: 1.0, metalness: 0.0, envMapIntensity: 0.3,
      });
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = vegTime;
        sh.vertexShader = 'uniform float uTime;\nattribute float aPhase;\nattribute float aSway;\n' +
          sh.vertexShader
            .replace('#include <beginnormal_vertex>',
              // 交叉面片无合理法线：按地面法线受光，让植被与地表明暗一致
              'vec3 objectNormal = vec3( 0.0, 1.0, 0.0 );')
            .replace('#include <begin_vertex>',
              `#include <begin_vertex>
             float sway = sin(uTime*1.7 + aPhase) * 0.5 + sin(uTime*3.1 + aPhase*1.3)*0.3;
             transformed.x += sway * aSway;
             transformed.z += cos(uTime*1.4 + aPhase)*0.4 * aSway;`);
      };
      this.vegMatCache.set(vegKey, mat);
    }
    const rng = mulberry(cx * 73856093 ^ cz * 19349663);
    const pos = [], uvs = [], idxArr = [], phases = [], sways = [];
    const SP = this.spacing, ox = this.originX, oz = this.originZ;
    let count = 0, maxCount = 900;
    for (let t = 0; t < 3200 && count < maxCount; t++) {
      const gx = cx * CHUNK + rng() * CHUNK, gz = cz * CHUNK + rng() * CHUNK;
      const wx = ox + gx * SP, wz = oz + gz * SP;
      const h = this.heights[this.idx(Math.floor(gx), Math.floor(gz))];
      if (h < this.sea + 1.2) continue;
      if (h > bio.snow + 30) continue;
      const sl = this.slopeAt(wx, wz);
      if (sl > 0.55) continue;
      const r = rng();
      let big = r < bio.tree, cell;
      if (big) { if (rng() > 0.75) continue; cell = 12 + Math.floor(rng() * 4); }
      else { if (rng() > bio.grass) continue; cell = Math.floor(rng() * 12); }
      // flipY 后: 图像底行(row3)=灌木/秋叶 -> v 0.01; 上面三行=草花 -> v 0.26/0.51/0.76
      const cv = big ? 0.01 : 0.26 + Math.floor(cell / 4) * 0.25;
      const cu = (cell % 4) * 0.25 + 0.01, su = 0.23;
      const sizeH = big ? 2.2 + rng() * 3.0 : 0.55 + rng() * 0.8;
      const sizeW = sizeH * (0.55 + rng() * 0.35);
      const y = h - 0.15, rot = rng() * Math.PI;
      const dx = Math.cos(rot) * sizeW / 2, dz = Math.sin(rot) * sizeW / 2;
      for (let q = 0; q < 2; q++) {   // 两个交叉面片
        const qx = q ? dz : dx, qz = q ? dx : dz;
        const b = pos.length / 3;
        pos.push(wx - qx, y, wz - qz, wx + qx, y, wz + qz,
                 wx + qx, y + sizeH, wz + qz, wx - qx, y + sizeH, wz - qz);
        uvs.push(cu, cv, cu + su, cv, cu + su, cv + su, cu, cv + su);
        for (let k = 0; k < 4; k++) {
          phases.push(rng() * 6.28);
          sways.push(q === 0 ? 0 : 0);
        }
        // 顶点摆动幅度: 上面两顶点摆, 下面不动
        sways[b + 2] = sizeH * 0.012; sways[b + 3] = sizeH * 0.012;
        idxArr.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
      count++;
    }
    if (!count) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(sways, 1));
    g.setIndex(idxArr);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = true;
    mesh.castShadow = true;       // 树木/草丛投影（alphaTest 在深度材质中自动生效）
    mesh.receiveShadow = true;
    return mesh;
  }
}

const _tmpN = new THREE.Vector3();
export const vegTime = { value: 0 };

export function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---------- 水面 ----------
// 参数全部来自 Maps/<map>/<map>.vscene 的 PlanarWater 材质串：
//   brightWaterColor / darkWaterColor / waterTintColor / chromaticExtinction
//   sunColor / sunDirection / waterOpacity / waterNormalParams / waterFlowDirection
//   reflectionParams / specularParams / refractionDepthScale / fShoreFadeoutRange
export function createWater(world, env) {
  const geo = new THREE.PlaneGeometry(world.worldW + 6000, world.worldH + 6000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const w = (env && env.water) || {};
  const c3 = (v, fb) => new THREE.Color(
    Array.isArray(v) && v.length >= 3 ? v[0] : fb[0],
    Array.isArray(v) && v.length >= 3 ? v[1] : fb[1],
    Array.isArray(v) && v.length >= 3 ? v[2] : fb[2]);
  const bright = c3(w.brightWaterColor, [0.01, 0.11, 0.18]);
  const dark = c3(w.darkWaterColor, [0.016, 0.098, 0.26]);
  const tint = c3(w.waterTintColor, [0.004, 0.043, 0.09]);
  const sunC = c3(w.sunColor, [1.0, 0.71, 0.18]);
  const sd = (env && env.sunDir) || [0.577, 0.577, 0.577];
  const np = w.waterNormalParams || [0.1, 0.002, 0.5];
  const fl = w.waterFlowDirection || [0.002, 0.1];
  const sp = w.specularParams || [512, 0];
  const rp = w.reflectionParams || [0.5, 100, 10, 0.02];

  const nrmTex = new THREE.TextureLoader().load('assets/terrain/water.normal.png');
  nrmTex.wrapS = nrmTex.wrapT = THREE.RepeatWrapping;
  nrmTex.colorSpace = THREE.NoColorSpace;

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uNormal: { value: nrmTex },
        uBright: { value: bright },
        uDark: { value: dark },
        uTint: { value: tint },
        uSunColor: { value: sunC },
        uSunDir: { value: new THREE.Vector3(sd[0], sd[1], sd[2]).normalize() },
        uSkyHorizon: { value: new THREE.Color(0.55, 0.68, 0.82) },
        uOpacity: { value: Math.max(0.35, Math.min(0.92, (w.waterOpacity || 0.005) * 30.0 + 0.42)) },
        uNormScale: { value: np[0] * 3.0 },
        uFlow: { value: new THREE.Vector2(fl[0], fl[1]).multiplyScalar(30.0) },
        uSpec: { value: sp[0] },
        uRefl: { value: rp[0] },
        uExtinct: { value: new THREE.Vector3(
          (w.chromaticExtinction || [0.833, 0.357, 0.263])[0],
          (w.chromaticExtinction || [0.833, 0.357, 0.263])[1],
          (w.chromaticExtinction || [0.833, 0.357, 0.263])[2]) },
      },
    ]),
    vertexShader: `
      #include <fog_pars_vertex>
      uniform float uTime;
      uniform vec2 uFlow;
      varying vec3 vWorld;
      varying vec2 vNuv;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNuv = wp.xz * 0.012 + uFlow * uTime;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <fog_pars_fragment>
      uniform sampler2D uNormal;
      uniform float uTime, uOpacity, uNormScale, uSpec, uRefl;
      uniform vec3 uBright, uDark, uTint, uSunColor, uSunDir, uSkyHorizon, uExtinct;
      uniform vec2 uFlow;
      varying vec3 vWorld;
      varying vec2 vNuv;
      vec3 ripple(vec2 p){
        vec3 a = texture2D(uNormal, p).xyz * 2.0 - 1.0;
        vec3 b = texture2D(uNormal, p * 2.13 + vec2(0.37, -0.21)).xyz * 2.0 - 1.0;
        vec3 n = a + b * 0.6;
        n.xy *= uNormScale;
        return normalize(vec3(n.x, n.z, n.y));
      }
      void main(){
        vec3 N = ripple(vNuv);
        vec3 V = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - clamp(dot(V, N), 0.0, 1.0), 4.0);
        // 水体本色：原版色值是按 HDR 曝光的，LDR 下整体偏暗，这里做曝光补偿
        float d = clamp(1.0 - V.y, 0.0, 1.0) * 2.0;
        vec3 body = mix(uBright, uDark, 0.45) * 2.8;
        vec3 ext = exp(-uExtinct * d);
        vec3 col = mix(body, uTint * 2.4, fres * 0.35) * ext;
        // 天光反射
        col = mix(col, uSkyHorizon, fres * (0.55 + 0.4 * uRefl));
        // 阳光镜面
        vec3 H = normalize(normalize(uSunDir) + V);
        col += uSunColor * pow(max(dot(N, H), 0.0), max(8.0, uSpec * 0.25)) * 2.4;
        float a = clamp(uOpacity + fres * 0.55, 0.3, 0.96);
        gl_FragColor = vec4(col, a);
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(world.originX + world.worldW / 2, world.sea, world.originZ + world.worldH / 2);
  mesh.renderOrder = 2;
  return { mesh, mat, tex: nrmTex };
}

// ---------- 天空 ----------
// FilterTopColor / FilterMiddleColor / FilterBottomColor = 原版天空三段渐变
// SunColor / SunSize / SunLum / CloudColor / CloudAlpha / CloudCurve = 原版日月与云
export function createSky(scene) {
  const geo = new THREE.SphereGeometry(9000, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0.30, 0.50, 0.90) },
      uMid: { value: new THREE.Color(0.55, 0.72, 0.88) },
      uBot: { value: new THREE.Color(0.72, 0.80, 0.86) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uSunLum: { value: 1.0 },
      uSunSize: { value: 4.0 },
      uCloud: { value: new THREE.Color(1, 1, 1) },
      uCloudAlpha: { value: 0.0 },
      uCloudH: { value: 5.0 },
      uCloudCurve: { value: 0.2 },
      uLum: { value: 0.2 },
      uInscatter: { value: 0.3 },
      uTime: { value: 0 },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uTop, uMid, uBot, uSunColor, uCloud;
      uniform vec3 uSunDir;
      uniform float uSunLum, uSunSize, uCloudAlpha, uCloudH, uCloudCurve, uLum, uInscatter, uTime;
      varying vec3 vDir;
      float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,54.53)))*43758.5453); }
      float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        f = f*f*(3.0-2.0*f);
        float a = hash(vec3(i, 0.0)), b = hash(vec3(i + vec2(1,0), 0.0));
        float c = hash(vec3(i + vec2(0,1), 0.0)), d = hash(vec3(i + vec2(1,1), 0.0));
        return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
      }
      void main(){
        vec3 dir = normalize(vDir);
        float up = dir.y;
        // 三段渐变：地平线以下压向 BottomColor
        vec3 col = up >= 0.0
          ? mix(uMid, uTop, pow(clamp(up,0.0,1.0), 0.62))
          : mix(uMid, uBot, clamp(-up * 4.0, 0.0, 1.0));
        // SkyLumScale 在原引擎里是 HDR 曝光系数（0.2~6.0）；这里映射成有界的曝光修正，
        // 否则高 lumScale 的时段（暮/夜）会把渐变直接顶到纯白。
        col *= mix(0.80, 1.12, clamp(uLum / 1.6, 0.0, 1.0));
        float sunH = uSunDir.y;
        // 太阳 / 月亮
        float sd = max(dot(dir, uSunDir), 0.0);
        float core = pow(sd, 2400.0 / max(1.0, uSunSize));
        col += uSunColor * core * (1.15 * clamp(uSunLum, 0.0, 2.5)) * smoothstep(-0.10, 0.10, sunH);
        col += uSunColor * pow(sd, 18.0) * (0.10 + 0.20 * uInscatter) * clamp(uSunLum, 0.0, 2.5) * 0.55;
        // 星空（夜间）
        if (sunH < 0.06 && up > 0.02) {
          float s = hash(floor(dir * 260.0));
          if (s > 0.9968) col += vec3(0.85,0.88,1.0) * smoothstep(0.06, -0.05, sunH) * (0.4 + 0.6*s);
        }
        // 云：vnoise 两倍频，按 CloudHeight / CloudCurve / CloudAlpha 起效
        if (uCloudAlpha > 0.01) {
          vec2 cp = dir.xz / max(0.06, up + 0.06) * 0.35 + vec2(uTime * 0.004, uTime * 0.002);
          float n = vnoise(cp) * 0.6 + vnoise(cp * 2.7) * 0.3 + vnoise(cp * 6.1) * 0.15;
          float band = smoothstep(0.0, 0.25, up) * (1.0 - smoothstep(0.55, 0.95, up));
          float cover = smoothstep(1.0 - clamp(uCloudAlpha, 0.0, 1.0), 1.0, n) * band;
          float lit = 0.72 + 0.5 * pow(max(dot(dir, uSunDir), 0.0), 4.0);
          col = mix(col, uCloud * lit, cover * clamp(uCloudAlpha, 0.0, 1.0));
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, mat };
}
