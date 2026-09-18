// main.js —— 开放世界主循环
import * as THREE from 'three';
import { World, CHUNK, createWater, createSky, vegTime, mulberry } from './world.js';
import { makeChar, preloadChars, loadCharProto, loadProps, makeProp, G_PROPS } from './assets.js';
import { buildBeast, animateBeast, makeLabelSprite, updateHpSprite } from './entities.js';
import { loadAnims, AnimPlayer } from './anim.js';
import { loadEnv } from './env.js';

const $ = (id) => document.getElementById(id);
const V3 = THREE.Vector3;

// ================= 全局状态 =================
const G = {
  meta: null, world: null, scene: null, camera: null, renderer: null,
  water: null, sky: null, sun: null,
  player: null, keys: {}, yaw: 0.6, pitch: 0.32, dist: 9,
  camDrag: false, monsters: [], pickups: [], npcs: [],
  timeOfDay: 0.32,          // 0..1
  state: 'title',           // title | play
  nearNPC: null, nearPickup: null,
  quests: {}, inventory: {}, stats: null,
  attackCd: 0, skillCd: 0, dialogOpen: false, panelOpen: null,
  kills: 0, discovered: new Set(),
  cfg: {},
};
window.G = G;   // 调试用

// 全部使用 RPGproject/Characters 下的原版 XAC 模型。
// 106 在原始资源里是一具非人形的巨型物件（无 Bip01 骨骼、包围盒上千米），
// 不能当人形 NPC 用，故 106 的立绘/台词保留、模型改用 107 的本体。
const NPC_DEFS = [
  { id: '101', model: '101', name: '百里屠苏', face: 'assets/ui/face/face_101.png', role: '剑客', line: '此山妖气渐重……阁下若要北上断霄岭，务必先备足伤药。' },
  { id: '102', model: '102', name: '风晴雪', face: 'assets/ui/face/face_102.png', role: '药者', line: '禾风平原的灵草长势正好。替我采八株来，我教你炼药的门户。' },
  { id: '103', model: '103', name: '襄铃', face: 'assets/ui/face/face_103.png', role: '小狐', line: '镜湖底有沉星碎片！下水记得换气，别学襄铃呛水呀。' },
  { id: '104', model: '104', name: '方兰生', face: 'assets/ui/face/face_104.png', role: '书生', line: '青萝谷的石碑上刻着古字，念出来竟会发光，奇哉怪哉！' },
  { id: '105', model: '105', name: '红玉', face: 'assets/ui/face/face_105.png', role: '剑灵', line: '夜行山谷要多加小心——妖兽趁月而出，剑要握稳。' },
  { id: '106', model: '107', name: '尹千觞', face: 'assets/ui/face/face_106.png', role: '酒客', line: '哈！又见面了。赤岩荒原的妖兽最是凶悍，先喝一口压压惊。' },
  { id: '107', model: '107', name: '沈夜', face: 'assets/ui/face/face_107.png', role: '祭司', line: '沧澜之巅终年积雪，那里藏着这座山河最初的秘密。' },
];
const CHAR_IDS = ['101', '102', '103', '104', '105', '107'];
const PLAYER_MODEL = '101';

const QUESTS = [
  { id: 'explore', name: '踏遍九域', desc: '寻访九处地域（{n}/9）', target: 9, reward: '称号·行山人' },
  { id: 'herbs', name: '灵草八株', desc: '采集灵草（{n}/8），交付风晴雪', target: 8, reward: '伤药×5、修为+120' },
  { id: 'hunt', name: '讨伐妖兽', desc: '击败妖兽（{n}/10）', target: 10, reward: '修为+200' },
];

const SKILLS = [
  { key: 'J', name: '挥剑', cd: 0.55, dmg: 42, range: 3.6, arc: 1.6 },
  { key: 'K', name: '气刃', cd: 5.0, dmg: 90, range: 8.0, arc: 0.6, ranged: true },
];

// ================= 启动 =================
boot();

async function boot() {
  try {
    window.__step = 'meta';
    setLoad(5, '读取世界档案…');
    const meta = await (await fetch('./assets/world.meta.json')).json();
    G.meta = meta;
    window.__step = 'heights';
    setLoad(15, '展开山河地形…');
    const buf = await fetchBin('./assets/world.heights.bin', (p) => setLoad(15 + p * 55, '展开山河地形…'));
    const u16 = new Uint16Array(buf);
    const heights = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) heights[i] = meta.hmin + (u16[i] / 65535) * (meta.hmax - meta.hmin);
    window.__step = 'colormap';

    setLoad(72, '绘制大地颜色…');
    const loader = new THREE.TextureLoader();
    const colormapTex = await loader.loadAsync('./assets/world.colormap.png');
    colormapTex.colorSpace = THREE.SRGBColorSpace;
    colormapTex.anisotropy = 8;
    // 地形 UV 的 v 直接等于 (z-originZ)/worldH，图像行号也按 z 递增，
    // 因此必须翻转 flipY，否则整张地表图会南北镜像。
    colormapTex.flipY = false;
    colormapTex.needsUpdate = true;

    // 原版地形法线图（Maps/<map>/TerrainData/AuxiliaryTextures 逐 sector 拼合）
    let terrainNrm = null;
    try {
      terrainNrm = await loader.loadAsync('./assets/terrain.normal.png');
      terrainNrm.flipY = false;
      terrainNrm.colorSpace = THREE.NoColorSpace;
      terrainNrm.wrapS = terrainNrm.wrapT = THREE.ClampToEdgeWrapping;
      terrainNrm.anisotropy = 4;
      terrainNrm.needsUpdate = true;
      setLoad(74, '叠上山石纹路…');
    } catch (e) { console.warn('terrain normal missing', e); }

    const detailTex = {};
    for (const n of ['dirt', 'stone', 'slab']) {
      try {
        const t = await loader.loadAsync(`./assets/terrain/${n}.png`);
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 8;
        detailTex[n] = t;
      } catch (e) { /* 可选资源 */ }
    }

    // 原版环境：光照 / 雾 / 天空 / 水面（来自各图 vscene）
    try { G.env = await loadEnv(); } catch (e) { console.warn('env.json missing', e); }
    window.__step = 'scene';

    setLoad(76, '汇聚草木生灵…');
    preloadIcons();
    initScene(meta, heights, colormapTex, terrainNrm, detailTex);

    window.__step = 'chars';
    setLoad(80, '唤醒故人身影…');
    await preloadChars(CHAR_IDS);
    window.__step = 'anims';
    setLoad(84, '传授举止身法…');
    G.anims = await loadAnims(['idle', 'walk', 'run', 'sprint', 'attack', 'jump']);
    window.__step = 'props';
    setLoad(88, '搬来屋舍桥梁…');
    G.props = null;
    try { G.props = await loadProps(); }
    catch (e) { console.warn('props load fail', e); }

    window.__step = 'spawn';
    setLoad(93, '铺陈人间烟火…');
    spawnActors();
    window.__step = 'done';
    setLoad(96, '落笔…');

    // 存档检查
    if (localStorage.getItem('shx.save')) $('btnCont').classList.remove('dis');
    $('loading').style.display = 'none';
    $('title').style.display = 'flex';
    setLoad(100, '');
  } catch (err) {
    window.__err = String(err && err.stack || err);
    $('loadTxt').textContent = '加载失败: ' + window.__err;
    $('loadTxt').style.color = '#ff8a7a';
    console.error(err);
  }
}

