"""
P0 可玩验证版 —— 数值蒙特卡洛校验

按 design/gdd/p0-slice-spec.md 的数值跑大量对局,统计节奏与失败分布。
AI 行为:吞噬细胞走位放风筝、被围时后撤;调节 T 细胞保持后排并找时机开抑制场。

用法:
  python sim.py
输出:
  控制台 ASCII 摘要(避免中文控制台编码问题)
"""

import math
import random
import statistics
from dataclasses import dataclass

TICK = 0.05
NODES = [(10.0, 10.0), (30.0, 30.0), (50.0, 10.0), (10.0, 32.0), (50.0, 32.0)]
SPAWNS = [(5.0, 20.0), (55.0, 20.0)]
WAVES = [(10, [3, 3, 4]), (14, [5, 5, 4])]
BATCH_GAP = 8.0

PLAYER_HP = 100.0
PLAYER_SPEED = 5.5
ORGAN_HP = 1000.0

P1_DMG = 25.0
P1_INTERVAL = 0.5
P1_RANGE = 3.0
P1_IDENT_TIME = 0.8
P1_IDENT_RANGE = 4.0
P1_UNIDENTIFIED_MULT = 0.5
P1_SKILL_CD = 12.0
P1_SKILL_RANGE = 3.0
P1_SKILL_EXEC = 0.15
P1_SKILL_HEAL = 20.0

P2_FIELD_RADIUS = 6.0
P2_FIELD_CD = 8.0
P2_FIELD_TIME = 6.0
P2_FIELD_SLOW = 0.6
P2_FIELD_AMP = 1.2
P2_PURIFY = 8.0
P2_FOLLOW = 5.0

P1_ASSIST_PURIFY = 4.0
P1_ASSIST_PER_10 = 1.0

ENEMY_HP = 120.0
ENEMY_SPEED = 2.2
ENEMY_DMG = 15.0
ENEMY_INTERVAL = 1.5
ENEMY_RANGE = 2.2
ENEMY_AGGRO = 12.0

KILL_DEBT = 16.0
EXECUTE_DEBT = 4.0
NEUTRAL_KILL_DEBT = 8.0

STORM_THRESHOLD = 85.0
STORM_COUNT = 3
STORM_TIME = 20.0
STORM_HP = 150.0
STORM_SPEED = 3.0
STORM_DMG = 10.0
STORM_INTERVAL = 1.0

ZONE_DEBT = 50.0
ZONE_DPS = 1.0
SKIP_HEALTH = 0.0   # 提前跳波时,未还债务在交战段继续灼烧的近似伤害系数

# 调参方案:用 `python sim.py tuned` 跑第二套
TUNING = {
    "v3": {
        "ENEMY_HP": 260.0,
        "WAVES": [(12, [4, 4, 4]), (16, [5, 6, 5])],
        "ZONE_DPS": 1.0,
    },
    "tuned": {
        "ENEMY_HP": 180.0,
        "ENEMY_DMG": 18.0,
        "ENEMY_SPEED": 2.4,
        "WAVES": [(12, [4, 4, 4]), (16, [5, 6, 5])],
        "P2_PURIFY": 5.0,
        "P1_ASSIST_PURIFY": 3.0,
        "ZONE_DPS": 2.0,
        "SKIP_HEALTH": 1.0,
    },
}

DOWN_TIME = 45.0
REVIVE_TIME = 2.0
REVIVE_RANGE = 2.5
REVIVE_HP = 20.0


def dist(ax, ay, bx, by):
    return math.hypot(ax - bx, ay - by)


@dataclass
class Ent:
    x: float
    y: float
    hp: float
    speed: float
    kind: str = "enemy"
    identified: bool = False
    ident_acc: float = 0.0
    atk_cd: float = 0.0
    life: float = 1e9
    last_hit: str = ""


@dataclass
class P:
    x: float
    y: float
    hp: float = PLAYER_HP
    downed: float = 0.0     # >0 倒地计时, -1 已阵亡
    atk_cd: float = 0.0
    skill_cd: float = 0.0
    field_cd: float = 0.0
    field_time: float = 0.0
    revive_acc: float = 0.0
    retreat: float = 0.0
    down_count: int = 0


def move_toward(p, tx, ty, speed, dt):
    dx, dy = tx - p.x, ty - p.y
    d = math.hypot(dx, dy)
    if d < 1e-6:
        return
    step = min(speed * dt, d)
    p.x += dx / d * step
    p.y += dy / d * step


