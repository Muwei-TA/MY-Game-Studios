'use strict';

// ============================================================
// P0 灰盒 —— 血管巡逻队
// 双人同屏:1P 吞噬细胞(WASD + J),2P 调节 T 细胞(方向键 + K)
// 数值来源:design/gdd/p0-slice-spec.md
// ============================================================

const SCALE = 18;        // 像素 / 米
const OX = 60;           // 画布左边距
const OY = 96;           // 画布上边距
const ARENA_W = 60;      // 米
const ARENA_H = 40;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
canvas.width = 1200;
canvas.height = 810;

const NODES = [[10, 10], [30, 30], [50, 10], [10, 32], [50, 32]];
const SPAWNS = [[5, 20], [55, 20]];
const WAVES = [
  { count: 10, batches: [3, 3, 4] },
  { count: 14, batches: [5, 5, 4] },
];
const BATCH_GAP = 8;

const P = {
  playerHp: 100, playerSpeed: 5.5, organHp: 1000,
  dmg: 25, interval: 0.5, range: 3,
  identTime: 0.8, identRange: 4,
  skillCd: 12, skillRange: 3, skillExec: 0.15, skillHeal: 20,
  fieldR: 6, fieldCd: 8, fieldTime: 6, fieldSlow: 0.6, fieldAmp: 1.2,
  purify: 8, assist: 4,
  enemyHp: 120, enemySpeed: 2.2, enemyDmg: 15, enemyInterval: 1.5, enemyRange: 2.2,
  killDebt: 16, execDebt: 4,
  stormThreshold: 85, stormCount: 3, stormTime: 20,
  stormHp: 150, stormSpeed: 3, stormDmg: 10, stormInterval: 1,
  zoneDebt: 50, zoneDps: 1,
  downTime: 45, reviveTime: 2, reviveRange: 2.5, reviveHp: 20,
};

const keys = new Set();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyR') reset();
});
addEventListener('keyup', (e) => keys.delete(e.code));

let S = null;

function reset() {
  S = {
    phase: 'combat',
    wave: 0,
    t: 0,
    health: P.organHp,
    debt: 0,
    enemies: [],
    zones: [],
    stormDone: false,
    spawnIdx: 0,
    waveStart: 0,
    repairStart: 0,
    over: null,
    stats: { combat: [], repair: [], storm: 0, downs: 0, skip: 0 },
    p1: { x: 15, y: 20, hp: P.playerHp, downed: 0, dead: false, atkCd: 0, skillCd: 0, retreat: 0 },
    p2: { x: 45, y: 20, hp: P.playerHp, downed: 0, dead: false, fieldCd: 0, fieldTime: 0 },
  };
  startWave(0);
}

function startWave(i) {
  S.wave = i;
  S.phase = 'combat';
  S.enemies = [];
  S.zones = [];
  S.spawnIdx = 0;
  S.stormDone = false;
  S.waveStart = S.t;
  S.waveDebtStart = S.debt;
  S.batchTimes = [];
  let acc = 0;
  for (const n of WAVES[i].batches) {
    S.batchTimes.push({ t: acc, n });
    acc += BATCH_GAP;
  }
}

function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function move(p, tx, ty, speed, dt) {
  const dx = tx - p.x, dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return;
  const step = Math.min(speed * dt, d);
  p.x = clamp(p.x + (dx / d) * step, 0, ARENA_W);
  p.y = clamp(p.y + (dy / d) * step, 0, ARENA_H);
}

