/**
 * 隔离的**闸门体检台**。
 *
 * 用法：npx vite-node tools/curtain-gates.ts [night-02 night-04 ...] [turns]
 *
 * 2026-09-18 起两处口径更新：
 *   ① 感染不再设预算上限（感染只偷手、不判负）—— 旧 G1/K 探针随之作废；
 *   ② 帘子不是资源（隔离谁就围上谁，不牵连别处）—— 「空间价格」的探针随之作废。
 * 现在每一关量两件事：
 *
 *   G2. 禁用隔离后仍可解？（从 enabledActions 里摘掉 ISOLATE）
 *       用户铁律「机制引入即持续复用」的镜像检验：隔离应该在最优解里出现，
 *       但 G2 只保证它**可解性上有意义**——不可解 = 隔离变成了硬任务。
 *
 *   Δ = 最小AP(禁用隔离) − 最小AP(允许隔离)。
 *       Δ > 0  → 隔离省 AP，是一笔划算的保险
 *       Δ = 0  → 真正的风格选择（隔离买的是确定性）
 *       Δ < 0  → 硬扛更划算（隔离可买但不必要）
 */
import night02 from "../levels/night-02.json";
import night03 from "../levels/night-03.json";
import night04 from "../levels/night-04.json";
import night05 from "../levels/night-05.json";
import night06 from "../levels/night-06.json";
import { solve } from "../src/solver";
import { createInitialState } from "../src/core/state";
import { reduce } from "../src/core/reducer";
import type { GameState, LevelDef } from "../src/core/types";

const REGISTRY: Record<string, LevelDef> = {
  "night-02": night02 as unknown as LevelDef,
  "night-03": night03 as unknown as LevelDef,
  "night-04": night04 as unknown as LevelDef,
  "night-05": night05 as unknown as LevelDef,
  "night-06": night06 as unknown as LevelDef,
};

const argv = process.argv.slice(2);
const turnsOverride = Number(argv.find((a) => /^\d+$/.test(a))) || null;
const targets = argv.filter((a) => !/^\d+$/.test(a));
const ids = targets.length ? targets : Object.keys(REGISTRY);

type Line = {
  ap: number | null;
  slack: number | null;
  solvable: boolean;
  exhausted: boolean;
  isolates: number;
  events: number;
};

/** 求解一条线。禁隔离时从 enabledActions 里摘掉 ISOLATE —— 那才是硬约束的真测试。 */
function run(base: LevelDef, turns: number, allowIsolate: boolean): Line {
  const lv: LevelDef = {
    ...base,
    turns,
    enabledActions: allowIsolate
      ? base.enabledActions
      : base.enabledActions.filter((a) => a !== "ISOLATE"),
  };
  const r = solve(lv, { maxNodes: 150_000 });

  let events = 0;
  let isolates = 0;
  if (r.path) {
    let s: GameState = createInitialState(lv);
    for (const a of r.path) {
      s = reduce(s, a).state;
      if (a.type === "ISOLATE") isolates += 1;
    }
    events = s.infectionEvents;
  }
  return {
    ap: r.minAP,
    slack: r.slack,
    solvable: r.solvable,
    exhausted: r.exhausted,
    isolates,
    events,
  };
}

function fmt(l: Line): string {
  return l.solvable
    ? `${l.ap} AP（余量 ${l.slack}）  隔离×${l.isolates}  实感染=${l.events}${l.exhausted ? "" : "  ⚠未穷尽"}`
    : "无解";
}

for (const id of ids) {
  const base = REGISTRY[id];
  if (!base) {
    console.log(`\n### ${id}：未注册（可选 ${Object.keys(REGISTRY).join(" / ")}）`);
    continue;
  }
  const turns = turnsOverride ?? base.turns;
  console.log(
    `\n### ${id}「${base.title}」 turns=${turns} 总AP=${turns * base.actionPoints}` +
      `${turnsOverride ? "（临时覆盖）" : ""}`,
  );

  const withIso = run(base, turns, true);
  const noIso = run(base, turns, false);
  console.log(`    允许隔离    ${fmt(withIso)}`);
  console.log(`    禁用隔离    ${fmt(noIso)}`);

  // G2
  if (noIso.solvable) {
    console.log("    ✅ G2 禁用隔离仍可解 → 隔离是保险，不是硬任务");
  } else {
    console.log("    ❌ G2 禁用隔离无解 → 隔离变成了任务（用户已裁定隔离必须出现在最优解里，此项改为记录用）");
  }

  // Δ
  if (withIso.solvable && noIso.solvable) {
    const delta = (noIso.ap ?? 0) - (withIso.ap ?? 0);
    const verdict =
      delta > 2
        ? "✅ 隔离明显省 AP，是一笔划算的保险"
        : delta > 0
          ? "✅ 隔离小赚（买的是确定性）"
          : delta === 0
            ? "✅ 同价 → 真正的风格选择（隔离买的是「确定性」，不是省 AP）"
            : "⚠ 硬扛更划算 —— 隔离可买但不划算，注意别让按钮变摆设";
    console.log(`    Δ = ${delta} AP（禁用隔离 ${noIso.ap} − 允许隔离 ${withIso.ap}）  ${verdict}`);
  }
}

// ── 打印最后一关的参考解，供人工核对 ─────────────────────────────────
const lastId = ids[ids.length - 1];
const last = REGISTRY[lastId];
if (last) {
  const turns = turnsOverride ?? last.turns;
  console.log(`\n— ${lastId} 参考解 —`);
  const ref = solve(last, { maxNodes: 150_000 });
  if (ref.path) {
    let s: GameState = createInitialState(last);
    for (const a of ref.path) {
      s = reduce(s, a).state;
      const ev = s.history[s.history.length - 1].events.filter((e) =>
        /EXPOS|INFECT|DIED|DISCHARG|ISOLAT|CURTAIN/.test(e),
      );
      const tag =
        a.type === "ADMIT"
          ? String((a as { bedId: number }).bedId)
          : (a as { patientId: string }).patientId;
      console.log(
        `  T${s.turn} ${a.type}:${tag}${ev.length ? "  → " + ev.join(" ") : ""}`,
      );
    }
    console.log(`  合计 ${ref.minAP} AP / 余量 ${ref.slack}`);
  }
}