async function fetchBin(url, onProgress) {
  const resp = await fetch(url);
  const total = +resp.headers.get('Content-Length') || 8400;
  const reader = resp.body.getReader();
  const chunks = []; let got = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

function setLoad(p, txt) {
  $('barIn').style.width = p + '%';
  if (txt) $('loadTxt').textContent = txt;
}

async function preloadIcons() {
  const ui = G.meta.ui;
  G.cfg.items = []; G.cfg.monsters = []; G.cfg.skills = []; G.cfg.story = [];
  const test = new Image();
  for (let i = 0; i < ui.items; i++) G.cfg.items.push(`assets/ui/item/item_${String(i).padStart(2, '0')}.png`);
  for (let i = 0; i < ui.monsters; i++) G.cfg.monsters.push(`assets/ui/monster/mon_${String(i).padStart(2, '0')}.png`);
  for (let i = 0; i < ui.skills; i++) G.cfg.skills.push(`assets/ui/skill/skill_${String(i).padStart(2, '0')}.png`);
  for (let i = 0; i < ui.story; i++) G.cfg.story.push(`assets/ui/story/story_${String(i).padStart(2, '0')}.png`);
  G.cfg.faces = NPC_DEFS.map(n => n.face);
}

// ================= 场景 =================
function initScene(meta, heights, colormapTex, terrainNrm, detailTex) {
  const scene = new THREE.Scene();
  G.scene = scene;
  G.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 12000);
  G.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  G.renderer.setSize(innerWidth, innerHeight);
  G.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  G.renderer.outputColorSpace = THREE.SRGBColorSpace;
  $('app').appendChild(G.renderer.domElement);

  const world = new World(meta, heights, colormapTex);
  G.world = world;

  // 地表：受光材质 + 原版法线图 + 原版石作/泥土平铺细节。
  // colormap 负责大尺度色相（雪线、岸线、区域色调），细节贴图负责近景质感。
  world.terrainMat = new THREE.MeshLambertMaterial({ map: colormapTex });
  if (terrainNrm) world.terrainMat.normalMap = terrainNrm;
  world.terrainMat.normalScale = new THREE.Vector2(2.1, 2.1);
  {
    const d1 = detailTex.dirt, d2 = detailTex.stone, d3 = detailTex.slab;
    world.terrainMat.onBeforeCompile = (sh) => {
      sh.uniforms.uDirt = { value: d1 };
      sh.uniforms.uStone = { value: d2 };
      sh.uniforms.uSlab = { value: d3 };
      sh.uniforms.uSea = { value: world.sea };
      sh.vertexShader = `attribute float aSlope;\nattribute float aAlt;\n
        varying vec3 vWp;\n varying float vSlope;\n varying float vAlt;\n` + sh.vertexShader
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n vWp = position;\n vSlope = aSlope;\n vAlt = aAlt;');
      sh.fragmentShader = `
        uniform sampler2D uDirt, uStone, uSlab;
        uniform float uSea;
        varying vec3 vWp; varying float vSlope; varying float vAlt;
      ` + sh.fragmentShader
        .replace('#include <map_fragment>',
          `#include <map_fragment>
           // 坡度分层：缓坡=土/草，陡坡=石作，高处=石板
           float rock = smoothstep(0.26, 0.70, vSlope);
           float alp  = smoothstep(0.80, 0.96, vAlt - rock * 0.05);
           vec3 c1 = texture2D(uDirt,  vWp.xz * 0.0345).rgb;
           vec3 c1b= texture2D(uDirt,  vWp.zx * 0.0417).rgb;    // 转 90° 打破单一走向
           c1 = mix(c1, c1b, 0.5);
           vec3 c2 = texture2D(uStone, vWp.xz * 0.0750).rgb;
           vec3 c2b= texture2D(uStone, vWp.zx * 0.0930).rgb;
           c2 = mix(c2, c2b, 0.5);
           vec3 c3 = texture2D(uSlab,  vWp.xz * 0.1250).rgb;
           vec3 c4 = texture2D(uDirt,  vWp.xz * 0.2900).rgb;   // 近景高频
           vec3 det = mix(c1, c2, rock);
           det = mix(det, mix(c2, c3, 0.35), alp);             // 高处主要是裸岩，不是铺装
           det = mix(det, det * (0.55 + 0.9 * dot(c4, vec3(0.333))), 0.35);
           float dl = max(0.20, dot(det, vec3(0.299,0.587,0.114)));
           vec3 base = diffuseColor.rgb;
           float bl = max(0.06, dot(base, vec3(0.299,0.587,0.114)));
           vec3 mod = det / dl;                       // 贴图色彩（均值 1）
           // 1) 保留 colormap 的大尺度色相（草绿/沙黄/雪白），叠上原版贴图的纹理
           diffuseColor.rgb = base * mix(vec3(1.0), mod, 0.75)
                                   * mix(1.0, clamp(dl / 0.42, 0.55, 1.55), 0.60);
           // 2) 陡坡与高处换成真实石作的颜色，让山体不再是"涂绿的纸"
           vec3 stoneHue = mod * bl;
           diffuseColor.rgb = mix(diffuseColor.rgb, stoneHue,
                                  clamp(rock * 0.55 + alp * 0.50, 0.0, 0.75));
           // 3) 岸线：贴水面的滩涂压暖
           float shore = 1.0 - smoothstep(0.0, 3.0, vWp.y - uSea);
           diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.20,1.06,0.82), shore*0.65);
           `);
    };
  }
  scene.add(world.group);

  const env0 = G.env ? G.env.raw(meta.regions[0].name, G.timeOfDay * 24) : null;
  G.water = createWater(world, env0);
  scene.add(G.water.mesh);

  G.sky = createSky(scene);

  G.sun = new THREE.DirectionalLight(0xffffff, 1.6);
  scene.add(G.sun);
  G.sun.target.position.set(0, 0, 0);
  scene.add(G.sun.target);
  G.ambient = new THREE.AmbientLight(0xbfd0e0, 0.9);
  scene.add(G.ambient);
  G.hemi = new THREE.HemisphereLight(0x9db8d2, 0x3a4a33, 0.7);
  scene.add(G.hemi);

  scene.fog = new THREE.Fog(0xa8bdd0, 500, 5200);

  addEventListener('resize', () => {
    G.camera.aspect = innerWidth / innerHeight;
    G.camera.updateProjectionMatrix();
    G.renderer.setSize(innerWidth, innerHeight);
  });
  bindInput();
}

// 原版模型加载完成后统一生成玩家 / NPC / 建筑 / 妖兽 / 采集点
function spawnActors() {
  const meta = G.meta;

  // 玩家(在主区域找一块平地出生)
  const main = meta.regions[0];
  const rng = mulberry(42);
  let sx = main.cx, sz = main.cz, best = -1;
  for (let t = 0; t < 200; t++) {
    const x = main.cx + (rng() - 0.5) * main.w * 0.6;
    const z = main.cz + (rng() - 0.5) * main.h * 0.6;
    const h = G.world.heightAt(x, z), sl = G.world.slopeAt(x, z);
    if (h > G.world.sea + 3 && sl < 0.18) {
      const score = -sl * 100 - Math.abs(h - 30) * 0.05 - Math.hypot(x - main.cx, z - main.cz) * 0.002;
      if (score > best) { best = score; sx = x; sz = z; }
    }
  }
  spawnPlayer(sx, sz);

  spawnNPCs();
  spawnProps();
  spawnMonsterCamps();
  spawnPickups();
}

function spawnPlayer(x, z) {
  const ch = makeChar(PLAYER_MODEL);
  if (!ch) { console.error('player model missing'); return; }
  ch.group.position.set(x, G.world.heightAt(x, z), z);
  G.scene.add(ch.group);
  const ap = new AnimPlayer(ch.parts, G.anims);
  ap.setSpeed(0);
  ch.group.rotation.order = 'YXZ';    // 先偏航再俯仰/侧倾(倾斜在角色自身坐标系内)
  G.player = {
    obj: ch.group, parts: ch.parts, height: ch.height, ap,
    speed: 0, vy: 0, grounded: true,
    hp: 180, maxHp: 180, xp: 0, lvl: 1, xpNext: 100,
    attackT: 0, swim: false, alive: true, yawFace: 0,
  };
}

