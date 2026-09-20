/**
 * 「为什么无解」诊断台。
 *
 * 用法：npx vite-node tools/why-lose.ts [night-04] [最大深度] [observationTurns]
 *
 * 从开局做**广度优先**枚举（只要合法动作，不管目标），回答两件事：
 *
 *   1. 每个回合还能活着到达多少个状态？
 *      - 某一回合后「幸存状态」归零 → 从那里起**有人必死**（患者构成问题）
 *      - 幸存状态一直存在到回合耗尽 → 不是必死，是 **AP 预算不够**（加回合）
 *
 *   2. 第一次判负的事件链 —— 谁死的、被什么打死的。
 *
 * 它不替代求解器，只负责在「无解」之后回答「无解在哪」。
 */
import night00 from "../levels/night-00.json";
import night01 from "../levels/night-01.json";
import night02 from "../levels/night-02.json";
import night03 from "../levels/night-03.json";
import night04 from "../levels/night-04.json";
import night05 from "../levels/night-05.json";
import night06 from "../levels/night-06.json";
import { legalActions } from "../src/core/rules";
import { reduce } from "../src/core/reducer";
import { createInitialState } from "../src/core/state";
import type { GameState, LevelDef, PlayerAction } from "../src/core/types";

const ALL: Record<string, LevelDef> = {
  "night-00": night00 as unknown as LevelDef,
  "night-01": night01 as unknown as LevelDef,
  "night-02": night02 as unknown as LevelDef,
  "night-03": night03 as unknown as LevelDef,
  "night-04": night04,
  "night-05": night05 as unknown as LevelDef,
  "night-06": night06 as unknown as LevelDef,
};

const id = process.argv[2] ?? "night-04";
const maxDepth = Number(process.argv[3] ?? 8);
const obsArg = process.argv[4];
const RAW = ALL[id];
if (!RAW) {
  console.error(`未知关卡 ${id}，可选：${Object.keys(ALL).join(", ")}`);
  process.exit(1);
}

/** 允许用第 4 个参数临时覆盖观察期，用于「开了观察期之后无解在哪」的诊断。 */
const level: LevelDef =
  obsArg == null
    ? RAW
    : { ...RAW, rules: { ...RAW.rules, observationTurns: Number(obsArg) } };
if (obsArg != null) console.log(`（临时覆盖 observationTurns = ${obsArg}）`);

type Node = { state: GameState; path: PlayerAction[]; depth: number };

function key(s: GameState): string {
  const beds = [1, 2, 3, 4, 5, 6, 7, 8].map((b) => s.beds[b] ?? "_").join(",");
  const ps = Object.keys(s.patients)
    .sort()
    .map((k) => {
      const p = s.patients[k];
      return `${k}:${p.acuity},${p.bedId ?? -1},${p.exposure},${p.alive ? 1 : 0}${p.discharged ? 1 : 0}`;
    })
    .join(";");
  return `${s.turn}|${s.ap}|${s.curtains.join("+")}|${s.deaths}|${s.infectionEvents}|${beds}|${s.queue.join(">")}|${ps}`;
}

function label(a: PlayerAction): string {
  switch (a.type) {
    case "ADMIT":
      return `收治→${a.bedId}床`;
    case "SCAN":
      return `检查 ${a.patientId}`;
    case "STABILIZE":
      return `处置 ${a.patientId}`;
    case "ISOLATE":
      return `隔离 ${a.patientId}`;
  }
}

const start = createInitialState(level);
let frontier: Node[] = [{ state: start, path: [], depth: 0 }];
const seen = new Set<string>([key(start)]);
let firstLose: Node | null = null;

/** 每个回合的幸存状态数 */
const survival: Record<number, number> = {};
/** 判负原因直方图：谁死的 / 被什么打死的 */
const reasons = new Map<string, number>();
let wins = 0;
let deepestTurn = 0;

function loseReason(s: GameState): string {
  const died = s.history
    .flatMap((h) => h.events)
    .filter((e) => e.startsWith("DIED:"))
    .map((e) => e.split(":")[1]);
  const who = [...new Set(died)].join("+") || "?";
  if (s.deaths > 0) return `死亡(${who})`;
  if (s.infectionEvents > 0) return `感染事件超预算`;
  return "回合耗尽";
}

for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
  const next: Node[] = [];
  let loses = 0;
  for (const node of frontier) {
    if (node.state.outcome === "LOSE") {
      loses += 1;
      const r = loseReason(node.state);
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
      if (!firstLose) firstLose = node;
      continue;
    }
    if (node.state.outcome === "WIN") {
      wins += 1;
      continue;
    }
    deepestTurn = Math.max(deepestTurn, node.state.turn);
    survival[node.state.turn] = (survival[node.state.turn] ?? 0) + 1;

    for (const action of legalActions(node.state)) {
      const { state, accepted } = reduce(node.state, action);
      if (!accepted) continue;
      const k = key(state);
      if (seen.has(k)) continue;
      seen.add(k);
      next.push({ state, path: [...node.path, action], depth: depth + 1 });
    }
  }
  console.log(
    `  手 ${String(depth + 1).padStart(2)}: 展开 ${String(frontier.length).padStart(6)} → 新状态 ${String(next.length).padStart(6)}  判负 ${String(loses).padStart(6)}  累计胜 ${wins}`,
  );
  if (next.length === 0) break;
  frontier = next;
}

console.log(`\n### ${id} 幸存状态按回合分布（能活着到达该回合的状态数）`);
for (const t of Object.keys(survival).map(Number).sort((a, b) => a - b)) {
  console.log(`  T${String(t).padStart(2)}  ${survival[t]}`);
}
console.log(`  最深可达回合：T${deepestTurn} / ${level.turns}`);

console.log(`\n### 判负原因直方图`);
for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(6)}  ${r}`);
}

console.log(`\n### 第一处 LOSE`);
if (!firstLose) {
  console.log(`  ${maxDepth} 手以内没有出现判负。`);
} else {
  console.log(`  深度 ${firstLose.path.length} 手：`);
  for (const a of firstLose.path) console.log(`    ${label(a)}`);
  let s: GameState = createInitialState(level);
  for (const a of firstLose.path) {
    s = reduce(s, a).state;
    const ev = s.history[s.history.length - 1].events.filter((e) =>
      /EXPOS|INFECT|DIED|LOSE|TIMEOUT|REVERSE/.test(e),
    );
    const status = Object.values(s.patients)
      .filter((p) => p.bedId != null)
      .map((p) => `${p.id}@${p.bedId}:${p.acuity}/${p.exposure}`)
      .join(" ");
    console.log(`      T${s.turn} ${status}${ev.length ? "  → " + ev.join(" ") : ""}`);
  }
}
