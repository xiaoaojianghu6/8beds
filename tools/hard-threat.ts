/**
 * 传播机制体检 —— 隔离到底有没有用？
 *
 * 用法：npx vite-node tools/hard-threat.ts
 *
 * 判据（docs/level-design/09-TRANSMISSION.md §3）：
 *
 *   1. minAP(允许 N 次感染)  —— 硬扛线的价格
 *   2. minAP(零感染)         —— 隔离线的价格
 *   3. 差值 Δ = 隔离线 − 硬扛线
 *
 *   Δ >  0  → 硬扛更便宜：隔离买的是**余量**（从容错空间），不是 AP
 *   Δ =  0  → 两者同价：隔离是并列最优解，玩家有真正的风格选择
 *   Δ <  0  → 隔离更便宜：那它就不是「可选保险」，是必做项，设计出问题
 *   零感染无解 → 传播无法回避，是硬威胁；但这种关卡里「隔离」按钮必然是摆设，慎用
 *
 * 同时报告最优解是否用到 ISOLATE，以及感染事件落在哪个病人身上（可追溯性检查）。
 */
import { solve, formatPath } from "../src/solver";
import { createInitialState } from "../src/core/state";
import { reduce } from "../src/core/reducer";
import night02 from "../levels/night-02.json";
import type { GameState, LevelDef, PlayerAction } from "../src/core/types";

const lv = night02 as unknown as LevelDef;

function minAPWith(maxInfectionEvents: number) {
  return solve(
    { ...lv, rules: { ...lv.rules, maxInfectionEvents } },
    { maxNodes: 150_000 },
  );
}

const endure = minAPWith(lv.rules.maxInfectionEvents);
const clean = minAPWith(0);

const fmt = (r: { solvable: boolean; minAP: number | null; slack: number | null; exhausted: boolean }) =>
  r.solvable ? `${r.minAP} AP（余量 ${r.slack}）` : r.exhausted ? "无解" : "触上限，结论作废";

console.log(`### ${lv.id}「${lv.title}」  总 AP ${lv.turns * lv.actionPoints}`);
console.log(`  硬扛线（允许 ≤${lv.rules.maxInfectionEvents} 次感染）: ${fmt(endure)}`);
console.log(`  隔离线（要求零感染）        : ${fmt(clean)}`);

if (endure.solvable && clean.solvable) {
  const delta = clean.minAP! - endure.minAP!;
  const verdict =
    delta > 0
      ? "硬扛更便宜 → 隔离买的是余量，不是 AP"
      : delta === 0
        ? "同价 → 隔离与硬扛并列最优，玩家有风格选择"
        : "隔离更便宜 → 隔离变成必做项，设计需要重做";
  console.log(`  Δ = ${delta} AP  ${verdict}`);
} else if (endure.solvable && !clean.solvable) {
  console.log("  零感染无解 → 传播是硬威胁。注意：这种关卡里隔离按钮很可能是摆设。");
} else if (!endure.solvable) {
  console.log("  ⚠ 连允许感染的条件下都无解 —— 关卡本身不成立。");
}

function usesIsolate(path: PlayerAction[] | null): number {
  return (path ?? []).filter((a) => a.type === "ISOLATE").length;
}
console.log(`  最优解里的隔离次数: 硬扛线 ${usesIsolate(endure.path)} / 隔离线 ${usesIsolate(clean.path)}`);

// 逐动作重放硬扛线，检查感染是否可追溯
console.log("\n硬扛线逐动作重放：");
let s: GameState = createInitialState(lv);
const snap = () => {
  const cells: string[] = [];
  for (const k of Object.keys(s.beds)) {
    const id = s.beds[Number(k)];
    if (!id) continue;
    const p = s.patients[id];
    cells.push(`${k}:${id}${p.isolated ? "[隔]" : ""}(a${p.acuity},e${p.exposure})`);
  }
  const q = s.queue.map((id) => `${id}(a${s.patients[id].acuity})`).join(",");
  console.log(
    `         T${s.turn} ap=${s.ap} 感染=${s.infectionEvents} | 床 ${cells.join(" ")} | 走廊 ${q || "-"}`,
  );
};
snap();
let i = 0;
for (const a of (endure.path ?? []) as PlayerAction[]) {
  s = reduce(s, a).state;
  i++;
  const label = `${a.type}${"patientId" in a ? ":" + a.patientId : ""}${"bedId" in a ? "@" + a.bedId : ""}`;
  const ev = s.history[s.history.length - 1].events.filter((e) =>
    /EXPOSURE|INFECTION|DIED|DISCHARG|REVERSE|REMED/.test(e),
  );
  console.log(`  ${String(i).padStart(2)} ${label}${ev.length ? "  → " + ev.join(" ") : ""}`);
  snap();
}
console.log(`\n结果 ${s.outcome} | 感染 ${s.infectionEvents} | 死亡 ${s.deaths}`);

// 参考解
console.log("\n硬扛线参考解：");
for (const line of formatPath(endure.path ?? [])) console.log("  " + line);
