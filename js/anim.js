// anim.js —— 原版 XSM 骨骼动画播放（ALS 式：步态混合空间 + 相位同步 + 步幅匹配）
//
// 数据由 tools/build_anims.py 从 Characters/101/*.xsm 烘焙：
//   { dur, loop, stride, cphase, tracks: { bone: { r:[[t,x,y,z,w]], p:[[t,x,y,z]] } } }
//   stride —— 动画固有地面速度(m/s)，播放速率 = 实际速度/stride ⇒ 脚不打滑
//   cphase —— 触地相位，多个步态动画共用同一循环相位并按此对齐 ⇒ 切换/混合不跳脚
//
// 分层：locomotion(按速度连续加权的步态混合空间) + action(攻击/跳跃全身上覆)
import * as THREE from 'three';

const ANIM_BASE = './assets/chars/anims/';
const clipCache = new Map();

export async function loadAnim(name) {
  if (clipCache.has(name)) return clipCache.get(name);
  const data = await (await fetch(ANIM_BASE + name + '.json')).json();
  const tracks = new Map();
  for (const bone in data.tracks) {
    const t = data.tracks[bone];
    const out = {};
    if (t.r) {
      out.r = new Float32Array(t.r.length * 5);
      t.r.forEach((k, i) => out.r.set(k, i * 5));
      out.n = t.r.length;
    }
    if (t.p) {
      out.p = new Float32Array(t.p.length * 4);
      t.p.forEach((k, i) => out.p.set(k, i * 4));
      out.np = t.p.length;
    }
    tracks.set(bone, out);
  }
  const names = [];
  for (const [k, v] of tracks) if (v.r) names.push(k);
  const clip = {
    name, dur: data.dur, loop: data.loop, tracks, names,
    stride: data.stride || 0, cphase: data.cphase || 0,
  };
  clipCache.set(name, clip);
  return clip;
}

export async function loadAnims(names) {
  const out = {};
  for (const n of names) {
    try { out[n] = await loadAnim(n); }
    catch (e) { console.warn('anim load fail', n, e); }
  }
  return out;
}

// ---- 二分查找：返回前一关键帧索引 ----
function findKeys(arr, stride, n, t) {
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid * stride] <= t) lo = mid; else hi = mid;
  }
  return lo;
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const _accQ = new THREE.Quaternion(), _actQ = new THREE.Quaternion();
const _dy = [0];

/**
 * 采样一根骨骼。curW<=0 时直接写入 outQ；否则按 weight 增量混合。
 * 返回新的累计权重。轨道缺失时返回 curW 不变（调用方回落到绑定姿态）。
 */
function sampleRot(clip, boneName, t, outQ, curW, weight) {
  const tr = clip.tracks.get(boneName);
  if (!tr || !tr.r) return curW;
  const a = tr.r, i = findKeys(a, 5, tr.n, t);
  const o0 = i * 5, o1 = Math.min(tr.n - 1, i + 1) * 5;
  const t0 = a[o0], t1 = a[o1];
  _qa.set(a[o0 + 1], a[o0 + 2], a[o0 + 3], a[o0 + 4]);
  _qb.set(a[o1 + 1], a[o1 + 2], a[o1 + 3], a[o1 + 4]);
  const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  _qa.slerp(_qb, u).normalize();
  if (curW <= 0) { outQ.copy(_qa); return weight; }
  outQ.slerp(_qa, weight / (curW + weight));
  return curW + weight;
}

/** 采样根骨骼(Bip01)的 y 起伏，写入 out[0]；无轨道返回 null */
function sampleRootY(clip, t, out) {
  const tr = clip.tracks.get('Bip01');
  if (!tr || !tr.p) return null;
  const a = tr.p, i = findKeys(a, 4, tr.np, t);
  const o0 = i * 4, o1 = Math.min(tr.np - 1, i + 1) * 4;
  const t0 = a[o0], t1 = a[o1];
  const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  out[0] = a[o0 + 2] + (a[o1 + 2] - a[o0 + 2]) * u;
  return out[0];
}

/**
 * 骨骼动画播放器。
 *   player.setSpeed(v)          每帧传入角色实际水平速度(m/s)
 *   player.playAction(name, o)  攻击/跳跃等全身上覆动作
 *   player.update(dt)           采样 + 混合 + 写回骨骼
 */