// ---------------- 战斗段 ----------------
function updateCombat(dt) {
  const elapsed = S.t - S.waveStart;

  while (S.spawnIdx < S.batchTimes.length && S.batchTimes[S.spawnIdx].t <= elapsed) {
    const n = S.batchTimes[S.spawnIdx].n;
    for (let i = 0; i < n; i++) spawnEnemy();
    S.spawnIdx++;
  }

  const p1 = S.p1, p2 = S.p2;
  const alive = S.enemies.filter((e) => e.kind === 'enemy' && e.hp > 0);

  // --- 1P 吞噬细胞 ---
  if (p1.downed === 0 && !p1.dead) {
    let vx = 0, vy = 0;
    if (keys.has('KeyW')) vy -= 1;
    if (keys.has('KeyS')) vy += 1;
    if (keys.has('KeyA')) vx -= 1;
    if (keys.has('KeyD')) vx += 1;
    const len = Math.hypot(vx, vy);
    if (len > 0) {
      p1.x = clamp(p1.x + (vx / len) * P.playerSpeed * dt, 0, ARENA_W);
      p1.y = clamp(p1.y + (vy / len) * P.playerSpeed * dt, 0, ARENA_H);
    }
    p1.atkCd -= dt;
    p1.skillCd -= dt;

    // 识别
    for (const e of alive) {
      if (e.identified) continue;
      if (dist(p1.x, p1.y, e.x, e.y) <= P.identRange) {
        e.identAcc += dt;
        if (e.identAcc >= P.identTime) e.identified = true;
      }
    }
    // 自动攻击最近目标
    if (alive.length) {
      const target = alive.reduce((a, b) => (dist(p1.x, p1.y, a.x, a.y) < dist(p1.x, p1.y, b.x, b.y) ? a : b));
      if (dist(p1.x, p1.y, target.x, target.y) <= P.range && p1.atkCd <= 0) {
        let dmg = P.dmg * (target.identified ? 1 : 0.5);
        if (p2.fieldTime > 0 && dist(p2.x, p2.y, target.x, target.y) <= P.fieldR) dmg *= P.fieldAmp;
        target.hp -= dmg;
        target.flash = 0.12;
        p1.atkCd = P.interval;
      }
    }
    // J: 吞噬处决
    if (keys.has('KeyJ') && p1.skillCd <= 0) {
      const ex = alive.find((e) => e.hp <= P.enemyHp * P.skillExec && dist(p1.x, p1.y, e.x, e.y) <= P.skillRange);
      if (ex) {
        ex.hp = 0;
        ex.lastHit = 'p1';
        p1.skillCd = P.skillCd;
        p1.hp = Math.min(P.playerHp, p1.hp + P.skillHeal);
        S.debt += P.execDebt;
      }
    }
  }

  // --- 2P 调节 T 细胞 ---
  if (p2.downed === 0 && !p2.dead) {
    let vx = 0, vy = 0;
    if (keys.has('ArrowUp')) vy -= 1;
    if (keys.has('ArrowDown')) vy += 1;
    if (keys.has('ArrowLeft')) vx -= 1;
    if (keys.has('ArrowRight')) vx += 1;
    const len = Math.hypot(vx, vy);
    if (len > 0) {
      p2.x = clamp(p2.x + (vx / len) * P.playerSpeed * dt, 0, ARENA_W);
      p2.y = clamp(p2.y + (vy / len) * P.playerSpeed * dt, 0, ARENA_H);
    }
    p2.fieldCd -= dt;
    if (p2.fieldTime > 0) p2.fieldTime -= dt;
    if (keys.has('KeyK') && p2.fieldCd <= 0 && p2.fieldTime <= 0) {
      p2.fieldTime = P.fieldTime;
      p2.fieldCd = P.fieldCd;
    }
  }

  // --- 敌人 ---
  for (const e of S.enemies) {
    if (e.hp <= 0) continue;
    if (e.kind === 'neutral') e.life -= dt;
    e.atkCd -= dt;
    if (e.flash > 0) e.flash -= dt;

    let target = null, td = 1e9;
    if (p1.downed === 0 && !p1.dead) { const d = dist(e.x, e.y, p1.x, p1.y); if (d < td) { td = d; target = p1; } }
    if (p2.downed === 0 && !p2.dead) { const d = dist(e.x, e.y, p2.x, p2.y); if (d < td) { td = d; target = p2; } }
    if (e.kind === 'neutral') {
      for (const o of S.enemies) {
        if (o === e || o.kind === 'neutral' || o.hp <= 0) continue;
        const d = dist(e.x, e.y, o.x, o.y);
        if (d < td) { td = d; target = o; }
      }
    }
    if (!target) continue;

    let speed = e.speed;
    if (p2.fieldTime > 0 && dist(p2.x, p2.y, e.x, e.y) <= P.fieldR) speed *= P.fieldSlow;
    if (td > P.enemyRange) {
      move(e, target.x, target.y, speed, dt);
    } else if (e.atkCd <= 0) {
      const dmg = e.kind === 'neutral' ? P.stormDmg : P.enemyDmg;
      if (target === p1 || target === p2) {
        if (!target.dead) target.hp -= dmg;
      } else {
        target.hp -= (P.enemyDmg);
        target.lastHit = 'neutral';
      }
      e.atkCd = e.kind === 'neutral' ? P.stormInterval : P.enemyInterval;
    }
  }

  // --- 清理死亡 ---
  for (const e of S.enemies) {
    if (e.hp <= 0 && !e.counted) {
      e.counted = true;
      if (e.kind === 'enemy') S.debt += e.lastHit === 'neutral' ? P.killDebt / 2 : P.killDebt;
    }
  }
  S.enemies = S.enemies.filter((e) => e.hp > 0 && !(e.kind === 'neutral' && e.life <= 0));

  // --- 免疫风暴 ---
  if (!S.stormDone && S.debt - S.waveDebtStart >= P.stormThreshold) {
    S.stormDone = true;
    S.stats.storm += 1;
    for (let i = 0; i < P.stormCount; i++) {
      const sp = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
      S.enemies.push({ x: sp[0], y: sp[1], hp: P.stormHp, speed: P.stormSpeed, kind: 'neutral', life: P.stormTime, atkCd: 0, identified: true, identAcc: 1, flash: 0, count: true });
    }
  }

  // --- 倒地 ---
  updateDowned(dt);
  if (S.over) return;

  // --- 波次结束 ---
  if (S.spawnIdx >= S.batchTimes.length && !S.enemies.some((e) => e.kind === 'enemy')) {
    S.stats.combat.push(+(S.t - S.waveStart).toFixed(1));
    startRepair();
  }
}