function spawnNPCs() {
  const regions = G.meta.regions;
  regions.forEach((r, i) => {
    const def = NPC_DEFS[i % NPC_DEFS.length];
    // 在区域内找一块平地
    const rng = mulberry(i * 7919 + 3);
    let bx = r.cx, bz = r.cz, bh = -1e9;
    for (let t = 0; t < 60; t++) {
      const x = r.cx + (rng() - 0.5) * r.w * 0.7;
      const z = r.cz + (rng() - 0.5) * r.h * 0.7;
      const h = G.world.heightAt(x, z);
      const sl = G.world.slopeAt(x, z);
      if (h > G.world.sea + 2 && sl < 0.25 && h > bh) { bh = h; bx = x; bz = z; }
    }
    const ch = makeChar(def.model);
    if (!ch) return;
    ch.group.position.set(bx, G.world.heightAt(bx, bz), bz);
    // 模型前方为局部 -Z，故取反使 NPC 面朝出生点
    ch.group.rotation.y = Math.atan2(bx - G.meta.spawn[0], bz - G.meta.spawn[1]);
    G.scene.add(ch.group);
    const label = makeLabelSprite(def.name, '#ffe9ad', def.role);
    // 角色整体被缩放到 0.01，名牌要保持世界尺寸，需要反向补偿
    const s = ch.group.scale.x || 1;
    label.scale.set(1.9 / s, 0.71 / s, 1);
    label.position.y = (ch.height + 0.55) / s;
    ch.group.add(label);
    // 原版待机动画（呼吸/重心变化），各角色共用 Bip01 骨架命名
    const ap = new AnimPlayer(ch.parts, G.anims);
    ap.setSpeed(0);
    G.npcs.push({ def, obj: ch.group, parts: ch.parts, ap, region: r.name, pos: new V3(bx, 0, bz), questGiven: false });
  });
}

// ---- 原版场景资产：按区域匹配建筑目录，以「聚落」方式成簇摆放 ----
// 对应 build_props.py 的 index.json: region 字段 + regionBuildings/shared 映射。
function spawnProps() {
  if (!G.props || !G.props.length) return;
  const rng = mulberry(88991);
  const rb = G_PROPS.regionBuildings || {};
  const shared = G_PROPS.shared || [];
  // 按 region(目录) 归类可用建筑
  const byDir = new Map();
  for (const p of G.props) {
    const s = p.size;
    const w = Math.max(s[0], s[2]);
    if (w < 1.5 || w > 55) continue;                        // 太碎 / 跨度过大
    if (s[1] < 0.6 || s[1] > 60) continue;                  // 太扁 / 太高
    if (w > 16 && s[1] < w * 0.10) continue;                // 扁宽「地面片」：当建筑摆会浮空
    if (!byDir.has(p.region)) byDir.set(p.region, []);
    byDir.get(p.region).push(p);
  }
  const poolOf = (regionName) => {
    // 地图名 n01p1 -> 建筑目录 n01
    const code = regionName.replace(/(p\d+|[a-z])$/, '');
    const dirs = (rb[regionName] || rb[code] || []).concat(shared);
    const out = [];
    for (const d of dirs) {
      const arr = byDir.get(d);
      if (arr && arr.length) out.push(...arr);
    }
    return out;
  };

  // 可用的平地采样：返回 {x,z,h,slope} 或 null
  const sampleFlat = (r, rng, wSpan, hSpan, maxSlope) => {
    for (let t = 0; t < 40; t++) {
      const x = r.cx + (rng() - 0.5) * r.w * wSpan;
      const z = r.cz + (rng() - 0.5) * r.h * hSpan;
      const h = G.world.heightAt(x, z);
      if (h > G.world.sea + 1.5 && G.world.slopeAt(x, z) < maxSlope) return { x, z, h };
    }
    return null;
  };

  const place = (prop, x, z, rot, k) => {
    const m = makeProp(prop);
    m.position.set(x, G.world.heightAt(x, z) - 0.35, z);
    m.rotation.y = rot;
    m.scale.setScalar(k);
    G.scene.add(m);
    (G.propObjs || (G.propObjs = [])).push(m);
    return m;
  };

  let placed = 0;
  for (const r of G.meta.regions) {
    const pool = poolOf(r.name);
    if (!pool.length) continue;
    // 体量分层：大件做主体，中件做配殿，小件做附属
    const big = pool.filter((p) => Math.max(p.size[0], p.size[2]) >= 12);
    const mid = pool.filter((p) => { const w = Math.max(p.size[0], p.size[2]); return w >= 5 && w < 12; });
    const sml = pool.filter((p) => Math.max(p.size[0], p.size[2]) < 5);
    const tier = (arr, fb) => (arr.length ? arr : (fb && fb.length ? fb : pool));

    // ---- 1) 3~4 个聚落：中心一栋大主体，外围环绕中小件，朝向中心 ----
    const nVillage = 3 + (rng() < 0.5 ? 0 : 1);
    for (let v = 0; v < nVillage; v++) {
      const c = sampleFlat(r, rng, 0.62, 0.62, 0.22);
      if (!c) continue;
      (G.villages || (G.villages = [])).push({ region: r.name, x: c.x, z: c.z });
      const core = tier(big, mid)[Math.floor(rng() * tier(big, mid).length)];
      const coreW = Math.max(core.size[0], core.size[2]);
      place(core, c.x, c.z, rng() * Math.PI * 2, 0.9 + rng() * 0.3);
      placed++;
      const nOut = 7 + Math.floor(rng() * 6);
      let ring = 0, slot = 0;
      const r0 = Math.max(18, coreW * 0.85);
      for (let i = 0; i < nOut; i++) {
        if (slot >= 5 + ring * 2) { ring++; slot = 0; }      // 一圈放满再扩一圈
        const ang = (slot / (5 + ring * 2)) * Math.PI * 2 + rng() * 0.5;
        slot++;
        const rad = r0 + ring * 15 + rng() * 8;              // 米
        const px = c.x + Math.cos(ang) * rad, pz = c.z + Math.sin(ang) * rad;
        const h = G.world.heightAt(px, pz);
        if (h < G.world.sea + 1.2 || G.world.slopeAt(px, pz) > 0.38) continue;
        const src = (rng() < 0.55 && mid.length) ? mid : (sml.length ? sml : tier(mid, big));
        const prop = src[Math.floor(rng() * src.length)];
        // 面朝村落中心
        place(prop, px, pz, Math.atan2(c.x - px, c.z - pz) + (rng() - 0.5) * 0.4,
              0.85 + rng() * 0.35);
        placed++;
      }
    }

    // ---- 2) 沿路散点：小件贴着地势零星分布，避免大片空地 ----
    const nScatter = 8 + Math.floor(rng() * 6);
    for (let i = 0; i < nScatter; i++) {
      const c = sampleFlat(r, rng, 0.9, 0.9, 0.26);
      if (!c) continue;
      const prop = (sml.length ? sml : pool)[Math.floor(rng() * (sml.length || pool.length))];
      place(prop, c.x, c.z, rng() * Math.PI * 2, 0.8 + rng() * 0.5);
      placed++;
    }
  }
  console.log('[props] placed', placed, 'from', G.props.length);
}

const CAMPS_PER_REGION = 3;
function spawnMonsterCamps() {
  const rng = mulberry(20260918);
  const palettes = [
    [0x5a4a6a, 0xd8cfb8], [0x6a3a2a, 0xd8b06a], [0x2f5a4a, 0xcfe0c8],
    [0x8a5a2a, 0xe8d9b0], [0x44506a, 0xb8c8d8],
  ];
  for (const r of G.meta.regions) {
    for (let c = 0; c < CAMPS_PER_REGION; c++) {
      let mx = r.cx, mz = r.cz, ok = false;
      for (let t = 0; t < 80; t++) {
        const x = r.cx + (rng() - 0.5) * r.w * 0.85;
        const z = r.cz + (rng() - 0.5) * r.h * 0.85;
        const h = G.world.heightAt(x, z);
        if (h > G.world.sea + 1.5 && G.world.slopeAt(x, z) < 0.4) { mx = x; mz = z; ok = true; break; }
      }
      if (!ok) continue;
      const n = 2 + Math.floor(rng() * 3);
      for (let k = 0; k < n; k++) {
        const pal = palettes[Math.floor(rng() * palettes.length)];
        const x = mx + (rng() - 0.5) * 26, z = mz + (rng() - 0.5) * 26;
        const h = G.world.heightAt(x, z);
        if (h < G.world.sea + 1) continue;
        const lvl = 1 + Math.floor(rng() * 3) + (r.biome === 'mountain' ? 2 : 0);
        const { group, legs, body } = buildBeast(pal[0], 0.9 + rng() * 0.7);
        group.position.set(x, h, z);
        G.scene.add(group);
        const spr = makeLabelSprite('', '#fff', '');
        spr.material.map.image.dataset.name = beastName(rng);
        spr.material.map.image.dataset.lvl = lvl;
        spr.position.y = 1.6 * group.scale.y + 0.9;
        group.add(spr);
        const m = {
          obj: group, legs, body, spr, lvl,
          hp: 60 + lvl * 30, maxHp: 60 + lvl * 30,
          dmg: 6 + lvl * 4, speed: 0, state: 'idle',
          home: new V3(x, h, z), target: new V3(x, h, z),
          think: 0, atkCd: 0, icon: G.cfg.monsters[Math.floor(rng() * G.cfg.monsters.length)],
          xp: 30 + lvl * 22,
        };
        updateHpSprite(spr, 1);
        G.monsters.push(m);
      }
    }
  }
}

