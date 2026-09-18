// probe_combat.js —— 回归测试：攻击判定（模型前方为局部 -Z）与怪物朝向
const { chromium } = require('C:/Users/sgfirstliu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await browser.newContext()).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  await page.goto('http://127.0.0.1:8471', { waitUntil: 'load' });
  await page.waitForFunction('window.__step === "done"', null, { timeout: 90000 });
  await page.click('#btnNew');
  await page.waitForTimeout(1500);

  // 把玩家传送到最近怪物正前方 3m，然后按 J
  const before = await page.evaluate(`(function(){
    var p = G.player, m = G.monsters.find(x=>!x.dead);
    if (!m) return null;
    var pos = m.obj.position;
    // 站在怪物"正前方" = 怪物朝向后 3m；直接站到距离 3m 处并朝向怪物
    var d = new p.obj.position.constructor(Math.sin(m.obj.rotation.y), 0, Math.cos(m.obj.rotation.y));
    p.obj.position.copy(pos).addScaledVector(d, 3.0);
    p.obj.position.y = G.world.heightAt(p.obj.position.x, p.obj.position.z);
    // 面朝怪物：模型前方为 -Z
    var t = pos.clone().sub(p.obj.position); t.y = 0;
    p.obj.rotation.y = Math.atan2(-t.x, -t.z);
    p.yawFace = p.obj.rotation.y;
    return { hp: m.hp, dist: p.obj.position.distanceTo(pos).toFixed(2),
             name: m.spr.material.map.image.dataset.name };
  })()`);
  console.log('怪物:', JSON.stringify(before));
  await page.keyboard.press('j');
  await page.waitForTimeout(700);
  const after = await page.evaluate(`(function(){
    var m = G.monsters.find(x=>!x.dead) || null;
    return m ? { hp: m.hp } : { hp: 0, dead: true };
  })()`);
  console.log('攻击后:', JSON.stringify(after));
  const ok = before && after && (after.hp < before.hp || after.dead);
  console.log(ok ? '✔ 身前怪物受到伤害（朝向/判定正确）' : '✘ 未命中，判定方向可能仍有误');
  console.log('errors =', JSON.stringify(errs.slice(0, 4)));
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
