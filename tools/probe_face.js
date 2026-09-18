// probe_face.js —— 判定模型视觉前方：相机置于角色本地 +Z / -Z 两侧对比
const { chromium } = require('C:/Users/sgfirstliu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await browser.newContext({ viewport: { width: 620, height: 620 } })).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
  await page.goto('http://127.0.0.1:8471', { waitUntil: 'load' });
  await page.waitForFunction('window.__step === "done"', null, { timeout: 90000 });
  await page.click('#btnNew');
  await page.waitForTimeout(1500);

  // 固定角色朝向为本地 +Z 对准世界 +Z
  await page.evaluate(`(function(){ G.player.yawFace = 0; G.player.obj.rotation.y = 0; G.dist=3.0; G.pitch=0.05; })()`);
  await page.waitForTimeout(400);

  // 相机在 -Z 侧(yaw=0)
  await page.evaluate(`G.yaw = 0`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'probe_face_negZ.png' });
  // 相机在 +Z 侧(yaw=π)
  await page.evaluate(`G.yaw = Math.PI`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'probe_face_posZ.png' });

  // 顺带：走路中(按 W)两帧，看脚在支撑期的世界位置是否固定
  await page.evaluate(`(function(){ G.keys={w:1}; })()`);
  await page.waitForTimeout(1600);
  const info = await page.evaluate(`(function(){
    const p = G.player;
    return { speed: p.speed.toFixed(2), yaw: p.obj.rotation.y.toFixed(3),
             posZ: p.obj.position.z.toFixed(2) };
  })()`);
  console.log('walking:', JSON.stringify(info));
  await page.screenshot({ path: 'probe_walk_side.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