function beastName(rng) {
  const a = ['赤', '幽', '玄', '霜', '岚', '墨', '苍', '血'];
  const b = ['狼', '豹', '罴', '蛟', '狐', '兕', '魈', '熊'];
  return a[Math.floor(rng() * a.length)] + b[Math.floor(rng() * b.length)];
}

const PICKUP_KINDS = [
  { kind: 'herb', name: '灵草', iconIdx: 0, tint: 0x7fc86a },
  { kind: 'ore', name: '云母石', iconIdx: 1, tint: 0xb8c8d8 },
  { kind: 'treasure', name: '古物', iconIdx: 2, tint: 0xe8c86a },
];
function spawnPickups() {
  const rng = mulberry(555);
  const loader = new THREE.TextureLoader();
  for (const r of G.meta.regions) {
    const n = 10 + Math.floor(rng() * 8);
    for (let i = 0; i < n; i++) {
      let x, z, h;
      for (let t = 0; t < 40; t++) {
        x = r.cx + (rng() - 0.5) * r.w * 0.9;
        z = r.cz + (rng() - 0.5) * r.h * 0.9;
        h = G.world.heightAt(x, z);
        if (h > G.world.sea + 1 && G.world.slopeAt(x, z) < 0.45) break;
      }
      if (h === undefined || h < G.world.sea + 1) continue;
      const kind = PICKUP_KINDS[Math.floor(rng() * PICKUP_KINDS.length)];
      const icon = `assets/ui/item/item_${String(Math.floor(rng() * G.meta.ui.items)).padStart(2, '0')}.png`;
      // 地表标记: 光柱 + 环
      const grp = new THREE.Group();
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: kind.tint, transparent: true, opacity: 0.4, depthWrite: false }));
      beam.position.y = 1.6; grp.add(beam);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.45, 0.035, 6, 20),
        new THREE.MeshBasicMaterial({ color: kind.tint }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.1; grp.add(ring);
      const tex = loader.load(icon);
      tex.colorSpace = THREE.SRGBColorSpace;
      const ico = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true }));
      ico.scale.set(0.8, 0.8, 1); ico.position.y = 1.1; grp.add(ico);
      grp.position.set(x, h, z);
      G.scene.add(grp);
      G.pickups.push({ obj: grp, kind: kind.kind, name: kind.name, icon, ring, beam, taken: false });
    }
  }
}

// ================= 玩家更新 =================
const _f = new V3(), _r = new V3(), _np = new V3();

// 移动速度 = 动画原生步速（tools/probe_stride.js 在渲染环境实测：跑 4.18 / 冲刺 6.33 m/s）。
// 播放速率 = 实际速度／原生步速，故在原生速度下速率为 1.0：步频自然、支撑脚零漂移。
const MOVE_SPEED = 4.2;
const SPRINT_SPEED = 6.3;

function updatePlayer(dt) {
  const p = G.player, w = G.world;
  if (!p.alive) return;
  // 目标速度（含游泳减速）
  let target = (G.keys['shift'] ? SPRINT_SPEED : MOVE_SPEED) * (p.swim ? 0.55 : 1);
  let ix = 0, iz = 0;
  if (G.keys['w']) iz -= 1; if (G.keys['s']) iz += 1;
  if (G.keys['a']) ix -= 1; if (G.keys['d']) ix += 1;
  const moving = ix || iz;
  if (!moving) target = 0;
  if (!p.grounded && !p.swim) target *= 0.85;      // 空中略减速

  // 平滑加减速（起步/收步不再瞬时切换；步态混合空间与播放速率随速度连续变化，
  // 任意速度下脚的落地速度都与位移匹配，因此加减速全程不打滑）
  const accel = (p.grounded ? (target > p.speed ? 11 : 13) : 5) * dt;
  p.speed += Math.max(-accel, Math.min(accel, target - p.speed));
  if (p.speed < 0.02) p.speed = 0;

  let turnRate = 0;
  if (moving) {
    // 屏幕方向映射：W 朝屏幕内(远离相机)、D 朝屏幕右，A/S 同理。
    // (原实现把 W 映射成"朝相机走"，导致世界朝屏幕内滚动、观感别扭)
    const a = Math.atan2(-ix, -iz);
    const dir = G.yaw + a;
    _f.set(Math.sin(dir), 0, Math.cos(dir));
    // 原版模型视觉前方为局部 -Z：偏航要按 -Z 对齐行进方向，
    // 否则角色背对行进方向(月球漫步)，脚部也会相对地面打滑 2 倍。
    p.yawFace = Math.atan2(-_f.x, -_f.z);
    if (p.speed > 0) p.obj.position.addScaledVector(_f, p.speed * dt);
  }
  // 平滑转身：角色朝向快速插值到移动方向，避免瞬时掉头
  {
    let d = p.yawFace - p.obj.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const step = d * Math.min(1, dt * 12);
    p.obj.rotation.y += step;
    turnRate = dt > 0 ? step / dt : 0;
  }

  // 地形 / 游泳
  const x = p.obj.position.x, z = p.obj.position.z;
  const gh = w.heightAt(x, z);
  const inWater = gh < w.sea - 0.9;
  p.swim = inWater;
  if (inWater) {
    const targetY = w.sea - 0.75;
    p.obj.position.y += (targetY - p.obj.position.y) * Math.min(1, dt * 6);
    p.vy = 0; p.grounded = true;
  } else {
    if (p.grounded && G.keys[' ']) {
      p.vy = 8.2; p.grounded = false;
      if (p.ap) p.ap.playAction('jump', { fadeIn: 0.06, fadeOut: 0.18, rate: 1.1, hold: true });
    }
    p.vy -= 22 * dt;
    p.obj.position.y += p.vy * dt;
    const floor = gh;
    if (p.obj.position.y <= floor) {
      if (!p.grounded && p.ap) p.ap.releaseAction();     // 落地：释放跳跃动作，混合回步态
      p.obj.position.y = floor; p.vy = 0; p.grounded = true;
    }
  }
  // 游泳时压低动作权重，让身体贴着水面
  if (p.swim) p.obj.position.y += Math.sin(perfNow() * 1.6) * 0.02;

  // ---- 动画：速度直接驱动步态混合空间，动作层另行上覆 ----
  const ap = p.ap;
  if (ap) {
    ap.setSpeed(p.speed);
    ap.update(dt);
  }

  // ---- 身体倾斜(ALS lean)：加速前倾 + 转向侧倾，动态细微 ----
  // 模型前方为 -Z：前倾 = rotation.x 取负，转向内侧倾 = rotation.z 与偏航速率同号
  {
    const accNow = (p.speed - (p.lastSpeed || 0)) / Math.max(dt, 1e-4);
    p.leanA = (p.leanA || 0) + (THREE.MathUtils.clamp(-accNow * 0.008, -0.12, 0.12) - (p.leanA || 0)) * Math.min(1, dt * 4);
    p.leanT = (p.leanT || 0) + (THREE.MathUtils.clamp(turnRate * 0.5, -0.12, 0.12) - (p.leanT || 0)) * Math.min(1, dt * 5);
    const air = (!p.grounded && !p.swim) ? 0.4 : 1;
    p.obj.rotation.x = p.leanA * air;
    p.obj.rotation.z = p.leanT * air;
    p.lastSpeed = p.speed;
  }

  // 攻击输入
  G.attackCd = Math.max(0, G.attackCd - dt);
  G.skillCd = Math.max(0, G.skillCd - dt);

  // 脱战回气：4 秒未受伤则以 16/s 回复
  if (p.alive && p.hp < p.maxHp && perfNow() - (G.lastHurt ?? -1e9) > 4) {
    p.hp = Math.min(p.maxHp, p.hp + 16 * dt);
    G.regenAcc = (G.regenAcc || 0) + dt;
    if (G.regenAcc > 0.25) { G.regenAcc = 0; refreshStats(); }
  }

  // 区域发现
  const reg = w.regionAt(x, z);
  if (reg && !G.discovered.has(reg.name)) {
    G.discovered.add(reg.name);
    announceRegion(reg.disp);
    addXp(40);
    saveGame();
  } else if (reg) {
    $('hint').dataset.region = reg.name;
  }
}

