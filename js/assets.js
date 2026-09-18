// assets.js —— 原版资产运行时加载
//  角色: assets/chars/<id>.json + .bin  (XAC 骨骼 + 蒙皮网格，Y-up，面朝 +Z)
//  道具: assets/props/index.json + props.bin (vmesh 静态网格，已转 Y-up)
import * as THREE from 'three';

const CHAR_BASE = './assets/chars/';
const PROP_BASE = './assets/props/';

const charProtos = new Map();
const texLoader = new THREE.TextureLoader();

// 原版资产的贴图寻址约定（Vision Engine / DX9）：
//  1) UV 是"带符号 + 可越界"的：u 可能落在 [-1,1]，v 甚至到 [-3,3]（建筑瓦片平铺）。
//     引擎靠纹理 WRAP 寻址折回 [0,1]。若用默认 ClampToEdge，越界部分会被拉伸成
//     边缘像素色块 —— 角色的脸会糊成一条肤色斜带，建筑纹理会被拉花。
//  2) DDS 首行是贴图顶部，即 v=0 对应图像顶行（D3D 约定）。three.js 默认
//     flipY=true 会把 v=0 对到底行，所以这里必须 flipY=false。
// 道具侧 build_props.py 已把 v 预翻成 1-v 以配合 flipY=true，故此处分两套。
function loadTexture(url, charStyle) {
  const t = texLoader.load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (charStyle) t.flipY = false;
  return t;
}

// ============================ 角色 ============================

export async function loadCharProto(id) {
  if (charProtos.has(id)) return charProtos.get(id);
  const meta = await (await fetch(CHAR_BASE + id + '.json')).json();
  const buf = await (await fetch(CHAR_BASE + id + '.bin')).arrayBuffer();
  const nv = meta.counts.verts, ni = meta.counts.idx, o = meta.offsets;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, o.pos, nv * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(buf, o.nrm, nv * 3), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, o.uv, nv * 2), 2));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(buf, o.bi, nv * 4), 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(buf, o.bw, nv * 4), 4));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, o.idx, ni), 1));

  const texKeys = Object.keys(meta.tex);
  const mats = texKeys.map((k) => new THREE.MeshLambertMaterial({
    map: loadTexture(CHAR_BASE + meta.tex[k], true),
    side: THREE.DoubleSide,
    alphaTest: 0.42,
  }));
  const matOf = {};
  texKeys.forEach((k, i) => { matOf[k] = i; });
  if (!texKeys.length) mats.push(new THREE.MeshLambertMaterial({ color: 0x8a7f6d, side: THREE.DoubleSide }));
  for (const g of meta.groups) {
    geo.addGroup(g.start, g.count, matOf[g.tex] !== undefined ? matOf[g.tex] : 0);
  }
  geo.computeBoundingSphere();

  const proto = { id, meta, geo, mats };
  charProtos.set(id, proto);
  return proto;
}

export async function preloadChars(ids) {
  for (const id of ids) {
    try { await loadCharProto(id); }
    catch (e) { console.warn('char load fail', id, e); }
  }
}

const BONE_ALIAS = {
  armL: ['Bip01 L UpperArm'], armR: ['Bip01 R UpperArm'],
  foreL: ['Bip01 L Forearm'], foreR: ['Bip01 R Forearm'],
  thighL: ['Bip01 L Thigh'], thighR: ['Bip01 R Thigh'],
  calfL: ['Bip01 L Calf'], calfR: ['Bip01 R Calf'],
  head: ['Bip01 Head'], spine: ['Bip01 Spine', 'Bip01 Spine1'],
};

/**
 * 生成一个角色实例（自带独立骨架，可各自摆姿势）
 * 返回 { group, parts, height }
 */
