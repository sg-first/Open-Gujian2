// entities.js —— 妖兽 / 名牌 / 血条
// 玩家与 NPC 已改用原版 XAC 模型（见 assets.js），这里只保留原版资产里没有的妖兽。
import * as THREE from 'three';

const skinMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0.0, envMapIntensity: 0.6 });

// 名字 / 血条 sprite
export function makeLabelSprite(text, color = '#ffffff', sub = null) {
  const cv = document.createElement('canvas');
  const tall = sub !== null && sub !== undefined;   // 血条名牌需要 96px 高画布
  cv.width = 256; cv.height = tall ? 96 : 56;
  const ctx = cv.getContext('2d');
  ctx.textAlign = 'center';
  ctx.font = '600 30px "Microsoft YaHei", sans-serif';
  ctx.shadowColor = '#000'; ctx.shadowBlur = 6;
  ctx.fillStyle = color;
  ctx.fillText(text, 128, sub ? 38 : 38);
  if (tall) {
    ctx.font = '22px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#d8563f';
    ctx.fillText(sub || '', 128, 76);
    // 血条
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(48, 84, 160, 6);
    ctx.fillStyle = '#d8563f'; ctx.fillRect(49, 85, 158 * 1, 4);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  spr.scale.set(tall ? 1.9 : 1.5, tall ? 0.71 : 0.33, 1);
  spr.renderOrder = 5;
  return spr;
}

export function updateHpSprite(spr, ratio) {
  const cv = spr.material.map.image;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.textAlign = 'center';
  ctx.font = '600 30px "Microsoft YaHei", sans-serif';
  ctx.shadowColor = '#000'; ctx.shadowBlur = 6;
  ctx.fillStyle = '#ffb9a8';
  ctx.fillText(cv.dataset.name || '', 128, 38);
  ctx.font = '20px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#e8e2cf';
  ctx.fillText('Lv.' + (cv.dataset.lvl || 1), 128, 64);
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(48, 74, 160, 10);
  ctx.fillStyle = ratio > 0.5 ? '#6fbf5a' : ratio > 0.25 ? '#d8a53f' : '#d8563f';
  ctx.fillRect(50, 76, 156 * Math.max(0, ratio), 6);
  spr.material.map.needsUpdate = true;
}

// 妖兽：低多边形四足
export function buildBeast(color = 0x5a4a6a, scale = 1) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.7, 4, 8), skinMat(color));
  body.rotation.z = Math.PI / 2; body.position.y = 0.62; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), skinMat(color));
  head.position.set(0, 0.78, 0.62); g.add(head);
  const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.3, 6), skinMat(0xd8cfb8));
  horn.position.set(0, 1.05, 0.62); g.add(horn);
  const eyeM = new THREE.MeshBasicMaterial({ color: 0xff5030 });
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), eyeM);
    eye.position.set(s * 0.12, 0.84, 0.82); g.add(eye);
  }
  const legs = [];
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.045, 0.5, 6), skinMat(color));
    leg.position.set(sx * 0.2, 0.28, sz * 0.32); g.add(leg);
    legs.push(leg);
  }
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.5, 6), skinMat(color));
  tail.position.set(0, 0.7, -0.6); tail.rotation.x = -2.2; g.add(tail);
  g.scale.setScalar(scale);
  return { group: g, legs, body };
}

export function animateBeast(beast, speed, t) {
  const s = Math.min(speed / 4, 1.5);
  const f = t * (5 + s * 5);
  beast.legs.forEach((leg, i) => {
    leg.rotation.x = Math.sin(f + (i % 2 ? Math.PI : 0) + (i > 1 ? Math.PI / 2 : 0)) * (0.2 + s * 0.5);
  });
  beast.body.position.y = 0.62 + Math.abs(Math.sin(f)) * 0.03 * s;
}