def alive_enemies(enemies):
    return [e for e in enemies if e.kind == "enemy" and e.hp > 0]


def p1_ai(p1, p2, enemies, dt, eff):
    """吞噬细胞:接近最近目标,被围时后撤。"""
    targets = alive_enemies(enemies)
    if p1.downed != 0:
        return
    p1.atk_cd -= dt
    p1.skill_cd -= dt
    if p1.retreat > 0:
        p1.retreat -= dt
    for e in targets:
        if dist(p1.x, p1.y, e.x, e.y) <= P1_IDENT_RANGE and not e.identified:
            e.ident_acc += dt
            if e.ident_acc >= P1_IDENT_TIME:
                e.identified = True
    # 优先救队友
    reviving = False
    if p2.downed > 0:
        if dist(p1.x, p1.y, p2.x, p2.y) > 1.5:
            move_toward(p1, p2.x, p2.y, PLAYER_SPEED, dt)
        reviving = True
    if not targets:
        if not reviving:
            move_toward(p1, 30.0, 20.0, PLAYER_SPEED, dt)
        return
    target = min(targets, key=lambda e: dist(p1.x, p1.y, e.x, e.y))
    td = dist(p1.x, p1.y, target.x, target.y)
    near = [e for e in targets if dist(p1.x, p1.y, e.x, e.y) <= 2.6]
    if len(near) >= 1 and p1.hp < 55 and p1.retreat <= 0:
        p1.retreat = 1.0
    if reviving:
        pass
    elif p1.retreat > 0:
        # 远离最近的敌人
        nx, ny = 0.0, 0.0
        for e in near:
            nx += p1.x - e.x
            ny += p1.y - e.y
        n = math.hypot(nx, ny)
        if n > 1e-6:
            move_toward(p1, p1.x + nx / n * 5, p1.y + ny / n * 5, PLAYER_SPEED, dt)
    elif td > P1_RANGE - 0.2:
        move_toward(p1, target.x, target.y, PLAYER_SPEED, dt)
    # 攻击
    if dist(p1.x, p1.y, target.x, target.y) <= P1_RANGE and p1.atk_cd <= 0:
        dmg = P1_DMG * (1.0 if target.identified else P1_UNIDENTIFIED_MULT)
        if p2.field_time > 0 and dist(p2.x, p2.y, target.x, target.y) <= P2_FIELD_RADIUS:
            dmg *= P2_FIELD_AMP
        target.hp -= dmg
        target.last_hit = "p1"
        p1.atk_cd = P1_INTERVAL / max(eff, 0.2)
    # 技能
    if p1.skill_cd <= 0:
        for e in targets:
            if e.hp <= ENEMY_HP * P1_SKILL_EXEC and dist(p1.x, p1.y, e.x, e.y) <= P1_SKILL_RANGE:
                e.hp = 0.0
                e.last_hit = "p1"
                p1.skill_cd = P1_SKILL_CD
                p1.hp = min(PLAYER_HP, p1.hp + P1_SKILL_HEAL)
                p1.debt_from_skill = getattr(p1, "debt_from_skill", 0.0) + EXECUTE_DEBT
                break


def p2_ai(p1, p2, enemies, dt):
    if p2.downed != 0:
        return
    p2.field_cd -= dt
    if p2.field_time > 0:
        p2.field_time -= dt
    targets = alive_enemies(enemies)
    d_to_p1 = dist(p2.x, p2.y, p1.x, p1.y)
    # 被贴脸就拉开
    if targets:
        nearest = min(targets, key=lambda e: dist(p2.x, p2.y, e.x, e.y))
        nd = dist(p2.x, p2.y, nearest.x, nearest.y)
        if nd < 4.0:
            dx, dy = p2.x - nearest.x, p2.y - nearest.y
            n = math.hypot(dx, dy)
            if n > 1e-6:
                move_toward(p2, p2.x + dx / n * 6, p2.y + dy / n * 6, PLAYER_SPEED, dt)
            return
    # 优先救队友(场上安全时)
    if p1.downed > 0:
        if d_to_p1 > 1.5:
            move_toward(p2, p1.x, p1.y, PLAYER_SPEED, dt)
        return
    if d_to_p1 > P2_FOLLOW + 1.5:
        move_toward(p2, p1.x, p1.y, PLAYER_SPEED, dt)
    elif d_to_p1 < P2_FOLLOW - 1.0:
        move_toward(p2, p2.x + (p2.x - p1.x), p2.y + (p2.y - p1.y), PLAYER_SPEED, dt)
    near_p1 = [e for e in targets if dist(p1.x, p1.y, e.x, e.y) <= P2_FIELD_RADIUS]
    if p2.field_cd <= 0 and p2.field_time <= 0 and len(near_p1) >= 2:
        if dist(p2.x, p2.y, p1.x, p1.y) > 3.5:
            move_toward(p2, p1.x, p1.y, PLAYER_SPEED, dt)
        else:
            p2.field_time = P2_FIELD_TIME
            p2.field_cd = P2_FIELD_CD


