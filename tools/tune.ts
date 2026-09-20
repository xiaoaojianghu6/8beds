/**
 * AP 预算与下界体检台（配平前的第一把尺子）。
 *
 * 用法：npx vite-node tools/tune.ts
 *
 * 它回答两个问题：
 *
 *  1. **下界紧不紧？** 把 `heuristic(初始状态)` 与求解器真实最小 AP 并列。
 *     - h > minAP  → 启发式不可采纳，A* 会返回次优解，所有配平结论作废（严重）
 *     - h ≪ minAP  → 下界太松，搜索会变慢（可接受，但要知道）
 *     这也是 tests/solver.test.ts 里「沿路径不高估」那条的手工版。
 *
 *  2. **给多少回合才刚好可解？** 扫描 turns × requiredDischarges 网格，
 *     输出「刚好可解的那一档」与它的余量。这是改关卡预算时的起点。
 *
 * 注意：扫描用的是**当前关卡的规则**（含 patients / arrivals），只改预算，
 * 不改患者构成。要动患者构成请直接改 levels/*.json 再回来验。
 */
import night00 from "../levels/night-00.json";
import night01 from "../levels/night-01.json";
import night02 from "../levels/night-02.json";
import night03 from "../levels/night-03.json";
import night04 from "../levels/night-04.json";
import night05 from "../levels/night-05.json";
import { heuristic, scanBudget, solve } from "../src/solver";
import { createInitialState } from "../src/core/state";
import type { LevelDef } from "../src/core/types";

const levels = [night00, night01, night02, night03, night04] as unknown as LevelDef[];

/**
 * 回合扫描网格：只扫**当前设定附近**的档位。
 *
 * ⚠ 两个内存护栏（曾因并行跑多个大堆进程把磁盘 swap 吃到 20G+ 导致机器卡死）：
 *   1. 网格刻意很窄 —— 「无解」的回合要穷尽整个空间才肯返回，扫一档就够贵了
 *   2. maxNodes 上限压在 15 万 —— 可解关 A* 找到的第一个解就是最优解（启发式可采纳），
 *      所以只影响「无解」结论的可信度，不影响 minAP 的正确性
 */
const TURNS_GRID: Record<string, number[]> = {
  "night-00": [4],
  "night-01": [4],
  "night-02": [8],
  "night-03": [8],
  "night-04": [8],
};

/** 单次求解的节点上限。详见上方注释。 */
const NODE_CAP = 150_000;

const num = (s: string | number, n: number) => String(s).padStart(n);

console.log("=== 1. 启发式下界 vs 求解器真实最小 AP ===\n");
console.log("  " + "id".padEnd(10) + num("h(start)", 9) + num("真实minAP", 10) + num("差距", 7) + "  结论");

for (const lv of levels) {
  const h = heuristic(createInitialState(lv));
  const r = solve(lv, { maxNodes: 150_000 });
  const min = r.minAP;
  const gap = min == null ? null : min - h;
  const verdict =
    min == null
      ? "无解"
      : h > min
        ? "❌ 不可采纳：h 高估，A* 结论作废"
        : gap === 0
          ? "✅ 下界紧（h 恰好等于最优）"
          : gap! <= 2
            ? "✅ 下界较紧"
            : "⚠ 下界偏松（只影响速度，不影响正确性）";
  console.log("  " + lv.id.padEnd(10) + num(h, 9) + num(min ?? "-", 10) + num(gap ?? "-", 7) + "  " + verdict);
}

console.log("\n=== 2. 预算扫描：给多少回合刚好可解 ===\n");
for (const lv of levels) {
  const reqs: (number | "ALL")[] = lv.rules.requiredDischarges === "ALL" ? ["ALL"] : [lv.rules.requiredDischarges];
  const rows = scanBudget(lv, {
    turns: TURNS_GRID[lv.id] ?? [lv.turns],
    requiredDischarges: reqs,
    maxNodes: 150_000,
  });
  console.log(`  ${lv.id}（目标 ${reqs[0]}，每回合 ${lv.actionPoints} AP）`);
  console.log("    " + num("turns", 6) + num("总AP", 6) + num("可解", 6) + num("最小AP", 8) + num("余量", 6) + "  穷尽");
  for (const r of rows) {
    console.log(
      "    " +
        num(r.turns, 6) +
        num(r.totalAP, 6) +
        num(r.solvable ? "是" : "否", 6) +
        num(r.minAP ?? "-", 8) +
        num(r.slack ?? "-", 6) +
        "  " +
        (r.exhausted ? "是" : "否"),
    );
  }
  const firstSolvable = rows.find((r) => r.solvable && r.exhausted);
  if (firstSolvable) {
    console.log(
      `    → 最少 ${firstSolvable.turns} 回合（${firstSolvable.totalAP} AP）可解，余量 ${firstSolvable.slack}；` +
        `当前设定 ${lv.turns} 回合。`,
    );
  } else {
    console.log("    → 扫到的范围内全部无解，关卡需要改患者构成而不是加回合。");
  }
  console.log("");
}