function spawnEnemy() {
  const sp = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
  S.enemies.push({
    x: sp[0] + (Math.random() - 0.5) * 4,
    y: sp[1] + (Math.random() - 0.5) * 4,
    hp: P.enemyHp, speed: P.enemySpeed, kind: 'enemy',
    identified: false, identAcc: 0, atkCd: 0, life: 1e9, flash: 0,
  });
}

// ---------------- 维修段 ----------------
function startRepair() {
  S.phase = 'repair';
  S.repairStart = S.t;
  const zones = Math.ceil(S.debt / P.zoneDebt);
  S.zones = [];
  if (zones === 0) { endRepair(); return; }
  const per = S.debt / zones;
  for (let i = 0; i < zones; i++) {
    const n = NODES[i % NODES.length];
    S.zones.push({ x: n[0] + (Math.random() - 0.5) * 3, y: n[1] + (Math.random() - 0.5) * 3, debt: per });
  }
}

function updateRepair(dt) {
  const p1 = S.p1, p2 = S.p2;
  const active = S.zones.filter((z) => z.debt > 0);
  if (!active.length) { endRepair(); return; }

  S.health -= active.length * P.zoneDps * dt;
  if (S.health <= 0) { S.health = 0; gameOver('器官衰竭'); return; }

  // 提前跳波
  if (keys.has('Space')) { skipRepair(); return; }

  // 2P 净化
  if (p2.downed === 0 && !p2.dead) {
    let vx = 0, vy = 0;
    if (keys.has('ArrowUp')) vy -= 1;
    if (keys.has('ArrowDown')) vy += 1;
    if (keys.has('ArrowLeft')) vx -= 1;
    if (keys.has('ArrowRight')) vx += 1;
    const len = Math.hypot(vx, vy);
    if (len > 0) {
      p2.x = clamp(p2.x + (vx / len) * P.playerSpeed * dt, 0, ARENA_W);
      p2.y = clamp(p2.y + (vy / len) * P.playerSpeed * dt, 0, ARENA_H);
    }
    const z = active.reduce((a, b) => (dist(p2.x, p2.y, a.x, a.y) < dist(p2.x, p2.y, b.x, b.y) ? a : b));
    if (dist(p2.x, p2.y, z.x, z.y) <= 2.2) {
      const amt = Math.min(P.purify * dt, z.debt);
      z.debt -= amt; S.debt -= amt;
    }
  }
  // 1P 协助
  if (p1.downed === 0 && !p1.dead) {
    let vx = 0, vy = 0;
    if (keys.has('KeyW')) vy -= 1;
    if (keys.has('KeyS')) vy += 1;
    if (keys.has('KeyA')) vx -= 1;
    if (keys.has('KeyD')) vx += 1;
    const len = Math.hypot(vx, vy);
    if (len > 0) {
      p1.x = clamp(p1.x + (vx / len) * P.playerSpeed * dt, 0, ARENA_W);
      p1.y = clamp(p1.y + (vy / len) * P.playerSpeed * dt, 0, ARENA_H);
    }
    const z = active.reduce((a, b) => (dist(p1.x, p1.y, a.x, a.y) < dist(p1.x, p1.y, b.x, b.y) ? a : b));
    if (dist(p1.x, p1.y, z.x, z.y) <= 2.2) {
      const amt = Math.min(P.assist * dt, z.debt);
      z.debt -= amt; S.debt -= amt;
      S.assistAcc = (S.assistAcc || 0) + amt;
      if (S.assistAcc >= 10) { S.assistAcc -= 10; S.debt += 1; }
    }
  }

  updateDowned(dt);
  if (S.over) return;

  if (!S.zones.some((z) => z.debt > 0)) endRepair();
}

