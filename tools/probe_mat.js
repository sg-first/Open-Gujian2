const { chromium } = require('C:/Users/sgfirstliu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core');
const PORT = process.argv[2] || 8471;
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0, 400)));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ' ' + m.text().slice(0, 500)); });
  await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'load' });
  await page.waitForFunction('window.__step === "done"', null, { timeout: 90000 });
  await page.click('#btnNew');
  await page.waitForTimeout(9000);
  const r = await page.evaluate(`(function(){
    var m = G.world.terrainMat;
    var out = {
      hasOBCC: typeof m.onBeforeCompile === 'function',
      map: !!m.map, mapFlipY: m.map ? m.map.flipY : null,
      normalMap: !!m.normalMap,
      normalFlipY: m.normalMap ? m.normalMap.flipY : null,
      normalSize: m.normalMap && m.normalMap.image ? (m.normalMap.image.width+'x'+m.normalMap.image.height) : null,
      normalScale: m.normalScale ? [m.normalScale.x, m.normalScale.y] : null,
      type: m.type,
      programCache: !!m.__webglShader,
      chunkHasSlope: !!(m.userData && m.userData.x),
      defUseNormalMap: m.defines ? m.defines : null,
    };
    // 取一个 chunk 的地形几何看属性
    var ch = G.world.chunks.values().next().value;
    out.geoAttrs = ch ? Object.keys(ch.mesh.geometry.attributes) : null;
    out.uniformNames = null;
    // 用 canvas 采样近处地表像素
    return JSON.stringify(out);
  })()`);
  console.log('probe =', r);
  // 试着把 normalScale 拉满，看地表是否有明显变化
  await page.evaluate(`G.world.terrainMat.normalScale.set(4,4); G.world.terrainMat.needsUpdate = true;`);
  await page.waitForTimeout(1500);
  await page.evaluate(`(function(){
    var v=(G.villages||[])[1]||(G.villages||[])[0];
    var p=G.player.obj.position; p.set(v.x+30,0,v.z+30); p.y=G.world.heightAt(p.x,p.z);
    G.yaw=Math.atan2(v.x-p.x,v.z-p.z)+Math.PI; G.pitch=0.25; })()`);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'tools/probe_ground_zoom.png' });
  console.log('errs =', JSON.stringify(errs.slice(0, 10)));
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