def enemy_ai(p1, p2, enemies, dt):
    for e in enemies:
        if e.hp <= 0:
            continue
        if e.kind == "neutral":
            e.life -= dt
        e.atk_cd -= dt
        cands = []
        if p1.downed == 0:
            cands.append((dist(e.x, e.y, p1.x, p1.y), "p1"))
        if p2.downed == 0:
            cands.append((dist(e.x, e.y, p2.x, p2.y), "p2"))
        if e.kind == "neutral":
            for o in enemies:
                if o is e or o.kind == "neutral" or o.hp <= 0:
                    continue
                cands.append((dist(e.x, e.y, o.x, o.y), "enemy", o))
        if not cands:
            continue
        cands.sort(key=lambda c: c[0])
        d = cands[0][0]
        who = cands[0][1]
        if d > ENEMY_AGGRO and who != "enemy":
            continue
        speed = e.speed
        if p2.field_time > 0 and dist(p2.x, p2.y, e.x, e.y) <= P2_FIELD_RADIUS:
            speed *= P2_FIELD_SLOW
        if who == "p1":
            if d > ENEMY_RANGE:
                move_toward(e, p1.x, p1.y, speed, dt)
            elif e.atk_cd <= 0:
                p1.hp -= STORM_DMG if e.kind == "neutral" else ENEMY_DMG
                e.atk_cd = STORM_INTERVAL if e.kind == "neutral" else ENEMY_INTERVAL
        elif who == "p2":
            if d > ENEMY_RANGE:
                move_toward(e, p2.x, p2.y, speed, dt)
            elif e.atk_cd <= 0:
                p2.hp -= STORM_DMG if e.kind == "neutral" else ENEMY_DMG
                e.atk_cd = STORM_INTERVAL if e.kind == "neutral" else ENEMY_INTERVAL
        else:
            tgt = cands[0][2]
            if d > ENEMY_RANGE:
                move_toward(e, tgt.x, tgt.y, speed, dt)
            elif e.atk_cd <= 0:
                tgt.hp -= ENEMY_DMG
                tgt.last_hit = "neutral"
                e.atk_cd = ENEMY_INTERVAL


def cleanup(enemies):
    debt = 0.0
    alive = []
    for e in enemies:
        if e.hp <= 0:
            if e.kind == "enemy":
                debt += NEUTRAL_KILL_DEBT if e.last_hit == "neutral" else KILL_DEBT
            continue
        if e.kind == "neutral" and e.life <= 0:
            continue
        alive.append(e)
    enemies[:] = alive
    return debt


def downed_step(p1, p2, dt):
    """返回 'fail' | 'ok' | 'p1_dead' | 'p2_dead'。"""
    events = []
    for p in (p1, p2):
        if p.downed == 0 and p.hp <= 0:
            p.downed = DOWN_TIME
            p.down_count += 1
            events.append("down")
    if p1.downed == -1 or p2.downed == -1:
        pass
    # 救援
    if p1.downed > 0 and p2.downed == 0 and dist(p1.x, p1.y, p2.x, p2.y) <= REVIVE_RANGE:
        p1.revive_acc += dt
        if p1.revive_acc >= REVIVE_TIME:
            p1.downed = 0.0
            p1.hp = REVIVE_HP
            p1.revive_acc = 0.0
    elif p1.downed > 0:
        p1.revive_acc = 0.0
    if p2.downed > 0 and p1.downed == 0 and dist(p1.x, p1.y, p2.x, p2.y) <= REVIVE_RANGE:
        p2.revive_acc += dt
        if p2.revive_acc >= REVIVE_TIME:
            p2.downed = 0.0
            p2.hp = REVIVE_HP
            p2.revive_acc = 0.0
    elif p2.downed > 0:
        p2.revive_acc = 0.0
    # 计时
    for p in (p1, p2):
        if p.downed > 0:
            p.downed -= dt
            if p.downed <= 0:
                p.downed = -1.0
    if p1.downed == -1.0:
        return "p1_dead"
    if p2.downed == -1.0:
        return "p2_dead"
    return "ok"


