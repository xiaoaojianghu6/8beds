/**
 * 导出各关最优解（最小 AP 解），用于：
 *  1. 人工核对关卡是否成立
 *  2. 生成 `tests/paths.ts` 里的 gold path
 *
 * 用法：npx vite-node tools/gold.ts
 */
import { solve, formatPath } from "../src/solver";
import night00 from "../levels/night-00.json";
import night01 from "../levels/night-01.json";
import night02 from "../levels/night-02.json";
import type { LevelDef } from "../src/core/types";

for (const lv of [night00, night01, night02] as unknown as LevelDef[]) {
  const r = solve(lv, { maxNodes: 150_000 });
  const verdict = r.solvable ? "可解" : r.exhausted ? "无解（已穷尽）" : "结论不可信（触上限）";
  console.log(
    `\n### ${lv.id}「${lv.title}」 ${verdict}  最小 ${r.minAP} AP / 总 ${r.totalAP} / 余量 ${r.slack}` +
      `  节点 ${r.nodesExplored}`,
  );
  for (const line of formatPath(r.path ?? [])) console.log("  " + line);
  console.log("  JSON: " + JSON.stringify(r.path));
}
