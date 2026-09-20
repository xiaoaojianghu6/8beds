/**
 * 失败结算页的排版预算检查。
 *
 * 为什么需要它：贴士文案变长（补了真实案例的数字与出处）之后，右栏可能放不下
 * 三条 —— 而「放不下」的表现是**最后一条被 `break` 掉**（静默少一条），
 * 或者更糟：压到按钮上。`Ward.ts → drawOutcome()` 用 `tipHeight()` 先量后排，
 * 这里的算法与它逐行对应，用同一套 `wrapCJK`，所以量出来的数就是屏幕上的数。
 *
 * 用法：npx vite-node tools/tip-fit.ts
 */
import { measureText, wrapCJK } from "../src/ui/text";
import { resolveTips, TIPS, TIP_SEGMENT_ORDER, type TipView } from "../src/ui/tips";
import { createInitialState } from "../src/core/state";
import { legalActions } from "../src/core/rules";
import { reduce } from "../src/core/reducer";
import { levels, nightOrder } from "../src/levels";
import type { GameState, LevelDef, PlayerAction } from "../src/core/types";

const W_R = Number(process.argv[2] ?? 536);
const BODY = Number(process.argv[3] ?? 12);
const BODYLH = Number(process.argv[4] ?? 16);
const TOP = 160;
const BOTTOM = Number(process.argv[5] ?? 596);

/**
 * 标题行占多高。与 `Ward.ts → headerH()` 逐字对应：角标挤得进标题行就 18px，
 * 挤不进就退到下一行、占 30px。这里和渲染必须同源，否则「量」与「排」分家。
 */
function tipHeaderH(tip: TipView): number {
  if (!tip.source) return 18;
  return headerFits(tip) ? 18 : 30;
}

function tipHeight(tip: TipView): number {
  let h = tipHeaderH(tip);
  for (const [key, name] of TIP_SEGMENT_ORDER) {
    const body = tip.segments[key];
    if (!body) continue;
    h += wrapCJK(`${name}：${body}`, BODY, W_R).split("\n").length * BODYLH + 3;
  }
  return h + 14;
}

/** 标题行的字符串（与 `Ward.ts → drawOutcome()` 逐字一致）。 */
function headOf(tip: TipView): string {
  return `${tip.label}${tip.subject ? `　${tip.subject}` : ""}`;
}

/**
 * 标题行放得下吗：标题（13px）左对齐 + 出处角标（10px）右对齐，不能撞上。
 * 宽度用 `measureText()` —— 与渲染同一套字符宽度规则，不靠「字数 × 字号」估。
 */
function headerFits(tip: TipView): boolean {
  const tagW = tip.source ? measureText(tip.source, 10) : 0;
  return measureText(headOf(tip), 13) + tagW + 16 <= W_R;
}

const asView = (t: (typeof TIPS)[number]): TipView => ({
  id: t.id,
  label: t.label,
  subject: null,
  segments: t.segments,
  confidence: t.confidence,
  source: t.source,
});

console.log("=== 每一条贴士单独占多高（可用高度 " + (BOTTOM - TOP) + "px）===");
const rows = TIPS.map((t) => ({ id: t.id, h: tipHeight(asView(t)), ok: headerFits(asView(t)) }));
rows.sort((a, b) => b.h - a.h);
for (const r of rows) {
  const flag = (!r.ok ? "  ← 标题行放不下角标！" : "") + (r.h > BOTTOM - TOP ? "  ← 单条就超框！" : "");
  console.log(`  ${r.id.padEnd(6)} ${String(r.h).padStart(3)}px${flag}`);
}

console.log("\n=== 最坏组合：每个 trigger 各取最高的一条，再取全局最高的三条 ===");
// `resolveTips` 一局最多给 3 条，而且**同一 trigger 只出一条**（08 §11.3）。
// 所以「全场最高的三条」是个不存在的组合 —— 例如 T10-0 与 T10-1 都属于
// DELAYED_DIRECT，永远不会同时出现。不按 trigger 去重，这里会常年显示 ✗，
// 而一条永远红的检查等于没有检查（真正的风险会被这条噪音盖掉）。
const perTrigger = new Map<string, { id: string; h: number }>();
for (const t of TIPS) {
  const h = tipHeight(asView(t));
  const cur = perTrigger.get(t.trigger);
  if (!cur || h > cur.h) perTrigger.set(t.trigger, { id: t.id, h });
}
const worst = [...perTrigger.values()].sort((a, b) => b.h - a.h).slice(0, 3);
const worstSum = worst.reduce((s, r) => s + r.h, 0);
console.log(
  "  " +
    worst.map((r) => `${r.id}(${r.h})`).join(" + ") +
    ` = ${worstSum}px，可用 ${BOTTOM - TOP}px` +
    (worstSum <= BOTTOM - TOP ? "  ✓ 放得下" : "  ✗ 放不下 —— 第三条会被静默挤掉"),
);

console.log("\n=== 真实局面下实际放得下几条 ===");
for (const id of nightOrder) {
  const level = levels[id] as unknown as LevelDef;
  const s0 = createInitialState(level);
  // 乱走到底，制造一个真实的失败局面
  let st: GameState = s0;
  let guard = 0;
  while (st.outcome === "ONGOING" && guard++ < 400) {
    const acts = legalActions(st) as PlayerAction[];
    if (acts.length === 0) break;
    const r = reduce(st, acts[guard % acts.length]);
    st = r.accepted ? r.state : st;
    if (!r.accepted && acts.length === 1) break;
    if (!r.accepted) {
      const alt = acts.find((a) => reduce(st, a).accepted);
      if (!alt) break;
      st = reduce(st, alt).state;
    }
  }
  const tips = resolveTips(st, 3);
  let ty = TOP;
  const shownIds: string[] = [];
  const clashes: string[] = [];
  for (const t of tips) {
    const h = tipHeight(t);
    if (ty + h > BOTTOM) break;
    ty += h;
    shownIds.push(`${t.id}(${h}px)`);
    // 带真实 subject 的标题行才是屏幕上真正的宽度 —— 表格里 subject 是 null，
    // 所以标题/角标打架只可能在这里被发现。
    if (!headerFits(t)) clashes.push(`${t.id}「${headOf(t)}」+「${t.source}」`);
  }
  console.log(
    `  ${id}  outcome=${st.outcome.padEnd(7)} 候选 ${tips.map((t) => t.id).join(",")}` +
      ` → 放下 ${shownIds.length} 条 [${shownIds.join(" ")}]` +
      ` · 用掉 ${ty - TOP}px / ${BOTTOM - TOP}px` +
      (shownIds.length < tips.length ? "  ← 有贴士被挤掉" : "") +
      (clashes.length ? `\n      ⚠ 标题行与角标相撞，角标退到第二行：${clashes.join("；")}` : ""),
  );
}
