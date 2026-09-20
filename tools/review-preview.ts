/**
 * 失败复盘预览台。
 *
 * 用法：npx vite-node tools/review-preview.ts [night-04] [策略]
 *
 * 截图只能证明「渲染没崩」，证明不了「文案说人话」。这个台子直接把
 * `buildReview()` 在**真实失败局面**下会吐出的每一个字打印出来，
 * 让文案可以在终端里被逐句审。
 *
 * 策略：
 *   idle    什么都不做（回合空转）→ 演练「自然恶化致死」
 *   admit   只收治不处置 → 演练「人推进病房也救不活」
 *   scan    只检查不处置 → 演练「信息不等于结果」
 *   noiso   永不隔离 → 演练「传播超限」
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
import { buildReview } from "../src/ui/review";
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
const strat = process.argv[3] ?? "idle";
const level = ALL[id];
if (!level) {
  console.error(`未知关卡 ${id}，可选：${Object.keys(ALL).join(", ")}`);
  process.exit(1);
}

const ALLOW: Record<string, PlayerAction["type"][]> = {
  idle: [],
  admit: ["ADMIT"],
  scan: ["SCAN"],
  noiso: ["ADMIT", "SCAN", "STABILIZE"],
};
const allow = ALLOW[strat] ?? [];

let s: GameState = createInitialState(level);
let guard = 0;
while (s.outcome === "ONGOING" && guard++ < 400) {
  const acts = legalActions(s).filter((a) => allow.includes(a.type));
  if (acts.length === 0) {
    // 没有想做的动作就直接把 AP 烧掉，逼回合推进（本作没有「过回合」动作）
    const burn = legalActions(s);
    if (burn.length === 0) break;
    s = reduce(s, burn[burn.length - 1]).state;
    continue;
  }
  s = reduce(s, acts[0]).state;
}

console.log(`\n═══ ${id} / 策略 ${strat} → 结局 ${s.outcome} ═══`);
console.log(`回合 ${s.turn}/${s.maxTurns}  死亡 ${s.deaths}/${s.maxDeaths}  感染 ${s.infectionEvents}/${s.maxInfectionEvents}  后遗症 ${s.sequelaCount}/${s.sequelaLimit ?? "-"}\n`);

const r = buildReview(s);
console.log(`【大标题】${r.headline}   (kind=${r.kind})`);
for (const l of r.lines) {
  console.log(`  [${l.kind}] ${l.label}：${l.body}`);
}
console.log();