export function makeChar(id) {
  const proto = charProtos.get(id);
  if (!proto) return null;
  const meta = proto.meta;

  const objs = meta.bones.map((b) => {
    const o = new THREE.Bone();
    o.name = b.name;
    o.position.fromArray(b.p);
    o.quaternion.fromArray(b.q);
    o.scale.fromArray(b.s);
    return o;
  });
  const root = new THREE.Group();
  meta.bones.forEach((b, i) => {
    if (b.parent >= 0 && b.parent < objs.length) objs[b.parent].add(objs[i]);
    else root.add(objs[i]);
  });

  const mesh = new THREE.SkinnedMesh(proto.geo, proto.mats);
  mesh.frustumCulled = false;
  mesh.add(root);
  root.updateMatrixWorld(true);

  const boneInvs = objs.map((o) => o.matrixWorld.clone().invert());
  const skeleton = new THREE.Skeleton(objs, boneInvs);
  mesh.bind(skeleton, new THREE.Matrix4());

  // 每条骨骼记录：绑定局部旋转、父级世界旋转、以及绑定姿态下该骨段的世界方向。
  // 运行时一律从绑定姿态重新合成，避免姿态累积漂移。
  const rig = new Map();
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const _a = new THREE.Vector3(), _b = new THREE.Vector3();
  objs.forEach((o) => {
    const pw = o.parent ? o.parent.matrixWorld : new THREE.Matrix4();
    const pq = new THREE.Quaternion();
    pw.decompose(_p, pq, _s);
    // 骨段方向 = 自身 -> 第一个子骨骼（绑定姿态，世界空间）
    let dir = new THREE.Vector3(0, -1, 0);
    const kid = o.children.find((c) => c.isBone);
    if (kid) {
      _a.setFromMatrixPosition(o.matrixWorld);
      _b.setFromMatrixPosition(kid.matrixWorld);
      dir = _b.sub(_a);
      if (dir.lengthSq() > 1e-8) dir.normalize(); else dir.set(0, -1, 0);
    }
    rig.set(o, {
      bone: o,
      bindLocal: o.quaternion.clone(),
      invParentQ: pq.clone().invert(),
      parentQ: pq.clone(),
      dir,
    });
  });

  const parts = { bones: objs, root, mesh, rig };
  const byName = {};
  meta.bones.forEach((b, i) => { byName[b.name] = objs[i]; });
  for (const k in BONE_ALIAS) {
    for (const n of BONE_ALIAS[k]) {
      if (byName[n]) { parts[k] = byName[n]; break; }
    }
  }

  const group = new THREE.Group();
  // 让脚底落在 group 原点
  mesh.position.y = -(meta.bounds ? meta.bounds.min[1] : 0);
  group.add(mesh);
  group.scale.setScalar(meta.scale);
  const bb = meta.bounds;
  const height = bb ? (bb.max[1] - bb.min[1]) * meta.scale : 1.82;

  // 注意：这里不再调用 animateChar 摆默认姿势 ——
  // AnimPlayer 需要纯净的 XAC 绑定姿态作为回退基准。
  return { group, parts, height, id };
}

// ---- 世界空间摆姿 ----
const DOWN = new THREE.Vector3(0, -1, 0);
const FWD = new THREE.Vector3(0, 0, 1);
const ATK_DIR = new THREE.Vector3(0, 0.35, 0.94).normalize();
const _ax = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

/** 把骨骼设为「绑定姿态 + 世界空间增量旋转 R」 */
function setWorldRot(rec, R) {
  rec.bone.quaternion.copy(rec.invParentQ).multiply(R).multiply(rec.parentQ).multiply(rec.bindLocal);
}

/** 从 from 朝 to 旋转 amount(0..1) 的四元数 */
function rotTo(from, to, amount) {
  _ax.crossVectors(from, to);
  if (_ax.lengthSq() < 1e-8) return _q1.identity().clone();
  _ax.normalize();
  const ang = Math.acos(THREE.MathUtils.clamp(from.dot(to), -1, 1)) * amount;
  return new THREE.Quaternion().setFromAxisAngle(_ax, ang);
}

/** 绕摆动轴（骨段方向 × 前方）旋转，即前后摆腿/摆臂 */
function swingQ(rec, ang) {
  _ax.crossVectors(rec.dir, FWD);
  if (_ax.lengthSq() < 1e-8) _ax.set(1, 0, 0); else _ax.normalize();
  return new THREE.Quaternion().setFromAxisAngle(_ax, ang);
}