function tryAttack(ranged) {
  const p = G.player;
  if (!p.alive || G.attackCd > 0 || (ranged && G.skillCd > 0)) return;
  const sk = ranged ? SKILLS[1] : SKILLS[0];
  G.attackCd = sk.cd; if (ranged) G.skillCd = sk.cd;
  // 原版剑法动画：作为上覆动作播放，结束自动混回步态
  if (p.ap) p.ap.playAction('attack', { fadeIn: 0.05, fadeOut: 0.16, rate: ranged ? 1.5 : 1.9 });
  // 软锁定：出手前自动转向身周最近的目标，避免"背对着打空气"
  let near = null, nd = 1e9;
  for (const m of G.monsters) {
    if (m.dead || m.hp <= 0) continue;
    const dd = m.obj.position.distanceTo(p.obj.position);
    if (dd <= sk.range + 2.2 && dd < nd) { nd = dd; near = m; }
  }
  if (near) {
    const t = near.obj.position.clone().sub(p.obj.position); t.y = 0;
    if (t.lengthSq() > 1e-4) p.obj.rotation.y = Math.atan2(-t.x, -t.z);
  }
  // 模型前方 = 局部 -Z
  const fwd = new V3(-Math.sin(p.obj.rotation.y), 0, -Math.cos(p.obj.rotation.y));
  let hitAny = false;
  for (const m of G.monsters) {
    if (m.dead || m.hp <= 0) continue;
    const d = m.obj.position.clone().sub(p.obj.position);
    const dist = d.length();
    if (dist > sk.range + 1.2) continue;
    d.y = 0; d.normalize();
    if (d.dot(fwd) < Math.cos(sk.arc)) continue;
    hitAny = true;
    damageMonster(m, sk.dmg + p.lvl * 4, m.obj.position.clone().add(new V3(0, 1.5, 0)));
  }
  if (!hitAny) sfx('miss');
  else sfx('hit');
}

function damageMonster(m, dmg, at) {
  m.hp -= dmg;
  m.state = 'chase';
  showDmg(at, dmg);
  updateHpSprite(m.spr, m.hp / m.maxHp);
  if (m.hp <= 0) killMonster(m);
}

function killMonster(m) {
  G.scene.remove(m.obj);
  m.dead = true;
  G.kills++;
  G.quests.hunt = (G.quests.hunt || 0) + 1;
  addXp(m.xp);
  toast(`击败 ${m.spr.material.map.image.dataset.name}　修为 +${m.xp}`);
  // 掉落
  const rng = mulberry(Date.now() & 0xffff);
  if (rng() < 0.65) {
    const icon = G.cfg.items[Math.floor(rng() * G.cfg.items.length)];
    addItem({ icon, name: '妖兽遗物', n: 1 });
  }
  updateTracker();
  saveGame();
}

function addXp(n) {
  const p = G.player;
  p.xp += n;
  while (p.xp >= p.xpNext) {
    p.xp -= p.xpNext; p.lvl++;
    p.xpNext = Math.floor(p.xpNext * 1.45);
    p.maxHp += 18; p.hp = p.maxHp;
    toast(`境界提升！当前第 ${p.lvl} 重`);
    sfx('level');
  }
  refreshStats();
}

function damagePlayer(dmg, from) {
  const p = G.player;
  if (!p.alive) return;
  p.hp -= dmg;
  G.lastHurt = perfNow();
  $('hurt').style.opacity = 0.9;
  setTimeout(() => $('hurt').style.opacity = 0, 260);
  showDmg(p.obj.position.clone().add(new V3(0, 2, 0)), dmg, '#ff7a6a');
  refreshStats();
  if (p.hp <= 0) {
    p.hp = 0; p.alive = false;
    toast('力竭倒下……已被故人救回');
    setTimeout(() => {
      const r = G.world.regionAt(p.obj.position.x, p.obj.position.z) || G.meta.regions[0];
      p.obj.position.set(r.cx, G.world.heightAt(r.cx, r.cz) + 1, r.cz);
      p.hp = Math.floor(p.maxHp * 0.6); p.alive = true;
      refreshStats();
    }, 1600);
  }
}

// ================= 妖兽 AI =================
function updateMonsters(dt) {
  const p = G.player;
  for (const m of G.monsters) {
    if (m.dead) continue;
    const d = p.obj.position.distanceTo(m.obj.position);
    if (d > 600) { m.obj.visible = false; continue; }
    m.obj.visible = true;
    m.think -= dt; m.atkCd -= dt;
    const aggro = 19, deaggro = 70;
    if (m.state === 'idle' && d < aggro && p.alive) m.state = 'chase';
    if (m.state === 'chase' && (d > deaggro || !p.alive)) m.state = 'return';

    let sp = 0;
    if (m.state === 'idle') {
      if (m.think <= 0) {
        m.think = 2 + Math.random() * 4;
        m.target.set(m.home.x + (Math.random() - 0.5) * 24, 0, m.home.z + (Math.random() - 0.5) * 24);
      }
      sp = 1.2;
    } else if (m.state === 'chase') {
      m.target.copy(p.obj.position); sp = 5.2;
      if (d < 2.4 && m.atkCd <= 0 && p.alive) {
        m.atkCd = 2.0;
        damagePlayer(Math.max(3, m.dmg - G.player.lvl * 2), m);
      }
    } else {
      m.target.copy(m.home); sp = 4;
      if (m.obj.position.distanceTo(m.home) < 3) m.state = 'idle';
    }
    const dir = _np.copy(m.target).sub(m.obj.position); dir.y = 0;
    const dl = dir.length();
    if (dl > 1.2) {
      dir.normalize();
      m.obj.position.addScaledVector(dir, sp * dt);
      m.obj.rotation.y = Math.atan2(dir.x, dir.z);
      m.speed = sp;
    } else m.speed = 0;
    const gh = G.world.heightAt(m.obj.position.x, m.obj.position.z);
    m.obj.position.y += (Math.max(gh, G.world.sea - 0.9) - m.obj.position.y) * Math.min(1, dt * 8);
    if (m.speed > 0) animateBeast(m, m.speed, perfNow());
  }
  G.monsters = G.monsters.filter(m => !m.dead);
}

// ================= NPC 待机 =================
const _npcDt = { v: 0 };
function updateNPCs(now) {
  const dt = Math.max(0.001, Math.min(0.05, now - (_npcDt.v || now - 0.016)));
  _npcDt.v = now;
  for (const n of G.npcs) {
    if (n.obj.position.distanceTo(G.player.obj.position) > 320) { n.obj.visible = false; continue; }
    n.obj.visible = true;
    if (n.ap) n.ap.update(dt);
  }
}