def run_one(strategy, eff, seed):
    rng = random.Random(seed)
    p1 = P(15.0, 20.0)
    p2 = P(45.0, 20.0)
    health = ORGAN_HP
    debt = 0.0
    t = 0.0
    storms = 0
    downs = 0
    skips = 0
    res = {"combat": [], "repair": [], "health_loss": 0.0, "storm": 0,
           "downs": 0, "skip": 0, "win": False, "end": ""}
    pending_skill_debt = 0.0

    for wave_i, (count, batches) in enumerate(WAVES):
        wave_start = t
        wave_debt_start = debt
        pending = []
        acc = 0.0
        for b in batches:
            pending.append((acc, b))
            acc += BATCH_GAP
        spawn_idx = 0
        enemies = []
        storm_done = False

        while True:
            elapsed = t - wave_start
            while spawn_idx < len(pending) and pending[spawn_idx][0] <= elapsed:
                _, n = pending[spawn_idx]
                for _ in range(n):
                    sx, sy = rng.choice(SPAWNS)
                    enemies.append(Ent(sx + rng.uniform(-2, 2), sy + rng.uniform(-2, 2), ENEMY_HP, ENEMY_SPEED))
                spawn_idx += 1
            if spawn_idx >= len(pending) and not alive_enemies(enemies):
                break

            p1.debt_from_skill = 0.0
            p1_ai(p1, p2, enemies, TICK, eff)
            p2_ai(p1, p2, enemies, TICK)
            enemy_ai(p1, p2, enemies, TICK)
            debt += cleanup(enemies) + getattr(p1, "debt_from_skill", 0.0)

            ev = downed_step(p1, p2, TICK)
            if ev == "p1_dead":
                res["combat"].append(round(t - wave_start, 1))
                res["end"] = "p1_dead"
                res["health_loss"] = round(ORGAN_HP - health, 0)
                res["storm"] = storms
                res["downs"] = p1.down_count + p2.down_count
                res["skip"] = skips
                return res

            if not storm_done and debt - wave_debt_start >= STORM_THRESHOLD:
                storm_done = True
                storms += 1
                for _ in range(STORM_COUNT):
                    sx, sy = rng.choice(SPAWNS)
                    enemies.append(Ent(sx, sy, STORM_HP, STORM_SPEED, kind="neutral", life=STORM_TIME))
            t += TICK
            if t - wave_start > 900:
                res["end"] = "timeout"
                res["health_loss"] = round(ORGAN_HP - health, 0)
                res["storm"] = storms
                res["downs"] = p1.down_count + p2.down_count
                res["skip"] = skips
                return res

        res["combat"].append(round(t - wave_start, 1))

        # ---- 维修段 ----
        repair_start = t
        skip = ((strategy == "aggressive" and debt >= 120 and health > 700)
                or (strategy == "smart" and debt >= 150 and health > 650))
        if skip:
            burn = debt * SKIP_HEALTH
            debt = math.ceil(debt * 1.1)
            health -= burn
            skips += 1
            res["repair"].append(0.0)
            if health <= 0:
                res["end"] = "organ_fail"
                res["health_loss"] = round(ORGAN_HP - health, 0)
                res["storm"] = storms
                res["downs"] = p1.down_count + p2.down_count
                res["skip"] = skips
                return res
        else:
            zones = int(math.ceil(debt / ZONE_DEBT))
            if zones == 0:
                res["repair"].append(0.0)
            else:
                per = debt / zones
                zs = []
                for i in range(zones):
                    nx, ny = NODES[i % len(NODES)]
                    zs.append([nx + rng.uniform(-2, 2), ny + rng.uniform(-2, 2), per])
                assist = 0.0
                while any(z[2] > 0 for z in zs):
                    active = [z for z in zs if z[2] > 0]
                    health -= len(active) * ZONE_DPS * TICK
                    if health <= 0:
                        res["end"] = "organ_fail"
                        res["repair"].append(round(t - repair_start, 1))
                        res["health_loss"] = ORGAN_HP - health
                        res["storm"] = storms
                        res["downs"] = p1.down_count + p2.down_count
                        res["skip"] = skips
                        return res
                    if p2.downed == 0:
                        tz = min(active, key=lambda z: dist(p2.x, p2.y, z[0], z[1]))
                        if dist(p2.x, p2.y, tz[0], tz[1]) > 2.0:
                            move_toward(p2, tz[0], tz[1], PLAYER_SPEED, TICK)
                        else:
                            amt = min(P2_PURIFY * eff * TICK, tz[2])
                            tz[2] -= amt
                            debt -= amt
                    if p1.downed == 0:
                        tz = min(active, key=lambda z: dist(p1.x, p1.y, z[0], z[1]))
                        if dist(p1.x, p1.y, tz[0], tz[1]) > 2.0:
                            move_toward(p1, tz[0], tz[1], PLAYER_SPEED, TICK)
                        else:
                            amt = min(P1_ASSIST_PURIFY * eff * TICK, tz[2])
                            tz[2] -= amt
                            debt -= amt
                            assist += amt
                            if assist >= 10.0:
                                assist -= 10.0
                                debt += P1_ASSIST_PER_10
                    if downed_step(p1, p2, TICK) == "p1_dead":
                        res["end"] = "p1_dead"
                        res["repair"].append(round(t - repair_start, 1))
                        res["health_loss"] = round(ORGAN_HP - health, 0)
                        res["storm"] = storms
                        res["downs"] = p1.down_count + p2.down_count
                        res["skip"] = skips
                        return res
                    t += TICK
                    if t - repair_start > 300:
                        break
                res["repair"].append(round(t - repair_start, 1))

        if wave_i == len(WAVES) - 1:
            res["win"] = True
            res["end"] = "win"
            break

    res["health_loss"] = round(ORGAN_HP - health, 0)
    res["storm"] = storms
    res["downs"] = p1.down_count + p2.down_count
    res["skip"] = skips
    return res


