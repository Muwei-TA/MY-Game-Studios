'use strict';
// 灰盒逻辑自测:打桩 canvas / DOM,在 Node 里驱动 game.js 的更新函数
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8');

const noop = () => {};
function makeCtx() {
  const gradient = { addColorStop: noop };
  return new Proxy({}, {
    get(t, k) {
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => gradient;
      if (typeof k === 'string' && k in t) return t[k];
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
const ctxStub = makeCtx();
const canvasStub = { width: 1200, height: 810, getContext: () => ctxStub };

const sandbox = {
  document: { getElementById: () => canvasStub },
  addEventListener: noop,
  performance: { now: () => Date.now() },
  requestAnimationFrame: noop,
  console,
  Math,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const harness = `
;(function () {
  const report = { steps: [] };
  const step = (name, ok, detail) => report.steps.push({ name, ok, detail });

  reset();
  step('initial', S.phase === 'combat' && S.enemies.length === 0 && S.health === P.organHp,
       JSON.stringify({ phase: S.phase, health: S.health }));

  // --- 1. 交战:生成敌人 + 击杀记债 ---
  S.debt = 0;
  for (let i = 0; i < 60; i++) updateCombat(0.05);
  step('spawn', S.enemies.length > 0, 'enemies=' + S.enemies.length);

  // 手动击杀一只,验证债务 +16
  S.enemies[0].hp = 0;
  S.enemies[0].lastHit = 'p1';
  updateCombat(0.05);
  step('kill-debt', S.debt >= 16, 'debt=' + S.debt);

  // --- 2. 清场 -> 维修段 ---
  S.debt = 160;
  S.spawnIdx = S.batchTimes.length;
  S.enemies = [];
  updateCombat(0.05);
  step('to-repair', S.phase === 'repair' && S.zones.length === 4,
       'phase=' + S.phase + ' zones=' + S.zones.length);

  // --- 3. 维修:两人站进炎症区,应能清空并进入下一波 ---
  let guard = 0;
  while (S.phase === 'repair' && guard++ < 4000) {
    const z = S.zones.find(z => z.debt > 0) || S.zones[0];
    if (z) { S.p1.x = z.x; S.p1.y = z.y; S.p2.x = z.x; S.p2.y = z.y; }
    updateRepair(0.05);
    if (S.phase === 'repair' && !S.zones.some(z => z.debt > 0)) break;
    if (S.phase === 'combat') break;
  }
  step('repair-cleared', S.phase === 'combat' && S.wave === 1 && S.stats.repair.length === 1,
       JSON.stringify({ phase: S.phase, wave: S.wave, repair: S.stats.repair }));

  // --- 4. 免疫风暴:债务到线应刷出失控友军 ---
  reset();
  S.stormDone = false;
  S.debt = 0;
  S.waveDebtStart = 0;
  S.spawnIdx = S.batchTimes.length;
  S.enemies = [];
  S.debt = 90;
  updateCombat(0.05);
  const neutrals = S.enemies.filter(e => e.kind === 'neutral').length;
  step('storm', S.stormDone === true && neutrals === 3, 'neutrals=' + neutrals);

  // --- 5. 倒地与救援 ---
  reset();
  S.p1.hp = -1;
  updateCombat(0.05);
  const downed = S.p1.downed > 0;
  S.p2.x = S.p1.x; S.p2.y = S.p1.y;
  for (let i = 0; i < 120; i++) updateDowned(0.05);
  step('revive', downed && S.p1.downed === 0 && S.p1.hp === P.reviveHp,
       JSON.stringify({ downed, hp: S.p1.hp, downs: S.stats.downs }));

  // --- 6. 提前跳波:债务保留并放大 ---
  reset();
  S.debt = 200;
  S.spawnIdx = S.batchTimes.length;
  S.enemies = [];
  updateCombat(0.05);
  const before = S.debt;
  S.phase = 'repair';
  skipRepair();
  step('skip', S.wave === 1 && S.debt === Math.ceil(before * 1.1),
       'before=' + before + ' after=' + S.debt + ' wave=' + S.wave);

  // --- 7. 器官衰竭 ---
  reset();
  S.health = 1;
  S.debt = 200;
  S.spawnIdx = S.batchTimes.length;
  S.enemies = [];
  updateCombat(0.05);
  let g2 = 0;
  while (!S.over && g2++ < 2000) { updateRepair(0.05); }
  step('organ-fail', S.over && S.over.reason === '器官衰竭',
       JSON.stringify({ over: S.over && S.over.reason, health: S.health }));

  // --- 8. 渲染路径不抛异常 ---
  try { draw(); drawOver(); step('draw', true, 'canvas 调用无异常'); }
  catch (e) { step('draw', false, e.message); }

  globalThis.__R = report;
})();
`;

const script = src + '\n' + harness;
vm.runInContext(script, sandbox, { filename: 'game+tests.js' });

const r = sandbox.__R;
let pass = 0;
for (const s of r.steps) {
  console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name}  ${s.detail || ''}`);
  if (s.ok) pass++;
}
console.log(`\n${pass}/${r.steps.length} passed`);
process.exit(pass === r.steps.length ? 0 : 1);