function skipRepair() {
  S.stats.skip += 1;
  S.debt = Math.ceil(S.debt * 1.1);
  S.stats.repair.push(0);
  nextWave();
}

function endRepair() {
  S.stats.repair.push(+(S.t - S.repairStart).toFixed(1));
  nextWave();
}

function nextWave() {
  if (S.wave === WAVES.length - 1) { gameOver('通关'); return; }
  S.debt = Math.max(0, S.debt);
  startWave(S.wave + 1);
}

// ---------------- 倒地 ----------------
function updateDowned(dt) {
  const p1 = S.p1, p2 = S.p2;
  for (const p of [p1, p2]) {
    if (!p.dead && p.downed === 0 && p.hp <= 0) {
      p.downed = P.downTime;
      S.stats.downs += 1;
    }
    if (p.downed > 0) {
      p.downed -= dt;
      if (p.downed <= 0) { p.downed = 0; p.dead = true; }
    }
  }
  // 互相救援
  if (p1.downed > 0 && p2.downed === 0 && !p2.dead && dist(p1.x, p1.y, p2.x, p2.y) <= P.reviveRange) {
    p1.reviveAcc = (p1.reviveAcc || 0) + dt;
    if (p1.reviveAcc >= P.reviveTime) { p1.downed = 0; p1.hp = P.reviveHp; p1.reviveAcc = 0; }
  } else { p1.reviveAcc = 0; }
  if (p2.downed > 0 && p1.downed === 0 && !p1.dead && dist(p1.x, p1.y, p2.x, p2.y) <= P.reviveRange) {
    p2.reviveAcc = (p2.reviveAcc || 0) + dt;
    if (p2.reviveAcc >= P.reviveTime) { p2.downed = 0; p2.hp = P.reviveHp; p2.reviveAcc = 0; }
  } else { p2.reviveAcc = 0; }

  if ((p1.downed > 0 || p1.dead) && (p2.downed > 0 || p2.dead)) { gameOver('全员倒地'); return; }
  if (p1.dead) { gameOver('吞噬细胞阵亡'); return; }
}