def summarize(label, runs):
    def mean(key, idx=None):
        vals = []
        for r in runs:
            if idx is None:
                v = r.get(key, 0.0)
            else:
                v = r["combat"][idx] if idx < len(r["combat"]) else 0.0
            if isinstance(v, (int, float)):
                vals.append(float(v))
        return statistics.mean(vals) if vals else 0.0

    win = sum(1 for r in runs if r["win"]) / len(runs)
    ends = {}
    for r in runs:
        ends[r["end"]] = ends.get(r["end"], 0) + 1
    row = {
        "label": label, "n": len(runs),
        "combat1": round(mean("x", 0), 1), "repair1": round(statistics.mean([r["repair"][0] for r in runs if r["repair"]]), 1) if any(r["repair"] for r in runs) else 0.0,
        "combat2": round(mean("x", 1), 1), "repair2": round(statistics.mean([r["repair"][1] for r in runs if len(r["repair"]) > 1]), 1) if any(len(r["repair"]) > 1 for r in runs) else 0.0,
        "health_loss": round(mean("health_loss"), 0),
        "storm": round(mean("storm"), 2), "downs": round(mean("downs"), 2),
        "skip": round(mean("skip"), 2), "win": round(win * 100, 1), "ends": ends,
    }
    print(f"{label:<34} c1={row['combat1']:>6}s r1={row['repair1']:>6}s "
          f"c2={row['combat2']:>6}s r2={row['repair2']:>6}s "
          f"hpLoss={row['health_loss']:>4} storm={row['storm']:.2f} "
          f"downs={row['downs']:.2f} skip={row['skip']:.2f} win={row['win']:>5}% ends={ends}")
    return row


def main():
    import sys
    variant = sys.argv[1] if len(sys.argv) > 1 else "base"
    if variant in TUNING:
        globals().update(TUNING[variant])
    trials = 250
    rows = []
    print("P0 numeric simulation (n=500 per cell)")
    print("-" * 120)
    for strategy in ("safe", "smart", "aggressive"):
        for eff in (0.6, 0.8, 0.95):
            runs = [run_one(strategy, eff, seed=(hash((strategy, eff, i)) & 0x7FFFFFFF))
                    for i in range(trials)]
            rows.append(summarize(f"strategy={strategy:<10} eff={eff}", runs))
    print("-" * 120)
    import json
    print(json.dumps(rows, ensure_ascii=True))


if __name__ == "__main__":
    main()