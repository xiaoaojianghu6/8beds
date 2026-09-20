/**
 * 参考解逐步追踪台 —— 用来回答「这一步到底发生了什么」。
 *
 * 用法：npx vite-node tools/trace.ts night-04 [maxInfectionEvents]
 *
 * 打印每一步的 turn / ap（**动作前**的状态）、全部事件，以及回合末的暴露累积表。
 * 这是排查「某人不该吃到的暴露为什么没发生」这类问题的唯一可靠手段。
 */
import night00 from "../levels/night-00.json";
import night01 from "../levels/night-01.json";
import night02 from "../levels/night-02.json";
import night03 from "../levels/night-03.json";
import night04 from "../levels/night-04.json";
import night05 from "../levels/night-05.json";
import { solve } from "../src/solver";
import { createInitialState } from "../src/core/state";
import { reduce } from "../src/core/reducer";
import type { GameState, LevelDef } from "../src/core/types";

const REGISTRY: Record<string, LevelDef> = {
  "night-00": night00 as unknown as LevelDef,
  "night-01": night01 as unknown as LevelDef,
  "night-02": night02 as unknown as LevelDef,
  "night-03": night03 as unknown as LevelDef,
  "night-04": night04,
  "night-05": night05 as unknown as LevelDef,
};

const [id, budgetArg] = process.argv.slice(2);
const base = REGISTRY[id];
if (!base) {
  console.log(`未注册：${id}。可选 ${Object.keys(REGISTRY).join(" / ")}`);
  process.exit(1);
}

const budget = budgetArg != null ? Number(budgetArg) : base.rules.maxInfectionEvents;
const lv: LevelDef = { ...base, rules: { ...base.rules, maxInfectionEvents: budget } };

const r = solve(lv, { maxNodes: 150_000 });
console.log(`\n### ${id}「${base.title}」预算=${budget} 可解=${r.solvable} 最小AP=${r.minAP} 余量=${r.slack}`);
if (!r.path) process.exit(1);

let s: GameState = createInitialState(lv);
const show = (st: GameState) =>
  Object.values(st.patients)
    .filter((p) => p.alive && !p.discharged)
    .map((p) => `${p.id}${p.bedId != null ? `@${p.bedId}` : "@走廊"}(acu${p.acuity},exp${p.exposure})`)
    .join(" ");

for (const a of r.path) {
  const tag =
    a.type === "ADMIT"
      ? `bed${(a as { bedId: number }).bedId}`
      : (a as { patientId: string }).patientId;
  console.log(`\n  [T${s.turn} ap${s.ap}] ${a.type}:${tag}`);
  const before = s.turn;
  const res = reduce(s, a);
  s = res.state;
  console.log(`    ${res.events.join(" | ")}`);
  console.log(`    → ap${s.ap}${s.turn !== before ? ` ★回合推进 T${before}→T${s.turn}` : ""}`);
  console.log(`    ${show(s)}`);
}
console.log(`\n终态：${s.outcome}  出院 ${Object.values(s.patients).filter((p) => p.discharged).length}/${s.totalPatients}`);