export class AnimPlayer {
  constructor(parts, clips) {
    this.bones = parts.bones;
    this.clips = clips || {};
    this._bind = new Map();
    for (const b of this.bones) this._bind.set(b, { q: b.quaternion.clone(), p: b.position.clone() });

    // 步态混合空间。
    // 锚点(anchor) ≠ 步幅(stride)：锚点只决定"多快速度下该片段占主导"，
    // 步幅决定播放速率。两者分开可避免在中间速度把两段腿型差异大的步态
    // 各掺一半(会把脚抬离地面、反而更滑)。
    const anchors = { idle: 0, walk: 1.05, run: 4.2, sprint: 6.3 };
    const names = ['idle', 'walk', 'run', 'sprint'];
    this.loco = [];
    for (const n of names) {
      const c = this.clips[n];
      if (c) this.loco.push({ name: n, clip: c, isGait: n !== 'idle', anchor: anchors[n] });
    }
    this.loco.sort((a, b) => a.anchor - b.anchor);
    this._w = new Float32Array(this.loco.length);

    this.phase = 0;        // 步态共享相位 0..1
    this.tIdle = 0;        // 待机独立时间
    this.speed = 0;

    this.action = null;
    this.actionT = 0;
    this.actionW = 0;
    this.actionState = 'out';
    this.actionOpt = null;
    this._evFired = false;
  }

  setSpeed(v) { this.speed = Math.max(0, v || 0); }

  /**
   * 播放全身上覆动作。
   * opts: { fadeIn=0.08, fadeOut=0.2, rate=1, hold=false, eventAt, onEvent }
   * hold=true 时停在本动作末帧(跳跃)，需 releaseAction() 释放。
   */
  playAction(name, opts = {}) {
    const clip = this.clips[name];
    if (!clip) return false;
    this.action = clip;
    this.actionT = 0;
    this.actionW = 0;
    this.actionState = 'in';
    this._evFired = false;
    this.actionOpt = {
      fadeIn: opts.fadeIn !== undefined ? opts.fadeIn : 0.08,
      fadeOut: opts.fadeOut !== undefined ? opts.fadeOut : 0.2,
      rate: opts.rate !== undefined ? opts.rate : 1,
      hold: !!opts.hold,
      eventAt: opts.eventAt !== undefined ? opts.eventAt : null,
      onEvent: opts.onEvent || null,
    };
    return true;
  }

  releaseAction() { if (this.action && this.actionState !== 'out') this.actionState = 'out'; }
  get actionName() { return this.action ? this.action.name : null; }
  get actionActive() { return !!this.action && this.actionW > 0.001; }

