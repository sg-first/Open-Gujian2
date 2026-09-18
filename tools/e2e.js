const { chromium } = require('C:/Users/sgfirstliu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core');

const PORT = process.argv[2] || 8471;

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 200)); });

  await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'load' });
  await page.waitForFunction('window.__step === "done"', null, { timeout: 60000 });
  await page.click('#btnNew');
  await page.waitForTimeout(9000);
  await page.screenshot({ path: 'shot_a.png' });

  // 传送到第一个 NPC 面前对话
  await page.evaluate(`(function(){
    var npc=G.npcs[0], p=G.player.obj.position;
    var d=npc.obj.position.clone().sub(p); d.y=0; d.normalize();
    p.copy(npc.obj.position).addScaledVector(d,-3);
    p.y=G.world.heightAt(p.x,p.z);
    G.yaw=Math.atan2(d.x,d.z)+Math.PI;
  })()`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'shot_npc.png' });
  await page.keyboard.press('f');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'shot_dialog.png' });
  const dlg = await page.evaluate('document.getElementById("dlgText").textContent');
  console.log('dlgText =', JSON.stringify(dlg));
  await page.keyboard.press('Escape');

  // 采集: 传送到一个 pickup
  await page.evaluate(`(function(){
    var pk=G.pickups.find(function(q){return !q.taken;});
    var p=G.player.obj.position;
    p.copy(pk.obj.position).add({x:1.5,y:0,z:0});
    p.y=G.world.heightAt(p.x,p.z);
  })()`);
  await page.waitForTimeout(1500);
  await page.keyboard.press('f');
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'shot_pick.png' });

  // 妖兽战斗: 传送到妖兽旁
  await page.evaluate(`(function(){
    var m=G.monsters[0], p=G.player.obj.position;
    var d=m.obj.position.clone().sub(p); d.y=0; d.normalize();
    p.copy(m.obj.position).addScaledVector(d,-2.5);
    p.y=G.world.heightAt(p.x,p.z);
  })()`);
  await page.waitForTimeout(1500);
  for (let i = 0; i < 10; i++) {
    // 保持贴身，模拟真实追打
    await page.evaluate(`(function(){
      var m=G.monsters.find(function(q){return !q.dead;}); if(!m) return;
      var p=G.player.obj.position, d=m.obj.position.clone().sub(p); d.y=0;
      var L=d.length(); if(L>2.2){ d.normalize(); p.addScaledVector(d, L-2.0); }
      p.y=G.world.heightAt(p.x,p.z);
    })()`);
    await page.keyboard.press('j');
    await page.waitForTimeout(620);
  }
  await page.screenshot({ path: 'shot_combat.png' });

  const report = await page.evaluate(`(function(){
    return JSON.stringify({hp:Math.round(G.player.hp), maxHp:G.player.maxHp, lvl:G.player.lvl,
      kills:G.kills, alive:G.player.alive,
      herb:G.herbGot||0, monsters:G.monsters.length, npcs:G.npcs.length,
      pickupsLeft:G.pickups.filter(function(q){return !q.taken;}).length,
      props:(G.propObjs||[]).length, propProto:(G.props||[]).length,
      playerH:G.player.height, npcH:G.npcs[0]?G.npcs[0].def.model:null,
      inv:Object.keys(G.inventory)});
  })()`);
  console.log('report =', report);
  console.log('errors =', JSON.stringify(errors.slice(0, 6)));
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
