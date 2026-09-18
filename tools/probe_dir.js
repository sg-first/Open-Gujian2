// probe_dir.js —— 实测按 W 时的行进方向与相机方位关系
const { chromium } = require('C:/Users/sgfirstliu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core');

(async () => {
  const b = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await b.newContext()).newPage();
  await page.goto('http://127.0.0.1:8471', { waitUntil: 'load' });
  await page.waitForFunction('window.__step === "done"', null, { timeout: 90000 });
  await page.click('#btnNew');
  await page.waitForTimeout(1500);
  const r = await page.evaluate(async () => {
    const p = G.player;
    p.obj.rotation.y = 0; p.yawFace = 0;
    await new Promise((r) => setTimeout(r, 400));
    const p0 = p.obj.position.clone();
    G.keys = { w: 1 };
    await new Promise((r) => setTimeout(r, 2500));
    const p1 = p.obj.position.clone();
    G.keys = {};
    const vel = p1.clone().sub(p0); vel.y = 0; vel.normalize();
    const cam = G.camera.position.clone().sub(p1); cam.y = 0; cam.normalize();
    return {
      yaw: +G.yaw.toFixed(3),
      velXZ: [+vel.x.toFixed(2), +vel.z.toFixed(2)],
      camOffsetXZ: [+cam.x.toFixed(2), +cam.z.toFixed(2)],
      dot: +(vel.x * cam.x + vel.z * cam.z).toFixed(3),
      movedMeters: +p1.distanceTo(p0).toFixed(2),
      modelFrontWorld: [-Math.sin(p.obj.rotation.y), -Math.cos(p.obj.rotation.y)].map((v) => +v.toFixed(2)),
    };
  });
  console.log(JSON.stringify(r, null, 1));
  console.log(r.dot < 0 ? '=> 相机在行进方向后方(角色背对镜头前进)' : '=> 相机在行进方向前方(角色朝镜头前进)');
  await b.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
