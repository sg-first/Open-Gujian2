// probe_stride.js —— 直接反求动画原生步幅：
// 速率=1.0 播放时，触地期内 (身体位移 − 触点世界位移) / 时长 = 触地点相对身体的
// 后向速度 = 该动画应在游戏里使用的移动速度(此速度下脚零漂移)。
const { chromium } = require('C:/Users/sgfirstliu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 250)));
  await page.goto('http://127.0.0.1:8471', { waitUntil: 'load' });
  await page.waitForFunction('window.__step === "done"', null, { timeout: 90000 });
  await page.click('#btnNew');
  await page.waitForTimeout(1500);

  const out = await page.evaluate(`(function(){
    const p = G.player, ap = p.ap, bones = p.parts.bones;
    const V = p.obj.position.constructor;
    const tL = bones.find(b=>b.name==='Bip01 L Toe0');
    const tR = bones.find(b=>b.name==='Bip01 R Toe0');

    function analyse(name, cycles) {
      const clip = ap.clips[name];
      ap.loco = [{ name, clip, isGait: true, anchor: 0 }];
      ap._w = new Float32Array(1);
      ap.phase = 0; ap.tIdle = 0; ap.action = null; ap.actionW = 0;
      p.obj.position.set(0,0,0); p.obj.rotation.set(0,0,0);
      // 关键：把速度设为"当前标定步幅"，使播放速率 = 1.0（测的是原生速度）
      const v = clip.stride;
      const dt = 1/60, N = Math.round(cycles * clip.dur / dt);
      const rows = [];
      for (let k=0;k<N;k++){
        ap.setSpeed(v); ap.update(dt);
        p.obj.position.z -= v*dt;
        p.obj.updateMatrixWorld(true);
        const a = new V(); tL.getWorldPosition(a);
        const b = new V(); tR.getWorldPosition(b);
        rows.push([a.x, a.y, a.z, b.x, b.y, b.z, p.obj.position.z]);
      }
      const ys = rows.map(r=>Math.min(r[1], r[4]));
      const ymin = Math.min(...ys);
      const ymax = Math.max(...rows.map(r=>Math.max(r[1], r[4])));
      const thr = ymin + Math.max(0.010, (ymax - ymin) * 0.10);
      const vals = [];
      let cur = null;
      const flush = () => {
        if (!cur) return;
        const dur = (cur.k1 - cur.k0) * dt;
        if (dur >= 0.04) {
          const a = rows[cur.k0], b = rows[cur.k1];
          const body = b[6] - a[6];
          const toe = b[cur.side + 2] - a[cur.side + 2];
          // 身体沿 -Z 前进，触点相对身体的后向速度 = (body - toe)/dur
          vals.push((body - toe) / dur);
        }
        cur = null;
      };
      for (let k = 0; k < rows.length; k++) {
        const r = rows[k];
        const side = (r[1] <= r[4]) ? 0 : 3;
        if (r[side + 1] <= thr) {
          if (!cur || cur.side !== side) { flush(); cur = { side, k0: k, k1: k }; }
          else cur.k1 = k;
        } else flush();
      }
      flush();
      vals.sort((a,b)=>a-b);
      const med = vals.length ? vals[vals.length>>1] : 0;
      return { name, calibrated: clip.stride, native: +med.toFixed(3),
               n: vals.length, all: vals.map(x=>+x.toFixed(2)) };
    }

    const r = [analyse('walk', 8), analyse('run', 12), analyse('sprint', 16)];
    for (const x of r) ap.loco = [];
    return r;
  })()`);

  console.log('=== 反求原生步幅 (米/秒) ===');
  for (const r of out) {
    console.log(`${r.name.padEnd(7)} 当前标定 ${String(r.calibrated).padEnd(6)} → 实测原生 ${String(r.native).padEnd(6)} (触地区间 ${r.n} 个)`);
    console.log(`        各区间: ${JSON.stringify(r.all.slice(0, 10))}`);
  }
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
