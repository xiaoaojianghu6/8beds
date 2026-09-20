/**
 * 隔离的 AP 价值度量台（v2 —— 治疗分档版）。
 *
 * 用法：
 *   npx vite-node tools/iso-value.ts                            # 全关体检
 *   npx vite-node tools/iso-value.ts night-04                   # 单关
 *   npx vite-node tools/iso-value.ts night-04 --turns 12        # 临时加回合（不动 json）
 *   npx vite-node tools/iso-value.ts night-04 --iso 1 --cur 2   # 临时改定价
 *   npx vite-node tools/iso-value.ts night-04 --k 2             # 临时改感染预算
 *
 * 它回答一个问题：**隔离到底值多少 AP，以及它凭什么值。**
 *
 *   Δ = 最小AP(禁用隔离) − 最小AP(允许隔离)
 *
 * 【v1 为什么错】v1 把 Δ 归因于「观察期」——以为让治好的人滞留床上 N 回合，
 * 隔离买到的 TIME 就有正价格。方向是反的：那是在**惩罚治疗**（治好也不算数）。
 * 真正的问题是**治疗太便宜**：清一个黄档源只要 1 手，既治病又免费断传播，
 * 永远比隔离划算。这是结构性的，靠观察期补不回来。
 *
 * 【v2 的判据】治疗分档（Contract §4.1）：急救 1 手、治愈 2 手。于是
 *   清一个源 = acuity + 1 手（黄档 2 手、病危 3 手），隔离 = isolateCost 手（默认 1）。
 * Δ > 0 ⟺ 清源比隔离贵 ⟺ 「治不起，但挡得起」——这才是隔离在价格上站住的地方。
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

const argv = process.argv.slice(2);
const num = (name: string): number | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : undefined;
};
const ids = argv.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a));
const targets = ids.length ? ids : Object.keys(REGISTRY);
/** 节点上限刻意压低 —— 保护本机内存，理由见 tools/slack-fit.ts 的同名注释。 */
const NODE_CAP = num("nodes") ?? 200_000;

type Line = {
  ap: number | null;
  slack: number | null;
  isolates: number;
  events: number;
  exhausted: boolean;
};

function variant(base: LevelDef, isolate: boolean): LevelDef {
  return {
    ...base,
    turns: num("turns") ?? base.turns,
    actionPoints: num("ap") ?? base.actionPoints,
    enabledActions: isolate
      ? base.enabledActions
      : base.enabledActions.filter((a) => a !== "ISOLATE"),
    rules: {
      ...base.rules,
      isolateCost: num("iso") ?? base.rules.isolateCost ?? 1,
      curativeCost: num("cur") ?? base.rules.curativeCost ?? 2,
      emergencyCost: num("eme") ?? base.rules.emergencyCost ?? 1,
      maxInfectionEvents: num("k") ?? base.rules.maxInfectionEvents,
    },
  };
}

function run(base: LevelDef, isolate: boolean): Line {
  const lv = variant(base, isolate);
  const r = solve(lv, { maxNodes: NODE_CAP });
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
  return { ap: r.minAP, slack: r.slack, isolates, events, exhausted: r.exhausted };
}

function fmt(l: Line): string {
  return l.ap == null
    ? `  无解${l.exhausted ? "" : " ⚠未穷尽（可能只是没搜到，别当成无解）"}`
    : `${String(l.ap).padStart(3)} AP（余量 ${String(l.slack).padStart(2)}）隔离×${l.isolates} 感染=${l.events}${l.exhausted ? "" : " ⚠未穷尽"}`;
}

for (const id of targets) {
  const base = REGISTRY[id];
  if (!base) {
    console.log(`\n### ${id}：未注册`);
    continue;
  }
  const v = variant(base, true);
  console.log(
    `\n### ${id}「${base.title}」 turns=${v.turns} AP/回合=${v.actionPoints} 隔离=${v.rules.isolateCost ?? 1} 治愈=${v.rules.curativeCost ?? 2} 预算=${v.rules.maxInfectionEvents}`,
  );
  const a = run(base, true);
  const b = run(base, false);
  console.log(`    允许隔离  ${fmt(a)}`);
  console.log(`    禁用隔离  ${fmt(b)}`);
  if (a.ap == null && b.ap != null) {
    // 逻辑矛盾：禁用隔离的解在「允许隔离」里同样合法（不隔离就是了），
    // 所以允许侧的搜索空间 ⊇ 禁用侧。允许侧报无解只可能是**未穷尽的假阴性**
    // ——它分支更多，同样的节点上限下更先撞墙。绝不能读成「隔离是必做项」。
    console.log(
      `    ⚠ 假阴性：允许隔离侧没搜到，但禁用侧有解 ${b.ap} AP。\n` +
        `      允许侧的解空间 ⊇ 禁用侧（不隔离即可），故允许侧必然也可解且 ≤ ${b.ap} AP。\n` +
        `      根因是允许侧分支更多、先撞上 ${NODE_CAP} 节点上限 —— 提高 --nodes 重跑，\n` +
        `      在此之前以禁用侧为准：Δ ≥ 0（隔离不劣于硬扛）。`,
    );
    continue;
  }
  if (a.ap == null || b.ap == null) {
    console.log(
      a.ap == null && b.ap == null
        ? "    ⚠ 两侧都无解 —— 这一关整体不成立（不是隔离的问题）"
        : "    ⚠ 禁用隔离无解（允许侧有解）⇒ 隔离是必做项，违反「没有必做项」",
    );
    continue;
  }
  const d = b.ap - a.ap;
  const verdict =
    d > 0
      ? "✅ 隔离是 AP 正收益 —— 清源比隔离贵，这一手是腾出来的"
      : d === 0
        ? "○ 同价 —— 真正的风格选择"
        : "⚠ 硬扛更划算 —— 隔离是摆设，检查源的边是否通向真人";
  console.log(`    Δ = ${d} AP  ${verdict}`);
}
