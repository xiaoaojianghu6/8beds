/**
 * 贴士覆盖审计 —— 回答「哪种失败，弹哪几条贴士」。
 *
 * 为什么需要它：`docs/level-design/08-DEATH-TIPS.md §11.3` 写了一张
 * 「trigger → 贴士」的设计表，但**设计表不是事实**。真正决定玩家看到什么的是
 * `resolveTips()` 从 `history[].events` 里挖出来的 `findings()`。两者可能不一致：
 *
 *   · 某条贴士**永远弹不出来**（设计表里有，实际没有事件能命中它）—— 死内容；
 *   · 某种失败**一条贴士都没有**（判负了，右栏空着）—— 覆盖漏洞；
 *   · 同一个 trigger **总是**和另一个 trigger 同时出现 —— 分诊实际没生效。
 *
 * 做法：确定性随机走子（多种偏置，逼出不同死法）× 七关，逐局记录
 * `review.kind` 与 `resolveTips()` 的结果。偏置的意义是**主动去撞**那些
 * 均匀随机几乎撞不到的失败模式（不洗手、不隔离、只检测不治疗）。
 *
 * 用法：
 *   npx vite-node tools/tips-audit.ts            # 汇总报告
 *   npx vite-node tools/tips-audit.ts --cases    # 附带零贴士局面的原始事件
 */
import night00 from "../levels/night-00.json";
import night01 from "../levels/night-01.json";
import night02 from "../levels/night-02.json";
import night03 from "../levels/night-03.json";
import night04 from "../levels/night-04.json";
import night05 from "../levels/night-05.json";
import night06 from "../levels/night-06.json";
import { reduce } from "../src/core/reducer";
import { legalActions } from "../src/core/rules";
import { createInitialState } from "../src/core/state";
import { buildReview } from "../src/ui/review";
import { resolveTips, TIPS } from "../src/ui/tips";
import type { ActionType, GameState, LevelDef, PlayerAction } from "../src/core/types";

const LEVELS: Record<string, LevelDef> = {
  "night-00": night00 as unknown as LevelDef,
  "night-01": night01 as unknown as LevelDef,
  "night-02": night02 as unknown as LevelDef,
  "night-03": night03 as unknown as LevelDef,
  "night-04": night04 as unknown as LevelDef,
  "night-05": night05 as unknown as LevelDef,
  "night-06": night06 as unknown as LevelDef,
};
const ORDER = Object.keys(LEVELS);

/** mulberry32 —— 32 位确定性 PRNG，保证「同一种子同一条路径」。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 行动偏置 —— 每一种都是一种「玩家的坏习惯」。
 * 权重为 0 表示这类动作**永不选**（用来逼出「整晚没洗手」这种局面）。
 */
