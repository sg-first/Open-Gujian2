// anim.js —— 原版 XSM 骨骼动画加载与播放
// 数据由 tools/build_anims.py 从 Characters/101/*.xsm 烘焙：
//   { dur, loop, tracks: { boneName: { r: [[t,x,y,z,w]...], p: [[t,x,y,z]...] } } }
// 四元数为骨骼局部空间，与 XAC 绑定骨架一致，可直接写 bone.quaternion。
import * as THREE from 'three';

const ANIM_BASE = './assets/chars/anims/';
const clipCache = new Map();

export async function loadAnim(name) {
  if (clipCache.has(name)) return clipCache.get(name);
  const data = await (await fetch(ANIM_BASE + name + '.json')).json();
  // 平铺成 Float32Array，方便二分采样
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
  const clip = { name, dur: data.dur, loop: data.loop, tracks };
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

// ---- 二分查找：返回 key 前后索引与插值因子 ----
function findKeys(arr, stride, n, t) {
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid * stride] <= t) lo = mid; else hi = mid;
  }
  return lo;
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const _qa2 = new THREE.Quaternion(), _qb2 = new THREE.Quaternion();

/**
 * 骨骼动画播放器：双轨混合(prev/cur) + 关键帧插值。
 * 无轨道的骨骼回落到绑定姿态，避免残留姿势。
 */
export class AnimPlayer {
  constructor(parts, clips) {
    this.bones = parts.bones;             // 全部骨骼
    this.clips = clips || {};
    this.cur = null; this.prev = null;
    this.tCur = 0; this.tPrev = 0;
    this.fade = 0; this.fadeDur = 0.2;    // 0..1，1=完全切到 cur
    this.rate = 1;
    this.done = false;                    // 非循环播完
    this._bind = new Map();               // 骨骼绑定局部姿态
    for (const b of this.bones) this._bind.set(b, { q: b.quaternion.clone(), p: b.position.clone() });
  }

  /** 切换动画。fade=淡入时长(秒)。返回是否真的切换了 */
  play(name, fade = 0.2, rate = 1) {
    const clip = this.clips[name];
    if (!clip || (this.cur === clip && !this.done)) return false;
    this.prev = this.cur;
    this.tPrev = this.tCur;
    this.ratePrev = this.rate;
    this.cur = clip;
    this.tCur = 0;
    this.fadeDur = Math.max(0.001, fade);
    this.fade = this.prev ? 0 : 1;
    this.rate = rate;
    this.done = false;
    return true;
  }

  update(dt) {
    const cur = this.cur;
    if (!cur) return;
    this.tCur += dt * this.rate;
    if (this.tCur >= cur.dur) {
      if (cur.loop) this.tCur %= cur.dur;
      else { this.tCur = cur.dur; this.done = true; }
    }
    if (this.prev && this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / this.fadeDur);
      // 淡出层继续播放，避免姿势冻结
      this.tPrev += dt * (this.ratePrev || this.rate);
      if (this.tPrev >= this.prev.dur) {
        this.tPrev = this.prev.loop ? this.tPrev % this.prev.dur : this.prev.dur;
      }
    }
    if (this.prev && this.fade >= 1) this.prev = null;

    const tC = this.tCur, tP = this.tPrev;
    const mix = this.fade;

    for (const b of this.bones) {
      const bind = this._bind.get(b);
      // ---- 采样当前动画（缺轨道用绑定姿态） ----
      let cq = bind.q, dyC = 0, hasC = false;
      const tr = cur.tracks.get(b.name);
      if (tr) {
        hasC = true;
        if (tr.r) {
          const i = findKeys(tr.r, 5, tr.n, tC);
          const a = tr.r, o0 = i * 5, o1 = Math.min(tr.n - 1, i + 1) * 5;
          const t0 = a[o0], t1 = a[o1];
          _qa.set(a[o0 + 1], a[o0 + 2], a[o0 + 3], a[o0 + 4]);
          _qb.set(a[o1 + 1], a[o1 + 2], a[o1 + 3], a[o1 + 4]);
          const u = t1 > t0 ? (tC - t0) / (t1 - t0) : 0;
          cq = _qa.slerp(_qb, u).normalize();
        }
        if (tr.p) {
          const i = findKeys(tr.p, 4, tr.np, tC);
          const a = tr.p, o0 = i * 4, o1 = Math.min(tr.np - 1, i + 1) * 4;
          const t0 = a[o0], t1 = a[o1];
          const u = t1 > t0 ? (tC - t0) / (t1 - t0) : 0;
          dyC = a[o0 + 2] + (a[o1 + 2] - a[o0 + 2]) * u;
        }
      }
      // ---- 采样上一动画（淡出中） ----
      let pq = null, dyP = 0;
      if (this.prev) {
        const pr = this.prev.tracks.get(b.name);
        pq = pr ? null : bind.q;
        if (pr) {
          if (pr.r) {
            const i = findKeys(pr.r, 5, pr.n, tP);
            const a = pr.r, o0 = i * 5, o1 = Math.min(pr.n - 1, i + 1) * 5;
            const t0 = a[o0], t1 = a[o1];
            const q0 = _qa2.set(a[o0 + 1], a[o0 + 2], a[o0 + 3], a[o0 + 4]);
            const q1 = _qb2.set(a[o1 + 1], a[o1 + 2], a[o1 + 3], a[o1 + 4]);
            const u = t1 > t0 ? (tP - t0) / (t1 - t0) : 0;
            pq = q0.slerp(q1, u).normalize();
          } else pq = bind.q;
          if (pr.p) {
            const i = findKeys(pr.p, 4, pr.np, tP);
            const a = pr.p, o0 = i * 4, o1 = Math.min(pr.np - 1, i + 1) * 4;
            const t0 = a[o0], t1 = a[o1];
            const u = t1 > t0 ? (tP - t0) / (t1 - t0) : 0;
            dyP = a[o0 + 2] + (a[o1 + 2] - a[o0 + 2]) * u;
          }
        } else pq = bind.q;
      }
      // ---- 写回 ----
      if (this.prev && pq) {
        b.quaternion.copy(pq).slerp(cq, mix);
        b.position.set(bind.p.x, bind.p.y + dyP * (1 - mix) + dyC * mix, bind.p.z);
      } else {
        b.quaternion.copy(cq);
        if (hasC || this.fade >= 1) b.position.set(bind.p.x, bind.p.y + dyC, bind.p.z);
      }
    }
  }

  get clipName() { return this.cur ? this.cur.name : null; }
}