function gameOver(reason) {
  if (S.over) return;
  S.over = {
    reason,
    win: reason === '通关',
    combat: S.stats.combat.slice(),
    repair: S.stats.repair.slice(),
    healthLoss: Math.round(P.organHp - Math.max(0, S.health)),
    storm: S.stats.storm,
    downs: S.stats.downs,
    skip: S.stats.skip,
  };
}

// ---------------- 渲染 ----------------
function m2x(x) { return OX + x * SCALE; }
function m2y(y) { return OY + y * SCALE; }

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 背景
  ctx.fillStyle = '#1a0a10';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 血管地面
  ctx.fillStyle = '#3a0f1c';
  ctx.fillRect(OX, OY, ARENA_W * SCALE, ARENA_H * SCALE);
  ctx.strokeStyle = '#5c1b2e';
  ctx.lineWidth = 2;
  ctx.strokeRect(OX, OY, ARENA_W * SCALE, ARENA_H * SCALE);

  // 维修节点
  for (const n of NODES) {
    ctx.beginPath();
    ctx.arc(m2x(n[0]), m2y(n[1]), 100, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,140,160,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 增援口
  for (const sp of SPAWNS) {
    ctx.beginPath();
    ctx.arc(m2x(sp[0]), m2y(sp[1]), 14, 0, Math.PI * 2);
    ctx.fillStyle = '#7a2030';
    ctx.fill();
  }

  // 炎症区
  for (const z of S.zones) {
    if (z.debt <= 0) continue;
    const r = 30 + Math.min(30, z.debt / 2);
    const g = ctx.createRadialGradient(m2x(z.x), m2y(z.y), 4, m2x(z.x), m2y(z.y), r);
    g.addColorStop(0, 'rgba(255,60,60,0.55)');
    g.addColorStop(1, 'rgba(255,60,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(m2x(z.x), m2y(z.y), r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffd7d7';
    ctx.font = '12px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(Math.ceil(z.debt), m2x(z.x), m2y(z.y) + 4);
  }

  // 抑制场
  const p2 = S.p2;
  if (p2.fieldTime > 0) {
    ctx.beginPath();
    ctx.arc(m2x(p2.x), m2y(p2.y), P.fieldR * SCALE, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120,200,255,0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,200,255,0.5)';
    ctx.stroke();
  }

  // 玩家
  drawPlayer(S.p1, '#7ee787', '吞');
  drawPlayer(S.p2, '#79c0ff', '调');

  // 敌人
  for (const e of S.enemies) {
    if (e.hp <= 0) continue;
    const r = e.kind === 'neutral' ? 11 : 8;
    ctx.beginPath();
    ctx.arc(m2x(e.x), m2y(e.y), r, 0, Math.PI * 2);
    if (e.kind === 'neutral') ctx.fillStyle = '#b388ff';
    else if (e.identified) ctx.fillStyle = '#ffa657';
    else ctx.fillStyle = '#8b949e';
    ctx.fill();
    if (e.flash > 0) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  drawHUD();
  if (S.over) drawOver();
}

function drawPlayer(p, color, label) {
  if (p.dead) return;
  const r = 11;
  ctx.beginPath();
  ctx.arc(m2x(p.x), m2y(p.y), r, 0, Math.PI * 2);
  ctx.fillStyle = p.downed > 0 ? '#555' : color;
  ctx.fill();
  ctx.strokeStyle = '#0d1117';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#0d1117';
  ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, m2x(p.x), m2y(p.y) + 1);
  ctx.textBaseline = 'alphabetic';
  // 名字
  ctx.fillStyle = color;
  ctx.font = '11px "Microsoft YaHei", sans-serif';
  ctx.fillText(label === '吞' ? '1P 吞噬' : '2P 调节T', m2x(p.x), m2y(p.y) - 16);
  // 血条
  const w = 34;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(m2x(p.x) - w / 2, m2y(p.y) + 16, w, 4);
  ctx.fillStyle = p.downed > 0 ? '#888' : '#3fb950';
  ctx.fillRect(m2x(p.x) - w / 2, m2y(p.y) + 16, w * Math.max(0, p.hp / P.playerHp), 4);
}

function drawHUD() {
  ctx.textAlign = 'left';
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 18px "Microsoft YaHei", sans-serif';
  ctx.fillText('血管巡逻队 · P0 灰盒', OX, 34);

  ctx.font = '14px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#8b949e';
  const phaseName = S.phase === 'combat' ? '交战' : '维修';
  ctx.fillText(`阶段:${phaseName}   波次:${S.wave + 1}/${WAVES.length}   时间:${S.t.toFixed(1)}s`, OX, 60);

  // 器官健康
  const barW = 340;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(OX + 480, 26, barW, 16);
  ctx.fillStyle = S.health > 300 ? '#3fb950' : '#f85149';
  ctx.fillRect(OX + 480, 26, barW * Math.max(0, S.health / P.organHp), 16);
  ctx.fillStyle = '#e6edf3';
  ctx.fillText(`器官健康 ${Math.max(0, Math.round(S.health))}`, OX + 480, 20);

  // 欠账
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(OX + 480, 58, barW, 16);
  ctx.fillStyle = '#ff7b72';
  ctx.fillRect(OX + 480, 58, barW * Math.min(1, S.debt / 400), 16);
  ctx.fillStyle = '#e6edf3';
  ctx.fillText(`欠账 ${Math.ceil(S.debt)}`, OX + 480, 52);

  // 操作提示
  ctx.fillStyle = '#8b949e';
  ctx.font = '12px "Microsoft YaHei", sans-serif';
  ctx.fillText('1P:WASD 移动 / J 吞噬处决(自动普攻)    2P:方向键移动 / K 抑制场    维修段:站在炎症区自动净化,Space 提前跳波    R 重开', OX, canvas.height - 12);
}

function drawOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(OX, OY, ARENA_W * SCALE, ARENA_H * SCALE);
  const cx = OX + (ARENA_W * SCALE) / 2;
  const cy = OY + (ARENA_H * SCALE) / 2;
  ctx.textAlign = 'center';
  ctx.fillStyle = S.over.win ? '#3fb950' : '#f85149';
  ctx.font = 'bold 34px "Microsoft YaHei", sans-serif';
  ctx.fillText(S.over.win ? '器官保住了' : '器官衰竭', cx, cy - 120);
  ctx.fillStyle = '#e6edf3';
  ctx.font = '16px "Microsoft YaHei", sans-serif';
  ctx.fillText(`结局:${S.over.reason}`, cx, cy - 80);
  const c = S.over.combat, r = S.over.repair;
  ctx.fillText(`交战时长:${c.map((x) => x + 's').join(' / ') || '-'}`, cx, cy - 44);
  ctx.fillText(`维修时长:${r.map((x) => (x || 0) + 's').join(' / ') || '-'}`, cx, cy - 16);
  ctx.fillText(`健康损耗:${S.over.healthLoss}  (${(S.over.healthLoss / P.organHp * 100).toFixed(1)}%)`, cx, cy + 12);
  ctx.fillText(`免疫风暴:${S.over.storm} 次   倒地:${S.over.downs} 次   提前跳波:${S.over.skip} 次`, cx, cy + 40);
  ctx.fillStyle = '#8b949e';
  ctx.fillText('按 R 重开', cx, cy + 92);
}

// ---------------- 主循环 ----------------
let last = performance.now();
function loop(now) {
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05);
  if (!S.over) {
    S.t += dt;
    if (S.phase === 'combat') updateCombat(dt);
    else updateRepair(dt);
  }
  draw();
  requestAnimationFrame(loop);
}

reset();
requestAnimationFrame(loop);