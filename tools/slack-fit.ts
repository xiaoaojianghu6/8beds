/**
 * 余量纪律拟合台。
 *
 * 用法：
 *   npx vite-node tools/slack-fit.ts                  # 全关扫描
 *   npx vite-node tools/slack-fit.ts night-02         # 单关
 *   npx vite-node tools/slack-fit.ts night-04 8 12    # 指定回合扫描区间
 *
 * ── 余量纪律（用户拍板，不可违反）──────────────────────────
 *
 *   总预算 T = turns × actionPoints
 *
 *   T 为双数 → 目标余量 0，最多容忍 2
 *   T 为单数 → 余量必须正好 1
 *   余量 ≥ 3 一律不合规（「不能留 4 回合这种余量」）
 *
 * 为什么是这条而不是「一律零余量」：治愈档要两只手（Contract §4.1），
 * 于是最小解的奇偶由「治愈次数 × 2 + 其它单手动作」决定 —— 它不总能落在 T 上。
 * 与其为了凑零余量去改患者构成，不如承认 **1 点余量是这一关手数结构的必然奇偶**，
 * 把纪律改成「余量 ∈ {0,1,2} 且与 T 的奇偶一致」。
 *
 * 优先级：T偶/余0  >  T奇/余1  >  T偶/余2  >  不合规
 */
import night00 from "../levels/night-00.json";
import night01 from "../levels/night-01.json";
import night02 from "../levels/night-02.json";
import night03 from "../levels/night-03.json";
import night04 from "../levels/night-04.json";
import night05 from "../levels/night-05.json";
import { solve } from "../src/solver";
import type { LevelDef } from "../src/core/types";

const REGISTRY: Record<string, LevelDef> = {
  "night-00": night00 as unknown as LevelDef,
  "night-01": night01 as unknown as LevelDef,
  "night-02": night02 as unknown as LevelDef,
  "night-03": night03 as unknown as LevelDef,
  "night-04": night04,
  "night-05": night05 as unknown as LevelDef,
};

/** 各关的扫描区间：以当前设定为中心上下展开。 */
const DEFAULT_GRID: Record<string, number[]> = {
  "night-00": [3, 4, 5, 6],
  "night-01": [3, 4, 5, 6],
  "night-02": [6, 7, 8, 9],
  "night-03": [7, 8, 9],
  "night-04": [8, 9, 10, 11],
};

type Grade = { ok: boolean; rank: number; label: string };

/** 余量纪律的机器判据。返回合规性与优先级（rank 越小越好）。 */
export function gradeSlack(totalAP: number, slack: number | null): Grade {
  if (slack == null) return { ok: false, rank: 99, label: "无解" };
  if (slack > 2) return { ok: false, rank: 9, label: `余量 ${slack} 超上限（≥3）` };
  const even = totalAP % 2 === 0;
  if (even && slack === 0) return { ok: true, rank: 0, label: "✅ 零余量（T 双数）" };
  if (!even && slack === 1) return { ok: true, rank: 1, label: "✅ 余量 1（T 单数）" };
  if (even && slack === 2) return { ok: true, rank: 2, label: "△ 余量 2（T 双数·容忍上限）" };
  if (even && slack === 1) return { ok: false, rank: 3, label: `✗ 余量 1 但 T=${totalAP} 是双数（应为 0 或 2）` };
  return { ok: false, rank: 4, label: `✗ 余量 ${slack} 与 T=${totalAP} 的奇偶不符` };
}

const argv = process.argv.slice(2);
const num = (name: string): number | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : undefined;
};
const ids = argv.filter((a) => REGISTRY[a]);
const range = argv.filter((a) => /^\d+$/.test(a)).map(Number);
const targets = ids.length ? ids : Object.keys(REGISTRY);
/**
 * 搜索节点上限。**默认刻意压得很低**（20 万）以保护本机内存：
 * 求解器在「无解」时要穷尽整个空间才肯返回，堆会涨到数 GB 并触发系统 swap，
 * 曾把磁盘吃到 20G+。
 *
 * A* 用的是可采纳启发式，**找到的第一个解就是最优解** —— 所以限制节点数
 * 只影响「无解」这个结论的可信度，不影响 minAP 的正确性。
 * 未穷尽的组合会显式标注 ⚠，需要时再用 `--nodes 500000` 单独加码（一次只跑一个）。
 */
const NODE_CAP = num("nodes") ?? 100_000;

const pad = (s: string | number, n: number) => String(s).padStart(n);

for (const id of targets) {
  const base = REGISTRY[id];
  const grid =
    range.length >= 2
      ? Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i)
      : DEFAULT_GRID[id] ?? [base.turns];

  console.log(
    `\n### ${id}「${base.title}」 当前 turns=${base.turns} AP/回合=${base.actionPoints}`,
  );
  console.log(
    "    " +
      pad("turns", 6) +
      pad("总AP", 6) +
      pad("最小AP", 8) +
      pad("余量", 6) +
      "  判定",
  );

  const cands: { turns: number; totalAP: number; minAP: number; slack: number; rank: number }[] = [];
  for (const turns of grid) {
    const lv: LevelDef = { ...base, turns };
    const r = solve(lv, { maxNodes: NODE_CAP });
    const totalAP = turns * base.actionPoints;
    const g = gradeSlack(totalAP, r.slack ?? null);
    console.log(
      "    " +
        pad(turns, 6) +
        pad(totalAP, 6) +
        pad(r.minAP ?? "无解", 8) +
        pad(r.slack ?? "-", 6) +
        "  " +
        g.label + (r.exhausted ? "" : "  ⚠未穷尽（可能只是没搜到，别当成无解）"),
    );
    if (g.ok && r.minAP != null && r.slack != null) {
      cands.push({ turns, totalAP, minAP: r.minAP, slack: r.slack, rank: g.rank });
    }
  }

  if (!cands.length) {
    console.log("    → 扫描范围内没有合规解，需要改患者构成（不是加回合）。");
    continue;
  }
  cands.sort((a, b) => a.rank - b.rank || a.turns - b.turns);
  const best = cands[0];
  console.log(
    `    → 推荐 turns=${best.turns}（总AP ${best.totalAP}，最小AP ${best.minAP}，余量 ${best.slack}）` +
      (best.turns === base.turns ? " —— 当前设定已合规" : ` —— 当前为 ${base.turns}，需改`),
  );
}