// ================= 昼夜 =================
// 光照/雾/天空全部由原版 vscene 的 4 个时段关键帧 (5/9/15/20) 插值驱动，
// 不再是硬编码配色；每张地图有各自的参数，走进不同区域会看到不同的天色。
const _fogC = new THREE.Color(), _tmpC = new THREE.Color();
function updateDayNight(dt) {
  G.timeOfDay = (G.timeOfDay + dt / 600) % 1;      // 10 分钟一昼夜
  const hour = G.timeOfDay * 24;

  // 太阳走向（原版水面材质的 sunDirection 提供方位与高度）
  const env = G.env ? G.env.sample(G.world, G.player ? G.player.obj.position.x : 0,
    G.player ? G.player.obj.position.z : 0, hour, dt) : null;
  const sd = env && env.sunDir ? env.sunDir : [0.577, 0.577, 0.577];
  // 原版 sunDirection 给出方位角与正午高度角；昼夜让太阳沿该方位划弧
  const azim = Math.atan2(sd[2], sd[0]);
  const noonElev = Math.asin(Math.max(0.08, Math.min(0.97, sd[1])));
  const t = (hour - 6) / 12;                        // 6 点日出、18 点日落
  const e = (t < 0 || t > 1) ? -0.42 : Math.sin(t * Math.PI) * noonElev;
  const sunDir = new V3(Math.cos(azim) * Math.cos(e), Math.sin(e), Math.sin(azim) * Math.cos(e)).normalize();
  G.sunDir = sunDir;

  G.sky.mat.uniforms.uSunDir.value.copy(sunDir);
  G.sun.position.copy(sunDir).multiplyScalar(1000);
  const up = Math.max(0, sunDir.y);

  if (env) {
    // ---- 光照（原版 LightAmbient / LightDiffuse / SunLum）----
    const amb = env.light.ambient, dif = env.light.diffuse, sl = env.sun;
    const aMul = env.light.ambientMul !== undefined ? env.light.ambientMul : 1;
    const dMul = env.light.diffuseMul !== undefined ? env.light.diffuseMul : 1;
    G.ambient.color.setRGB(amb[0], amb[1], amb[2]);
    G.ambient.intensity = 0.45 + 1.05 * Math.min(2.0, aMul);
    G.sun.color.setRGB(dif[0], dif[1], dif[2]);
    G.sun.intensity = Math.min(3.0, 0.35 + 0.42 * (sl.lum !== undefined ? sl.lum : 1.0))
      * Math.min(2.0, dMul) * (0.25 + 0.75 * Math.max(0.0, sunDir.y * 3.0 + 0.3));
    G.hemi.color.setRGB(dif[0], dif[1], dif[2]);
    G.hemi.groundColor.setRGB(amb[0] * 0.8, amb[1] * 0.8, amb[2] * 0.8);
    G.hemi.intensity = 0.30 + 0.55 * Math.min(1.5, aMul);

    // ---- 雾（原版 FogColor × FogColorMultiplier、FogIntensity 决定浓淡）----
    // 原版雾色是为 HDR 画面调的，直接拿来在 LDR 里会把远景压成深色块，
    // 因此把雾色朝天空底色调和一部分，让地平线接得上。
    const f = env.fog;
    const fm = f.colorMul !== undefined ? f.colorMul : 1;
    _fogC.setRGB(f.color[0] * fm, f.color[1] * fm, f.color[2] * fm);
    _tmpC.setRGB(env.sky.bottom[0], env.sky.bottom[1], env.sky.bottom[2]);
    _fogC.lerp(_tmpC, 0.45);
    G.scene.fog.color.copy(_fogC);
    const fi = Math.max(0.02, f.intensity !== undefined ? f.intensity : 0.3);
    G.scene.fog.near = 900 + 2600 * fi / (1 + fi);
    G.scene.fog.far = G.scene.fog.near + 5200 + 3600 * fi / (1 + fi);
    G.renderer.setClearColor(_fogC);

    // ---- 天空（原版 FilterTop/Middle/BottomColor）----
    const su = G.sky.mat.uniforms;
    su.uTop.value.setRGB(env.sky.top[0], env.sky.top[1], env.sky.top[2]);
    su.uMid.value.setRGB(env.sky.middle[0], env.sky.middle[1], env.sky.middle[2]);
    su.uBot.value.setRGB(env.sky.bottom[0], env.sky.bottom[1], env.sky.bottom[2]);
    su.uLum.value = env.sky.lumScale !== undefined ? env.sky.lumScale : 0.2;
    su.uInscatter.value = env.sky.inscatter !== undefined ? env.sky.inscatter : 0.3;
    const sn = env.sun;
    su.uSunColor.value.setRGB(
      sn.color[0] * 0.35 + env.sky.top[0] * 0.65,
      sn.color[1] * 0.35 + env.sky.top[1] * 0.65,
      sn.color[2] * 0.35 + env.sky.top[2] * 0.65);
    su.uSunLum.value = sn.lum !== undefined ? sn.lum : 1.0;
    su.uSunSize.value = sn.size !== undefined ? sn.size : 4.0;
    su.uCloud.value.setRGB(env.cloud.color[0], env.cloud.color[1], env.cloud.color[2]);
    su.uCloudAlpha.value = env.cloud.alpha || 0;
    su.uCloudCurve.value = env.cloud.curve || 0.2;

    // ---- 水面（原版颜色随天色走）----
    const wu = G.water.mat.uniforms;
    wu.uSkyHorizon.value.setRGB(
      env.sky.middle[0] * 0.7 + env.sky.bottom[0] * 0.3,
      env.sky.middle[1] * 0.7 + env.sky.bottom[1] * 0.3,
      env.sky.middle[2] * 0.7 + env.sky.bottom[2] * 0.3);
    const wv = env.water || {};
    if (Array.isArray(wv.sunColor)) {
      wu.uSunColor.value.setRGB(wv.sunColor[0], wv.sunColor[1], wv.sunColor[2]);
    }
    if (Array.isArray(wv.brightWaterColor)) {
      wu.uBright.value.setRGB(wv.brightWaterColor[0], wv.brightWaterColor[1], wv.brightWaterColor[2]);
    }
    if (Array.isArray(wv.darkWaterColor)) {
      wu.uDark.value.setRGB(wv.darkWaterColor[0], wv.darkWaterColor[1], wv.darkWaterColor[2]);
    }
    if (Array.isArray(wv.waterTintColor)) {
      wu.uTint.value.setRGB(wv.waterTintColor[0], wv.waterTintColor[1], wv.waterTintColor[2]);
    }
    G.water.mat.uniforms.uSunDir.value.copy(sunDir);
    G._envLabel = env.map;
  } else {
    const day = Math.max(0, Math.min(1, sunDir.y * 2.2 + 0.25));
    G.sun.intensity = 1.7 * Math.max(0.02, sunDir.y);
    G.ambient.intensity = 0.25 + 0.75 * day;
    G.hemi.intensity = 0.2 + 0.55 * day;
    _fogC.setHex(0xa8c2d8).lerp(_tmpC.setHex(0x0a1018), 1 - day);
    G.scene.fog.color.copy(_fogC);
    G.renderer.setClearColor(_fogC);
  }

  // 植被亮度跟随太阳高度
  const vb = 0.45 + 0.55 * Math.max(0, Math.min(1, sunDir.y * 2.4 + 0.35));
  for (const mat of G.world.vegMatCache.values()) mat.color.setRGB(vb, vb, Math.min(1, vb * 1.02));

  vegTime.value = perfNow();
  G.sky.mat.uniforms.uTime.value = perfNow();
  G.water.mat.uniforms.uTime.value = perfNow();
  const hh = Math.floor(hour), mm = Math.floor((hour % 1) * 60);
  const icon = sunDir.y > 0 ? '☀' : '☾';
  $('clock').textContent = `${icon} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ================= 交互 =================
function updateInteract() {
  const p = G.player;
  let hint = '', near = null;
  for (const n of G.npcs) {
    if (p.obj.position.distanceTo(n.obj.position) < 4.5) { near = { type: 'npc', o: n }; hint = `按 F 与 ${n.def.name} 交谈`; break; }
  }
  if (!near) {
    for (const pk of G.pickups) {
      if (pk.taken) continue;
      if (p.obj.position.distanceTo(pk.obj.position) < 2.6) { near = { type: 'pickup', o: pk }; hint = `按 F 采集 ${pk.name}`; break; }
    }
  }
  G.nearNPC = near && near.type === 'npc' ? near.o : null;
  G.nearPickup = near && near.type === 'pickup' ? near.o : null;
  $('hint').textContent = hint;
  $('hint').style.opacity = hint ? 1 : 0;
}

function interact() {
  if (G.dialogOpen) return;
  if (G.nearNPC) openDialog(G.nearNPC);
  else if (G.nearPickup) takePickup(G.nearPickup);
}

function takePickup(pk) {
  pk.taken = true;
  G.scene.remove(pk.obj);
  addItem({ icon: pk.icon, name: pk.name, n: 1, kind: pk.kind });
  const names = { herb: '灵草', ore: '云母石', treasure: '古物' };
  toast(`采集 ${names[pk.kind] || pk.name}`);
  if (pk.kind === 'herb') { G.herbGot = (G.herbGot || 0) + 1; }
  const taken = JSON.parse(localStorage.getItem('shx.taken') || '[]');
  taken.push(pk.obj.uuid);
  localStorage.setItem('shx.taken', JSON.stringify(taken.slice(-600)));
  sfx('pick');
  updateTracker();
  saveGame();
}

// ================= 对话 =================
function openDialog(npc) {
  G.dialogOpen = true;
  $('dialog').style.display = 'block';
  $('dlgPortrait').src = npc.def.face;
  $('dlgName').textContent = `${npc.def.name} · ${npc.def.role}`;
  let text = npc.def.line;
  $('dlgText').textContent = text;
  const opts = $('dlgOpts'); opts.innerHTML = '';
  const mkBtn = (label, fn) => {
    const b = document.createElement('div');
    b.className = 'btn'; b.textContent = label;
    b.onclick = () => { fn(); };
    opts.appendChild(b);
  };
  // 灵草任务交付
  if (npc.def.id === '102' && (G.herbGot || 0) >= 8 && !G.quests.herbsDone) {
    G.quests.herbsDone = true;
    text = '（你递上八株灵草）好手气！这瓶伤药你收好，往后在山里受了伤，记得用它。';
    addItem({ icon: G.cfg.items[3] || G.cfg.items[0], name: '伤药', n: 5 });
    addXp(120);
  }
  mkBtn('告辞', closeDialog);
  if (npc.def.id === '102' && !G.quests.herbsDone) mkBtn('关于灵草', () => {
    $('dlgText').textContent = '灵草多生于平缓湿润之地，见到头顶有光柱的便是。凑齐八株带来找我。';
  });
  mkBtn('请教指路', () => {
    const r = npc.region;
    const others = G.meta.regions.filter(x => x.name !== r && !G.discovered.has(x.name));
    $('dlgText').textContent = others.length
      ? `听闻${others[0].disp}尚无人踏足，沿着海与谷走，总能寻到路。`
      : '九域你已尽数走过，真是好脚力！';
  });
}

function closeDialog() {
  G.dialogOpen = false;
  $('dialog').style.display = 'none';
}

// ================= UI =================
function refreshStats() {
  const p = G.player;
  $('hpBar').style.width = (p.hp / p.maxHp * 100) + '%';
  $('hpTxt').textContent = `${Math.ceil(p.hp)} / ${p.maxHp}`;
  $('xpBar').style.width = (p.xp / p.xpNext * 100) + '%';
  $('xpTxt').textContent = `${p.xp} / ${p.xpNext}`;
  $('lvl').textContent = p.lvl;
}

function updateTracker() {
  const el = $('questList'); el.innerHTML = '';
  const mk = (name, desc, done) => {
    const d = document.createElement('div');
    d.className = 'q';
    d.innerHTML = `${done ? '<span class="done">✔</span>' : '·'} ${name}<br><span style="color:#8fa0b5">${desc}</span>`;
    el.appendChild(d);
  };
  mk('踏遍九域', `已寻访 ${G.discovered.size} / 9 处`, G.discovered.size >= 9);
  mk('灵草八株', `已采 ${(G.herbGot || 0)} / 8${G.quests.herbsDone ? '（已交付）' : ''}`, !!G.quests.herbsDone);
  mk('讨伐妖兽', `已击败 ${G.kills} / 10`, G.kills >= 10);
}

function announceRegion(name) {
  const el = $('regionName');
  el.textContent = name;
  el.style.opacity = 1;
  setTimeout(() => el.style.opacity = 0, 2600);
  toast(`发现新地域：${name}`);
}

let toastTimer = 0;
function toast(txt) {
  const el = $('toast');
  el.textContent = txt;
  el.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.style.opacity = 0, 2800);
}

function showDmg(pos, n, color = '#ffd76e') {
  const v = pos.clone().project(G.camera);
  if (v.z > 1) return;
  const el = document.createElement('div');
  el.className = 'dmg';
  el.style.left = ((v.x * 0.5 + 0.5) * innerWidth) + 'px';
  el.style.top = ((-v.y * 0.5 + 0.5) * innerHeight) + 'px';
  el.style.color = color;
  el.textContent = n;
  $('dmgLayer').appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

function buildHotbar() {
  const hb = $('hotbar'); hb.innerHTML = '';
  SKILLS.forEach((sk, i) => {
    const s = document.createElement('div');
    s.className = 'slot';
    s.innerHTML = `<img src="${G.cfg.skills[i * 3] || G.cfg.skills[0]}"><span class="key">${sk.key}</span><div class="cd" id="cd${i}" style="display:none"></div>`;
    hb.appendChild(s);
  });
}

function updateHotbarCd() {
  SKILLS.forEach((sk, i) => {
    const el = $('cd' + i);
    const cd = i === 0 ? G.attackCd / sk.cd : G.skillCd / sk.cd;
    if (cd > 0) { el.style.display = 'block'; el.style.height = (cd * 100) + '%'; }
    else el.style.display = 'none';
  });
}

function addItem(item) {
  G.inventory[item.name] = G.inventory[item.name] || { ...item, n: 0 };
  G.inventory[item.name].n += item.n;
}

function renderInventory() {
  const grid = $('invGrid'); grid.innerHTML = '';
  const list = Object.values(G.inventory);
  for (let i = 0; i < Math.max(24, Math.ceil(list.length / 8) * 8); i++) {
    const c = document.createElement('div');
    const it = list[i];
    if (it) {
      c.className = 'icell';
      c.innerHTML = `<img src="${it.icon}"><span class="cnt">${it.n}</span>`;
      c.title = it.name;
    } else c.className = 'icell empty';
    grid.appendChild(c);
  }
  $('invStats').innerHTML = `<div class="prow"><span>修为境界</span><span>第 ${G.player.lvl} 重</span></div>
    <div class="prow"><span>击败妖兽</span><span>${G.kills}</span></div>
    <div class="prow"><span>寻访地域</span><span>${G.discovered.size} / 9</span></div>`;
}

// ================= 小地图 =================
let mmcCtx = null, mapImg = null;
function initMinimap() {
  mmcCtx = $('mmc').getContext('2d');
  mapImg = new Image();
  mapImg.src = './assets/world.colormap.png';
}
function drawMinimap() {
  if (!mapImg.complete || !mmcCtx) return;
  const c = mmcCtx, S = 392;
  const p = G.player.obj.position;
  const view = 900;      // 显示范围(米)
  const u = (x) => (x - G.world.originX) / G.world.worldW;
  const v = (z) => (z - G.world.originZ) / G.world.worldH;
  const sx = u(p.x) * mapImg.width, sy = v(p.z) * mapImg.height;
  const cropW = view / G.world.worldW * mapImg.width;
  const cropH = view / G.world.worldH * mapImg.height;
  c.clearRect(0, 0, S, S);
  c.save();
  c.beginPath(); c.arc(S / 2, S / 2, S / 2, 0, 7); c.clip();
  c.drawImage(mapImg, sx - cropW / 2, sy - cropH / 2, cropW, cropH, 0, 0, S, S);
  c.restore();
  // 区域名
  const reg = G.world.regionAt(p.x, p.z);
  c.font = '600 20px "Microsoft YaHei"'; c.textAlign = 'center';
  c.shadowColor = '#000'; c.shadowBlur = 4;
  c.fillStyle = '#f0e6c8';
  if (reg) c.fillText(reg.disp, S / 2, 30);
  // 玩家箭头
  c.save();
  c.translate(S / 2, S / 2);
  c.rotate(-G.yaw + Math.PI);
  c.fillStyle = '#ffe9ad';
  c.beginPath(); c.moveTo(0, -10); c.lineTo(7, 8); c.lineTo(0, 4); c.lineTo(-7, 8); c.closePath(); c.fill();
  c.restore();
  // 妖兽/采集点
  for (const m of G.monsters) {
    if (m.dead) continue;
    const dx = m.obj.position.x - p.x, dz = m.obj.position.z - p.z;
    if (Math.abs(dx) > view / 2 || Math.abs(dz) > view / 2) continue;
    c.fillStyle = '#ff6a5a';
    c.beginPath(); c.arc(S / 2 + dx / view * S, S / 2 + dz / view * S, 3.4, 0, 7); c.fill();
  }
  for (const pk of G.pickups) {
    if (pk.taken) continue;
    const dx = pk.obj.position.x - p.x, dz = pk.obj.position.z - p.z;
    if (Math.abs(dx) > view / 2 || Math.abs(dz) > view / 2) continue;
    c.fillStyle = '#8fe08a';
    c.fillRect(S / 2 + dx / view * S - 2, S / 2 + dz / view * S - 2, 4, 4);
  }
}

// 大地图
function openBigMap() {
  const reg = G.world.regionAt(G.player.obj.position.x, G.player.obj.position.z);
  const img = $('bigmap');
  if (reg) {
    img.src = `./assets/mapimg/${reg.name}.png`;
    $('mapInfo').textContent = `${reg.disp} —— 尺幅约 ${Math.round(reg.w)} × ${Math.round(reg.h)} 米（原版舆图）`;
  } else {
    img.src = './assets/world.colormap.png';
    $('mapInfo').textContent = '沧海之间（不在任何地域内）';
  }
  showPanel('mapPanel');
}

// ================= 面板 =================
function showPanel(id) {
  document.querySelectorAll('.panel').forEach(p => p.style.display = 'none');
  if (id) { $(id).style.display = 'block'; G.panelOpen = id; }
  else G.panelOpen = null;
}

// ================= 存档 =================
function saveGame() {
  const p = G.player;
  localStorage.setItem('shx.save', JSON.stringify({
    pos: [p.obj.position.x, p.obj.position.y, p.obj.position.z],
    hp: p.hp, xp: p.xp, lvl: p.lvl, xpNext: p.xpNext, maxHp: p.maxHp,
    kills: G.kills, herbGot: G.herbGot || 0,
    discovered: [...G.discovered],
    quests: G.quests, inventory: G.inventory,
    tod: G.timeOfDay,
  }));
}
function loadGame() {
  try {
    const s = JSON.parse(localStorage.getItem('shx.save'));
    if (!s) return false;
    const p = G.player;
    p.obj.position.set(s.pos[0], s.pos[1], s.pos[2]);
    p.hp = s.hp; p.xp = s.xp; p.lvl = s.lvl; p.xpNext = s.xpNext; p.maxHp = s.maxHp;
    G.kills = s.kills; G.herbGot = s.herbGot;
    G.discovered = new Set(s.discovered);
    G.quests = s.quests; G.inventory = s.inventory;
    G.timeOfDay = s.tod;
    // 移除已采集
    return true;
  } catch (e) { return false; }
}

// ================= 音效(WebAudio 合成) =================
let actx = null;
function sfx(kind) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    const o = actx.createOscillator(), g = actx.createGain();
    o.connect(g); g.connect(actx.destination);
    if (kind === 'hit') { o.frequency.value = 180; o.type = 'square'; g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12); o.start(t); o.stop(t + 0.13); }
    else if (kind === 'miss') { o.frequency.value = 500; o.type = 'triangle'; g.gain.setValueAtTime(0.03, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08); o.start(t); o.stop(t + 0.09); }
    else if (kind === 'pick') { o.frequency.value = 660; o.type = 'sine'; g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3); o.start(t); o.stop(t + 0.3); }
    else if (kind === 'level') { o.frequency.setValueAtTime(440, t); o.frequency.setValueAtTime(660, t + 0.12); o.frequency.setValueAtTime(880, t + 0.24); o.type = 'sine'; g.gain.setValueAtTime(0.09, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.6); o.start(t); o.stop(t + 0.6); }
  } catch (e) { }
}

// ================= 输入 =================
function bindInput() {
  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    G.keys[k] = true;
    if (G.state !== 'play') return;
    if (k === 'f') interact();
    if (k === 'j') tryAttack(false);
    if (k === 'k') tryAttack(true);
    if (k === 'i') { renderInventory(); showPanel(G.panelOpen === 'invPanel' ? null : 'invPanel'); }
    if (k === 'm') { if (G.panelOpen === 'mapPanel') showPanel(null); else openBigMap(); }
    if (k === 'h') showPanel(G.panelOpen === 'helpPanel' ? null : 'helpPanel');
    if (k === 'escape') { if (G.dialogOpen) closeDialog(); else showPanel(null); }
  });
  addEventListener('keyup', (e) => G.keys[e.key.toLowerCase()] = false);
  const dom = G.renderer.domElement;
  dom.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      if (G.panelOpen || G.dialogOpen) return;
      G.camDrag = true; G.dragMoved = false;
      G.dragStart = [e.clientX, e.clientY];
    }
  });
  addEventListener('mousemove', (e) => {
    if (G.camDrag) {
      const dx = e.clientX - G.dragStart[0], dy = e.clientY - G.dragStart[1];
      if (Math.abs(dx) + Math.abs(dy) > 3) G.dragMoved = true;
      G.yaw -= dx * 0.006;
      G.pitch = Math.max(0.02, Math.min(1.2, G.pitch + dy * 0.005));
      G.dragStart = [e.clientX, e.clientY];
    }
  });
  addEventListener('mouseup', () => {
    if (G.camDrag && !G.dragMoved && G.state === 'play' && !G.panelOpen && !G.dialogOpen) tryAttack(false);
    G.camDrag = false;
  });
  dom.addEventListener('wheel', (e) => {
    G.dist = Math.max(4, Math.min(26, G.dist + e.deltaY * 0.012));
  }, { passive: true });
  dom.addEventListener('contextmenu', e => e.preventDefault());

  $('btnNew').onclick = () => startGame(false);
  $('btnCont').onclick = () => startGame(true);
  $('closePanel').onclick = () => showPanel(null);
  $('closePanel2').onclick = () => showPanel(null);
  $('closePanel3').onclick = () => showPanel(null);
}

function startGame(cont) {
  $('title').style.display = 'none';
  $('hud').style.display = 'block';
  G.state = 'play';
  $('portrait').src = NPC_DEFS[0].face;
  $('pname').textContent = '无名旅人';
  if (cont) loadGame();
  initMinimap();
  // 移除已采集的
  const taken = JSON.parse(localStorage.getItem('shx.taken') || '[]');
  for (const pk of G.pickups) {
    if (taken.includes(pk.obj.uuid)) { pk.taken = true; G.scene.remove(pk.obj); }
  }
  refreshStats(); updateTracker(); buildHotbar();
  const reg = G.world.regionAt(G.player.obj.position.x, G.player.obj.position.z);
  if (reg) $('regionName').textContent = reg.disp;
  lastSave = perfNow();
  requestAnimationFrame(loop);
}

// ================= 主循环 =================
let lastT = 0, lastSave = 0, fpsN = 0;
function perfNow() { return performance.now() / 1000; }

function loop(t) {
  requestAnimationFrame(loop);
  const now = t / 1000;
  let dt = Math.min(0.05, now - (lastT || now));
  lastT = now;

  if (G.state !== 'play') return;

  updatePlayer(dt);
  updateNPCs(now);
  updateMonsters(dt);
  updateDayNight(dt);
  updateInteract();
  updateHotbarCd();

  // 相机
  const p = G.player.obj.position;
  const cx = p.x - Math.sin(G.yaw) * Math.cos(G.pitch) * G.dist;
  const cz = p.z - Math.cos(G.yaw) * Math.cos(G.pitch) * G.dist;
  const cy = p.y + 2 + Math.sin(G.pitch) * G.dist;
  const ch = G.world.heightAt(cx, cz);
  G.camera.position.lerp(_np.set(cx, Math.max(cy, ch + 1.2), cz), Math.min(1, dt * 10));
  G.camera.lookAt(p.x, p.y + (G.player.height || 1.8) * 0.85, p.z);

  G.world.update(p.x, p.z);

  // 自动存档
  if (now - lastSave > 20) { lastSave = now; saveGame(); }

  drawMinimap();
  G.renderer.render(G.scene, G.camera);
}
