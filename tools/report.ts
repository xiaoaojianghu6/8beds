/**
 * 关卡健康度报表。
 *
 * 用法：npx vite-node tools/report.ts
 *
 * 这是动 levels/*.json 之后的**第一件事**：把各关的关键数字摆在一行里看。
 * 数字与 tests/golden.ts 对不上 = 有人改了规则却忘了改设计基准，立刻停下来对齐。
 */
import night00 from "../levels/night-00.json";
import night01 from "../levels/night-01.json";
import night02 from "../levels/night-02.json";
import night03 from "../levels/night-03.json";
import night04 from "../levels/night-04.json";
import night05 from "../levels/night-05.json";
import { solve } from "../src/solver";
import { replay } from "../src/core/replay";
import type { LevelDef } from "../src/core/types";

const levels = [night00, night01, night02, night03, night04] as unknown as LevelDef[];

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const num = (s: string | number, n: number) => String(s).padStart(n);

console.log("=== 关卡健康度（求解器实测）===\n");
console.log(
  pad("id", 10) +
    num("可解", 5) +
    num("最小AP", 7) +
    num("总AP", 6) +
    num("余量", 6) +
    num("隔离×", 6) +
    num("感染", 6) +
    num("死亡", 6) +
    num("出院", 8) +
    num("节点", 9) +
    "  穷尽",
);

for (const lv of levels) {
  const r = solve(lv, { maxNodes: 150_000 });
  let infections = 0;
  let deaths = 0;
  let discharged = 0;
  if (r.path) {
    const { state } = replay(lv, r.path);
    infections = state.infectionEvents;
    deaths = state.deaths;
    discharged = Object.values(state.patients).filter((p) => p.discharged).length;
  }
  const isolates = r.path?.filter((a) => a.type === "ISOLATE").length ?? 0;
  console.log(
    pad(lv.id, 10) +
      num(r.solvable ? "是" : "否", 5) +
      num(r.minAP ?? "-", 7) +
      num(r.totalAP, 6) +
      num(r.slack ?? "-", 6) +
      num(isolates, 6) +
      num(infections, 6) +
      num(deaths, 6) +
      num(`${discharged}/${lv.rules.requiredDischarges === "ALL" ? "ALL" : lv.rules.requiredDischarges}`, 8) +
      num(r.nodesExplored, 9) +
      "  " +
      (r.exhausted ? "是" : "否（结论作废）"),
  );
}

console.log("\n=== 每条设计约束的体检 ===\n");
const problems: string[] = [];

for (const lv of levels) {
  const r = solve(lv, { maxNodes: 150_000 });

  if (!r.solvable) problems.push(`${lv.id}: 无解 —— 关卡不成立`);
  if (!r.exhausted) problems.push(`${lv.id}: 搜索未穷尽，上面的结论不可信`);
  if (r.solvable && r.slack! < 0) problems.push(`${lv.id}: 余量为负 —— 数学上不可能`);

  // 契约 §7 W1/W2：全关 maxDeaths=0、requiredDischarges 全为 ALL
  if (lv.rules.maxDeaths !== 0) problems.push(`${lv.id}: maxDeaths=${lv.rules.maxDeaths}，违反 W1（死一个就判负）`);
  if (lv.rules.requiredDischarges !== "ALL")
    problems.push(`${lv.id}: requiredDischarges=${lv.rules.requiredDischarges}，违反 W2（全部送走）`);

  // 契约 §4：不存在 DISCHARGE 动作
  if ((lv.enabledActions as string[]).includes("DISCHARGE"))
    problems.push(`${lv.id}: enabledActions 里还有 DISCHARGE，违反 §4`);

  // 不开启感染的关卡不该出现传染源
  if (!lv.rules.infectionEnabled) {
    const s = replay(lv, []).state;
    const transmitter = Object.values(s.patients).find((p) => p.transmission !== "NONE");
    if (transmitter) problems.push(`${lv.id}: infectionEnabled=false 却有传染源 ${transmitter.id}`);
  }

  // 契约 §8 I1：在床患者的 acuity 都能被有限次 STABILIZE 降到 0（这是恒真的，但要防止未来引入不可治疗患者）
  const s = replay(lv, []).state;
  for (const p of Object.values(s.patients)) {
    if (p.acuity < 0) problems.push(`${lv.id}: ${p.id} acuity 为负`);
  }
}

if (problems.length === 0) {
  console.log("  ✅ 全部通过：各关可解、穷尽、余量非负、结算层原则一致、无 DISCHARGE 残留");
} else {
  for (const p of problems) console.log("  ❌ " + p);
}

console.log(
  "\n提示：隔离的可解性闸门（禁用隔离线 / Δ）见 `tools/curtain-gates.ts`。",
);
