// probe_contact.js —— 最直接判据：连续触地区间内，接触点(脚趾)在世界空间的净漂移。
// 理想动画该漂移≈0（脚踩住不动）；漂移/时长 即真实滑步速度。
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

    function measure(v, cycles, label) {
      ap.phase = 0; ap.tIdle = 0; ap.action = null; ap.actionW = 0;
      p.obj.position.set(0,0,0); p.obj.rotation.set(0,0,0);
      const dt = 1/60;
      const maxDur = Math.max(...ap.loco.map(l=>l.clip.dur));
      const N = Math.round(cycles * maxDur / dt);
      const rows = [];
      for (let k=0;k<N;k++){
        ap.setSpeed(v); ap.update(dt);
        p.obj.position.z -= v*dt;
        p.obj.updateMatrixWorld(true);
        const a = new V(); tL.getWorldPosition(a);
        const b = new V(); tR.getWorldPosition(b);
        rows.push([a.x, a.y, a.z, b.x, b.y, b.z]);
      }
      const ys = rows.map(r=>Math.min(r[1], r[4]));
      const ymin = Math.min(...ys);
      const ymax = Math.max(...rows.map(r=>Math.max(r[1], r[4])));
      const thr = ymin + Math.max(0.010, (ymax - ymin) * 0.10);
      // 找连续触地区间（同一只脚）
      const intervals = [];
      let cur = null;
      for (let k = 0; k < rows.length; k++) {
        const r = rows[k];
        const side = (r[1] <= r[4]) ? 0 : 3;          // 用较低的那只脚
        const inContact = r[side + 1] <= thr;
        if (inContact) {
          if (!cur || cur.side !== side) { if (cur) intervals.push(cur); cur = { side, k0: k, k1: k }; }
          else cur.k1 = k;
        } else if (cur) { intervals.push(cur); cur = null; }
      }
      if (cur) intervals.push(cur);
      const res = [];
      for (const iv of intervals) {
        const durs = (iv.k1 - iv.k0) * dt;
        if (durs < 0.03) continue;                    // 太短的区间忽略
        const a = rows[iv.k0], b = rows[iv.k1];
        const dz = b[iv.side + 2] - a[iv.side + 2];   // 行进方向(=z)漂移
        const dx = b[iv.side] - a[iv.side];           // 横向漂移
        res.push({ dur: +durs.toFixed(3),
                   dz: +dz.toFixed(3), dx: +dx.toFixed(3),
                   slip: +(Math.abs(dz) / durs).toFixed(2) });   // 滑步只算行进方向
      }
      const slips = res.map(r=>r.slip).sort((x,y)=>x-y);
      const med = slips.length ? slips[Math.floor(slips.length/2)] : -1;
      return { label, v, intervals: res.length, med,
               ratio: +(med / v * 100).toFixed(0),
               detail: res.slice(0, 4) };
    }

    const S = (n) => ap.clips[n].stride;
    return [ measure(S('walk'), 4, 'walk名义'),
             measure(S('run'), 6, 'run名义(=常规)'),
             measure(S('sprint'), 8, 'sprint名义(=冲刺)'),
             measure(2.0, 5, '走→跑过渡'),
             measure(0.8, 4, '低速') ];
  })()`);

  console.log('=== 触地净漂移 → 滑步速度(理想值 0) ===');
  for (const r of out) {
    console.log(`${r.label.padEnd(18)} v=${String(r.v).padEnd(5)} 触地区间${r.intervals}个  滑步中位=${String(r.med).padEnd(5)} m/s (${r.ratio}%)`);
    for (const d of r.detail) console.log(`     触地 ${d.dur}s 纵向漂移 ${d.dz}m 横向 ${d.dx}m → 滑步 ${d.slip} m/s`);
  }
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