type Bias = {
  name: string;
  w: Partial<Record<ActionType, number>>;
  /** 逐动作覆盖权重（返回 0 = 这个动作这类玩家根本不会选）。 */
  filter?: (st: GameState, a: PlayerAction) => number | undefined;
};
const BIASES: Bias[] = [
  { name: "均匀乱走", w: {} },
  { name: "不检测直接治", w: { SCAN: 0, STABILIZE: 6 } },
  { name: "整晚不洗手", w: { HAND_HYGIENE: 0 } },
  { name: "整晚不隔离", w: { ISOLATE: 0 } },
  { name: "只检测不治疗", w: { SCAN: 8, STABILIZE: 0.2, ISOLATE: 1, ADMIT: 1 } },
  { name: "只隔离不治疗", w: { ISOLATE: 8, STABILIZE: 0.2, SCAN: 1 } },
  { name: "从不收治", w: { ADMIT: 0 } },
  /**
   * 「分诊式半治」—— 真人最可能犯的错，也是唯一能逼出「超过抢救期限」的行为：
   * 只花 1 手做急救档把人从红灯压回黄灯，**永远不给到 0**（治愈要 2 手，舍不得），
   * 于是抢救期限在黄灯上悄悄走完。
   * 没有这条偏置，`T3-1`（脓毒性休克）在随机走子里永远出不来 —— 第一版审计因此
   * 把一条可达贴士误判成死内容。**偏置表本身就是审计的盲区来源。**
   */
  {
    name: "分诊式半治",
    w: { SCAN: 3, STABILIZE: 3, ADMIT: 2, ISOLATE: 0, HAND_HYGIENE: 1 },
    filter: (st, a) => {
      if (a.type !== "STABILIZE") return undefined;
      const p = st.patients[a.patientId ?? ""];
      return p && p.acuity >= 2 ? 3 : 0;
    },
  },
  /** 猛收治、不洗手：逼床单元污染那条路径（T6-1）。 */
  { name: "只搬床不洗手", w: { ADMIT: 6, STABILIZE: 2, SCAN: 2, ISOLATE: 0, HAND_HYGIENE: 0 } },
  /**
   * 「只收治不治疗」—— 搬进来就不管：病人占满了床，谁都没被治过。
   * 能逼出 timeout（T7-2）与场内传染（T4），但 T01 这类 rate-2 患者会在
   * 第 1 回合末死穿上限，后半程的局面（含 night-05 的窗）根本到不了。
   */
  { name: "只收治不治疗", w: { ADMIT: 8, STABILIZE: 0.2, SCAN: 1, ISOLATE: 1, HAND_HYGIENE: 1 } },
  /**
   * 「漏掉最轻的那个」—— 一个小心但带盲区的玩家：吓人的病一个个认真治，
   * 镜像也老老实实先检测，唯独「看起来最轻」的（MILD）从头到尾没人管。
   * night-05/S01 的抢救期限因此在一整类真实玩法里悄悄走完（T3-1）。
   */
  {
    name: "漏掉最轻的那个",
    w: { STABILIZE: 6, SCAN: 2, ADMIT: 2, ISOLATE: 1, HAND_HYGIENE: 1 },
    filter: (st, a) => {
      if (a.type === "SCAN") {
        const p = st.patients[a.patientId ?? ""];
        // 镜像患者优先检测 —— 这类玩家不是莽夫，他只是漏掉安静的病人
        return p && p.axisIntervention === "MIRROR" && !p.revealed.includes("riskProfile")
          ? 8
          : 1;
      }
      if (a.type !== "STABILIZE") return undefined;
      const p = st.patients[a.patientId ?? ""];
      if (!p) return undefined;
      if (p.archetype === "MILD") return 0; // 盲区：最轻的那个从不动手
      if (p.axisIntervention === "MIRROR" && !p.revealed.includes("riskProfile")) return 0;
      return 6;
    },
  },
];

function weightedPick(
  acts: PlayerAction[],
  bias: Bias,
  rand: () => number,
  st: GameState,
): PlayerAction | null {
  const scored = acts.map((a) => ({ a, w: bias.filter?.(st, a) ?? bias.w[a.type] ?? 1 }));
  const total = scored.reduce((n, s) => n + s.w, 0);
  if (total <= 0) return null;
  let r = rand() * total;
  for (const s of scored) {
    r -= s.w;
    if (r <= 0) return s.a;
  }
  return scored[scored.length - 1].a;
}

type Case = {
  level: string;
  bias: string;
  seed: number;
  kind: string;
  headline: string;
  tips: string[];
  /** 与 `tips` 一一对应的「说的是谁」（`whoIs()` 的口径：床位 + 主诉）。 */
  subjects: Array<string | null>;
  events: string[];
};

/** 走完一局：随机（带偏置）直到判出胜负或步数上限。 */
function playout(levelId: string, bias: Bias, seed: number): Case {
  const rand = mulberry32(seed);
  let st: GameState = createInitialState(LEVELS[levelId]);
  let guard = 0;
  while (st.outcome === "ONGOING" && guard++ < 600) {
    const acts = legalActions(st) as PlayerAction[];
    if (acts.length === 0) break;
    const want = weightedPick(acts, bias, rand, st);
    // 偏置可能挑中一个非法动作（例如手不够）；退回到任意合法动作，保证走得下去。
    let r = want ? reduce(st, want) : { accepted: false, state: st, events: [] as string[] };
    if (!r.accepted) {
      const alt = acts[Math.floor(rand() * acts.length)];
      r = reduce(st, alt);
      if (!r.accepted) break;
    }
    st = r.state;
  }
  const review = buildReview(st);
  const tips = resolveTips(st);
  const last = st.history[st.history.length - 1];
  return {
    level: levelId,
    bias: bias.name,
    seed,
    kind: st.outcome === "WIN" ? "WIN" : review.kind,
    headline: review.headline,
    tips: tips.map((t) => t.id),
    subjects: tips.map((t) => t.subject),
    events: last ? last.events : [],
  };
}