  update(dt) {
    const loco = this.loco, w = this._w;

    // ---------- 1. 步态权重：速度在锚点间 smoothstep 过渡 ----------
    const sp = this.speed;
    if (loco.length === 1) {
      w[0] = 1;
    } else if (loco.length > 1) {
      let seg = loco.length - 2;
      for (let i = 0; i < loco.length - 1; i++) {
        if (sp <= loco[i + 1].anchor) { seg = i; break; }
      }
      const s0 = loco[seg].anchor, s1 = loco[seg + 1].anchor;
      let u = s1 > s0 ? (sp - s0) / (s1 - s0) : 0;
      u = Math.max(0, Math.min(1, u));
      u = u * u * (3 - 2 * u);
      for (let i = 0; i < loco.length; i++) w[i] = 0;
      w[seg] = 1 - u;
      w[seg + 1] = u;
    }

    // ---------- 2. 相位推进：f = v / Σ(w·stride·dur) ⇒ 混合后脚速 == 实际速度 ----------
    let gP = 0;
    for (let i = 0; i < loco.length; i++) {
      if (loco[i].isGait && w[i] > 0.0001) gP += w[i] * loco[i].clip.stride * loco[i].clip.dur;
    }
    if (gP > 1e-6 && sp > 0) {
      this.phase = (this.phase + Math.min(3.6, sp / gP) * dt) % 1;
    }
    this.tIdle += dt;

    // 生效列表按权重降序（权重大的先作基准）
    const act = [];
    for (let i = 0; i < loco.length; i++) if (w[i] > 0.0001) act.push(i);
    act.sort((a, b) => w[b] - w[a]);

    // ---------- 3. 动作层推进 ----------
    if (this.action) {
      const o = this.actionOpt;
      if (this.actionState === 'in') {
        this.actionW = Math.min(1, this.actionW + dt / Math.max(0.001, o.fadeIn));
        if (this.actionW >= 1) this.actionState = 'hold';
      } else if (this.actionState === 'hold') {
        if (!o.hold && this.actionT >= this.action.dur - o.fadeOut) this.actionState = 'out';
      } else {
        this.actionW -= dt / Math.max(0.001, o.fadeOut);
        if (this.actionW <= 0) { this.actionW = 0; this.action = null; }
      }
      if (this.action) {
        this.actionT += dt * o.rate;
        if (o.eventAt !== null && !this._evFired && this.actionT >= o.eventAt) {
          this._evFired = true;
          if (o.onEvent) o.onEvent();
        }
        if (this.actionT > this.action.dur) this.actionT = this.action.dur;
      }
    }
    const actClip = this.action, aw = this.action ? this.actionW : 0;

    // ---------- 4. 根骨骼 y 起伏（每条 clip 只算一次） ----------
    let dySum = 0, dyW = 0;
    for (let k = 0; k < act.length; k++) {
      const L = loco[act[k]], ww = w[act[k]];
      const t = L.isGait ? ((this.phase + L.clip.cphase) % 1) * L.clip.dur
                         : (this.tIdle % L.clip.dur);
      const y = sampleRootY(L.clip, t, _dy);
      if (y !== null) { dySum += ww * y; dyW += ww; }
    }
    let outY = dyW > 0 ? dySum / dyW : 0;
    if (actClip && aw > 0.0001) {
      const yr = sampleRootY(actClip, this.actionT, _dy);
      if (yr !== null) outY = outY * (1 - aw) + yr * aw;
    }

    // ---------- 5. 只处理"当前生效 clip 里有轨道"的骨骼 ----------
    const activeBones = this._activeBones || (this._activeBones = new Set());
    const touched = this._touched || (this._touched = new Set());
    activeBones.clear();
    for (let k = 0; k < act.length; k++) {
      for (const n of loco[act[k]].clip.names) activeBones.add(n);
    }
    if (actClip && aw > 0.0001) for (const n of actClip.names) activeBones.add(n);

    const byName = this._byName || (this._byName = (() => {
      const m = new Map();
      for (const b of this.bones) m.set(b.name, b);
      return m;
    })());

    for (const name of activeBones) {
      const b = byName.get(name);
      if (!b) continue;
      touched.add(name);
      const bind = this._bind.get(b);
      // 步态层（多 clip 加权混合）
      let curW = 0;
      for (let k = 0; k < act.length; k++) {
        const L = loco[act[k]], ww = w[act[k]];
        const t = L.isGait ? ((this.phase + L.clip.cphase) % 1) * L.clip.dur
                           : (this.tIdle % L.clip.dur);
        curW = sampleRot(L.clip, name, t, _accQ, curW, ww);
      }
      if (curW <= 0) _accQ.copy(bind.q);
      // 动作层上覆
      if (actClip && aw > 0.0001) {
        const tr = actClip.tracks.get(name);
        if (tr && tr.r) {
          sampleRot(actClip, name, this.actionT, _actQ, 0, 1);
          _accQ.slerp(_actQ, aw);
        }
      }
      b.quaternion.copy(_accQ);
    }

    // ---------- 6. 本帧不再被驱动的骨骼恢复绑定姿态 ----------
    for (const name of touched) {
      if (activeBones.has(name)) continue;
      const b = byName.get(name);
      if (b) b.quaternion.copy(this._bind.get(b).q);
      touched.delete(name);
    }

    // ---------- 7. 根骨骼位置（y 起伏） ----------
    const root = this._rootBone || (this._rootBone = (() => {
      let best = null;
      for (const b of this.bones) if (b.name === 'Bip01') best = b;
      if (!best) for (const b of this.bones) if (this._bind.has(b) && b.parent === this.bones[0].parent) { best = b; break; }
      return best;
    })());
    if (root) {
      const bind = this._bind.get(root);
      root.position.set(bind.p.x, bind.p.y + outY, bind.p.z);
    }
  }
}