/** 每帧动画：走路摆腿摆臂 + 攻击挥臂 + 站立呼吸 */
export function animateChar(parts, speed, t, attackT) {
  if (!parts || !parts.rig) return;
  const s = Math.min(speed / 5.2, 1.6);
  const f = t * (4.5 + s * 4);
  const sw = Math.sin(f) * (0.22 + s * 0.5);
  const breath = Math.sin(t * 1.4) * 0.03;

  const R = (bone) => parts.rig.get(bone);

  // 腿：绑定姿态下已竖直向下，直接前后摆
  if (parts.thighL) setWorldRot(R(parts.thighL), swingQ(R(parts.thighL), -sw * 0.55));
  if (parts.thighR) setWorldRot(R(parts.thighR), swingQ(R(parts.thighR), sw * 0.55));
  if (parts.calfL) setWorldRot(R(parts.calfL), swingQ(R(parts.calfL), Math.max(0, -sw) * 0.5));
  if (parts.calfR) setWorldRot(R(parts.calfR), swingQ(R(parts.calfR), Math.max(0, sw) * 0.5));

  // 手臂：绑定姿态是 A-pose（约 40° 下垂），先再放松一点，再叠加摆动
  const armPose = (bone, swing, attack) => {
    const rec = R(bone);
    if (!rec) return;
    if (attack > 0) {
      const q = swingQ(rec, swing * 0.3).multiply(rotTo(rec.dir, ATK_DIR, 0.95 * attack));
      setWorldRot(rec, q);
    } else {
      const q = swingQ(rec, swing).multiply(rotTo(rec.dir, DOWN, 0.45));
      setWorldRot(rec, q);
    }
  };
  armPose(parts.armL, sw * 0.4, 0);
  armPose(parts.armR, -sw * 0.4, attackT);
  armPose(parts.foreL, sw * 0.2, 0);
  if (!attackT) armPose(parts.foreR, -sw * 0.2, 0);

  if (parts.spine) {
    const rec = R(parts.spine);
    const q = _q2.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(f) * 0.05 * s)
      .multiply(_q1.setFromAxisAngle(new THREE.Vector3(1, 0, 0), breath));
    setWorldRot(rec, q);
  }
  if (parts.head && !s) {
    const rec = R(parts.head);
    setWorldRot(rec, _q2.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(t * 0.7) * 0.12));
  }
}

// ============================ 场景道具 ============================

let propSet = null;

/** loadProps 的附带信息（区域 -> 建筑目录候选），由 index.json 带回 */
export const G_PROPS = {};

export async function loadProps() {
  if (propSet) return propSet;
  const idx = await (await fetch(PROP_BASE + 'index.json')).json();
  const buf = await (await fetch(PROP_BASE + 'props.bin')).arrayBuffer();
  const matCache = new Map();
  const fallback = new THREE.MeshLambertMaterial({ color: 0x6d6255, side: THREE.DoubleSide });

  const matOf = (tex) => {
    if (!tex) return fallback;
    if (matCache.has(tex)) return matCache.get(tex);
    const m = new THREE.MeshLambertMaterial({
      map: loadTexture(PROP_BASE + tex, false),
      side: THREE.DoubleSide,
    });    matCache.set(tex, m);
    return m;
  };

  const props = idx.props.map((p) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, p.vOff, p.nv * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(buf, p.nOff, p.nv * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, p.uOff, p.nv * 2), 2));
    // 顶点数 <= 65535 的网格用 u16 索引（省一半索引带宽）
    geo.setIndex(new THREE.BufferAttribute(
      p.i16 !== false ? new Uint16Array(buf, p.iOff, p.ni) : new Uint32Array(buf, p.iOff, p.ni), 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return { name: p.name, cat: p.cat, region: p.region, size: p.size, geo, mat: matOf(p.tex) };
  });
  propSet = props;
  G_PROPS.regionBuildings = idx.regionBuildings || {};
  G_PROPS.shared = idx.shared || [];
  return props;
}

/** 生成一个道具 Mesh（几何/材质共享） */
export function makeProp(prop) {
  return new THREE.Mesh(prop.geo, prop.mat);
}