const SEEDS_PER_BIAS = Number(process.env.SEEDS ?? 40);
const cases: Case[] = [];
for (const levelId of ORDER) {
  for (const bias of BIASES) {
    for (let s = 1; s <= SEEDS_PER_BIAS; s++) {
      cases.push(playout(levelId, bias, s * 7919 + bias.name.length * 31));
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────

const loses = cases.filter((c) => c.kind !== "WIN");
const wins = cases.length - loses.length;

// ① 每条贴士是否可达
const tipHits = new Map<string, number>();
for (const c of loses) for (const id of c.tips) tipHits.set(id, (tipHits.get(id) ?? 0) + 1);
const dead = TIPS.filter((t) => !tipHits.has(t.id));

// ② 判负但一条贴士都没有 = 右栏空白
const zero = loses.filter((c) => c.tips.length === 0);

console.log(`贴士覆盖审计 · ${LEVELS ? ORDER.length : 0} 关 · 每种偏置 ${SEEDS_PER_BIAS} 局`);
console.log(`样本 ${cases.length} 局：判负 ${loses.length} · 通关 ${wins}\n`);

console.log("=== ① 每条贴士的实际出现次数（0 = 死内容）===");
for (const t of TIPS) {
  const n = tipHits.get(t.id) ?? 0;
  const mark = n === 0 ? "✗ 从未出现" : `${n} 次`;
  console.log(`  ${t.id.padEnd(6)} ${mark.padEnd(12)} ${t.trigger.padEnd(20)} ${t.label}`);
}

console.log("\n=== ①b 每条贴士实际「说的是谁」（同一条贴士跨关卡指向了几种病）===");
for (const t of TIPS) {
  const subj = new Set<string>();
  for (const c of loses) {
    c.tips.forEach((id, i) => {
      if (id === t.id && c.subjects[i]) subj.add(`${c.level} ${c.subjects[i]}`);
    });
  }
  if (subj.size === 0) continue;
  const list = [...subj];
  const kindsOfPatient = new Set(list.map((s) => s.split("· ")[1] ?? "?"));
  console.log(
    `  ${t.id.padEnd(6)} 指向 ${String(list.length).padStart(2)} 种人（${kindsOfPatient.size} 类主诉）` +
      (kindsOfPatient.size > 1 ? "  ← 一条贴士对着多种病" : ""),
  );
  for (const s of list.slice(0, 4)) console.log(`           ${s}`);
  if (list.length > 4) console.log(`           …还有 ${list.length - 4} 种`);
}

console.log("\n=== ② 失法 × 贴士矩阵（哪一类失败，右栏讲什么）===");
const kinds = [...new Set(loses.map((c) => c.kind))].sort();
for (const k of kinds) {
  const sub = loses.filter((c) => c.kind === k);
  const counts = new Map<string, number>();
  for (const c of sub) for (const id of c.tips) counts.set(id, (counts.get(id) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n  【${k}】${sub.length} 局  —— headline 示例：${sub[0].headline}`);
  if (top.length === 0) console.log("    （这类失败从来没有贴士）");
  for (const [id, n] of top) {
    const t = TIPS.find((x) => x.id === id)!;
    console.log(`    ${String(n).padStart(4)} 局  ${id.padEnd(6)} ${t.label}`);
  }
}

console.log("\n=== ③ 每关能撞到的失败类型 ===");
for (const levelId of ORDER) {
  const sub = loses.filter((c) => c.level === levelId);
  const kindsHere = [...new Set(sub.map((c) => c.kind))].join(" / ") || "（没判负过）";
  const tipsHere = new Set<string>();
  for (const c of sub) for (const id of c.tips) tipsHere.add(id);
  const zeroHere = sub.filter((c) => c.tips.length === 0).length;
  console.log(
    `  ${levelId}  判负 ${String(sub.length).padStart(3)} 局  类型 ${kindsHere.padEnd(28)}` +
      ` 贴士 ${[...tipsHere].sort().join(",") || "—"}` +
      (zeroHere ? `   ← 其中 ${zeroHere} 局右栏空白` : ""),
  );
}

console.log("\n=== ④ 判负但右栏空白（覆盖漏洞）===");
if (zero.length === 0) {
  console.log("  无 —— 每一次判负都至少讲了一条真实病例");
} else {
  console.log(`  共 ${zero.length} 局（占判负 ${((zero.length / loses.length) * 100).toFixed(1)}%）`);
  const byKey = new Map<string, Case[]>();
  for (const c of zero) {
    const k = `${c.level}|${c.kind}`;
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }
  for (const [k, list] of byKey) {
    console.log(`  ${k}  ×${list.length}   （偏置：${[...new Set(list.map((c) => c.bias))].join("/")}）`);
    if (process.argv.includes("--cases")) {
      console.log(`      最后一次事件：${list[list.length - 1].events.join("  ")}`);
    }
  }
}

// ⑤ 关键词分诊健康度 —— `match` 是**症状词表**，它必须真的能在关卡文案里命中，
//    否则这条贴士永远排在通用那条之后（甚至永远不出来）。
console.log("\n=== ⑤ 症状词分诊：每条 match 在全部关卡里能命中谁 ===");
type Def = { level: string; id: string; hay: string; tw?: number; disruptive?: boolean };
const defs: Def[] = [];
for (const levelId of ORDER) {
  const lv = LEVELS[levelId];
  for (const d of [...lv.initialPatients, ...lv.arrivalSchedule.flat()]) {
    defs.push({
      level: levelId,
      id: d.id,
      // 与 `tips.ts → haystack()` 同一口径：主诉 + 原话，**不含 keyClue**
      hay: `${d.visible.chiefComplaint}${d.visible.utterance ?? d.visible.chiefComplaint}`,
      tw: d.rules?.timeWindow,
      disruptive: d.rules?.disruptive,
    });
  }
}
const triageDead: string[] = [];
for (const t of TIPS.filter((x) => x.match?.length)) {
  const hits = defs.filter((d) => t.match!.some((k) => d.hay.includes(k)));
  if (hits.length === 0) triageDead.push(t.id);
  const where = hits.map((h) => `${h.level}/${h.id}`).slice(0, 6).join(" ");
  console.log(
    `  ${t.id.padEnd(6)} 命中 ${String(hits.length).padStart(2)} 人  「${t.match!.join("/")}」` +
      `  ${where}${hits.length > 6 ? " …" : ""}`,
  );
}
console.log(
  triageDead.length
    ? `  ✗ 分诊词表撞不到任何患者：${triageDead.join("、")}（永远只能靠通用那条顶上）`
    : "  ✓ 每条带分诊词表的贴士至少能命中一个患者",
);

console.log("\n=== ⑤b 带抢救期限的患者，各自会被分诊到哪条贴士 ===");
for (const d of defs.filter((x) => (x.tw ?? 0) > 0)) {
  const cands = TIPS.filter((t) => t.trigger === "WINDOW_CLOSED");
  const scored = cands
    .filter((t) => t.match?.length)
    .map((t) => ({ id: t.id, s: t.match!.reduce((n, k) => (d.hay.includes(k) ? n + 1 : n), 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const generic = cands.find((t) => !t.match);
  console.log(
    `  ${d.level}/${d.id}  窗 ${d.tw} 「${d.hay}」  →  ${scored.length ? scored[0].id : `${generic?.id}（通用兜底）`}`,
  );
}

console.log(`\n结论：贴士 ${TIPS.length} 条，可达 ${tipHits.size} 条，死内容 ${dead.length} 条。`);
