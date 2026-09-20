/**
 * 标准解法手册生成器 —— 为 `docs/SOLUTIONS.md` 提供事实底稿。
 *
 * 它回答两个问题，而且两个答案都必须来自真实重放，不许手写：
 *
 *   1. **这一关的最优解是什么？**（逐步：哪一回合、剩几手、做了什么、发生了什么）
 *   2. **这一步做错会怎样？**（反事实注入：把这一步换成别的合法动作，
 *      后面照原计划走，看结局是崩了还是没事）
 *
 * 用法：
 *   npx vite-node tools/solution-book.ts night-04          # 只打印「改变结局」的注入
 *   npx vite-node tools/solution-book.ts night-04 --full   # 打印全部注入
 *   npx vite-node tools/solution-book.ts all               # 七关连跑
 *
 * 【口径声明】反事实用的是「注入一个错误动作 + 接原路径剩余部分」，
 * 不是「错了之后重新求最优解」。它回答的是「这个错误会不会把这一夜搞砸」，
 * 不是「错了之后还有没有救」。后者要重跑求解器，代价是每关分钟级。
 */
import night00 from "../levels/night-00.json";
import night01 from "../levels/night-01.json";
import night02 from "../levels/night-02.json";
import night03 from "../levels/night-03.json";
import night04 from "../levels/night-04.json";
import night05 from "../levels/night-05.json";
import night06 from "../levels/night-06.json";
import { solve } from "../src/solver";
import { NIGHT06_REFERENCE } from "../tests/golden";
import { actionCost, legalActions } from "../src/core/rules";
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

// ─────────────────────────────────────────────────────────────
// 重放
// ─────────────────────────────────────────────────────────────

type Run = {
  outcome: string;
  deaths: number;
  infections: number;
  sequela: number;
  discharged: number;
  total: number;
  turns: number;
  /**
   * 第一个「代价事件」（DIED / INFECTION_EVENT / WINDOW_CLOSED）。
   * **它不等于判负**：有预算的关卡付得起这些代价 —— night-06 允许 1 个后遗症、
   * 2 次感染。把它当致命读，会让整关的注入信号全部塌成同一个「首因」。
   */
  firstCost: string | null;
  costTurn: number | null;
  /** 终局判负的直接原因；赢了就是 null。这才是该看的信号。 */
  cause: string | null;
  /** 被拒绝的动作数（AP 不够 / 非法）—— 说明这条序列已经跑偏 */
  rejected: number;
};

/** 判负的直接原因 —— 与 `reducer.ts` 的判负顺序对齐。 */
function terminalCause(s: GameState): string {
  if (s.deaths > s.maxDeaths) return `死 ${s.deaths} 人（上限 ${s.maxDeaths}）`;
  if (s.infectionEvents > s.maxInfectionEvents) {
    return `感染 ${s.infectionEvents} 次（上限 ${s.maxInfectionEvents}）`;
  }
  if (s.sequelaLimit != null && s.sequelaCount > s.sequelaLimit) {
    return `错过窗口 ${s.sequelaCount} 人（上限 ${s.sequelaLimit}）`;
  }
  return `回合用完，还有 ${s.totalPatients - Object.values(s.patients).filter((p) => p.discharged).length} 人没送走`;
}

function run(level: LevelDef, actions: PlayerAction[]): Run {
  let s: GameState = createInitialState(level);
  let rejected = 0;
  let firstCost: string | null = null;
  let costTurn: number | null = null;

  for (const a of actions) {
    if (s.outcome !== "ONGOING") break;
    const res = reduce(s, a);
    if (!res.accepted) rejected += 1;
    s = res.state;
    if (!firstCost) {
      const cost = res.events.find((e) => /^DIED:|^INFECTION_EVENT$|^WINDOW_CLOSED:/.test(e));
      if (cost) {
        firstCost = cost;
        costTurn = s.turn;
      }
    }
  }

  return {
    outcome: s.outcome,
    deaths: s.deaths,
    infections: s.infectionEvents,
    sequela: s.sequelaCount,
    discharged: Object.values(s.patients).filter((p) => p.discharged).length,
    total: s.totalPatients,
    turns: s.turn,
    firstCost,
    costTurn,
    cause: s.outcome === "LOSE" ? terminalCause(s) : null,
    rejected,
  };
}

function sig(r: Run): string {
  return `${r.outcome} 出院${r.discharged}/${r.total} 死${r.deaths} 感染${r.infections} 后遗${r.sequela}`;
}

/** 一行的「为什么」后缀：判负给崩因；赢了但付了代价就给第一个代价事件。 */
function why(r: Run): string {
  if (r.cause) return ` 崩因 ${r.cause}`;
  const cost = r.firstCost ? ` 代价 ${r.firstCost}@T${r.costTurn}` : "";
  const rej = r.rejected ? ` (${r.rejected} 步没做成)` : "";
  return cost + rej;
}

/** 结局或代价真的变了 —— 用来过滤掉「这步随便换都行」的噪音。 */
function matters(a: Run, b: Run): boolean {
  return (
    a.outcome !== b.outcome ||
    a.deaths !== b.deaths ||
    a.infections !== b.infections ||
    a.sequela !== b.sequela ||
    a.discharged !== b.discharged
  );
}

// ─────────────────────────────────────────────────────────────
// 格式化
// ─────────────────────────────────────────────────────────────

function act(a: PlayerAction): string {
  switch (a.type) {
    case "ADMIT":
      return `ADMIT 床${a.bedId}`;
    case "SCAN":
      return `SCAN ${a.patientId}`;
    case "STABILIZE":
      return `STABILIZE ${a.patientId}`;
    case "ISOLATE":
      return `ISOLATE ${a.patientId}`;
    case "HAND_HYGIENE":
      return "HAND_HYGIENE";
  }
}

function board(s: GameState): string {
  const ps = Object.values(s.patients)
    .filter((p) => !p.discharged)
    .map((p) => {
      const where = p.bedId != null ? `@${p.bedId}` : p.alive ? "@走廊" : "†";
      return `${p.id}${where}(ac${p.acuity}${p.exposure ? ` exp${p.exposure}` : ""}${
        p.sequela ? " 后遗" : ""
      })`;
    });
  return ps.join(" ");
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

const arg = process.argv[2] ?? "all";
const full = process.argv.includes("--full");
const ids = arg === "all" ? Object.keys(ALL) : [arg];

for (const id of ids) {
  const level = ALL[id];
  if (!level) {
    console.error(`未知关卡 ${id}`);
    continue;
  }

  console.log(`\n${"═".repeat(78)}`);
  console.log(`### ${id}「${level.title}」 ${level.turns} 回合 × ${level.actionPoints} 手`);
  console.log(`${"═".repeat(78)}`);

  // ── 取最优解 ──────────────────────────────────────────────
  let path: PlayerAction[];
  let header: string;
  if (id === "night-06") {
    path = NIGHT06_REFERENCE.path as unknown as PlayerAction[];
    header = `参考解 ${NIGHT06_REFERENCE.hands} 手（非穷尽最优，见 tests/golden.ts）`;
  } else {
    const r = solve(level, { maxNodes: 400_000 });
    if (!r.path) {
      console.log(`无解（exhausted=${r.exhausted}）`);
      continue;
    }
    path = r.path;
    header = `最小 ${r.minAP} 手 · 总预算 ${r.totalAP} · 余量 ${r.slack} · 节点 ${r.nodesExplored} · 穷尽 ${r.exhausted}`;
  }
  const base = run(level, path);
  console.log(`\n${header}`);
  console.log(`终局：${sig(base)}  用了 ${base.turns} 回合\n`);

  // ── 步骤表 ────────────────────────────────────────────────
  console.log("── 步骤表 ──────────────────────────────────────");
  let s: GameState = createInitialState(level);
  const snapshots: GameState[] = [];
  for (let i = 0; i < path.length; i++) {
    snapshots.push(s);
    const a = path[i];
    const cost = actionCost(s, a);
    const turnBefore = s.turn;
    const apBefore = s.ap;
    const res = reduce(s, a);
    s = res.state;
    const advanced = s.turn !== turnBefore ? ` ★T${turnBefore}→T${s.turn}` : "";
    console.log(
      ` ${String(i + 1).padStart(2)}. T${turnBefore} 手${apBefore}→${apBefore - cost}` +
        `  ${act(a).padEnd(16)} ${res.events.filter((e) => !/^EXPOSURE:/.test(e)).join(" ") || "—"}` +
        `${advanced}`,
    );
    console.log(`     ${board(s)}`);
  }

  // ── 反事实注入 ────────────────────────────────────────────
  console.log(`\n── 反事实：这一步换成别的会怎样 ──────────────`);
  let keyCount = 0;
  for (let i = 0; i < path.length; i++) {
    const st = snapshots[i];
    const chosen = path[i];
    const legal = legalActions(st);
    const alts = legal.filter((a) => JSON.stringify(a) !== JSON.stringify(chosen));

    const rows: Array<{ alt: string; r: Run }> = [];
    for (const alt of alts) {
      const seq = [...path.slice(0, i), alt, ...path.slice(i + 1)];
      rows.push({ alt: act(alt), r: run(level, seq) });
    }

    const keep = rows.filter((x) => matters(x.r, base));
    const shown = full ? rows : keep;

    // 「干脆不做」要单独判 —— 它常常是唯一致命的那一个，而所有「换成别的」都不致命。
    // （早期版本先 `if (shown.length === 0) continue`，把这类步骤整个吞掉了。）
    const skipSeq = [...path.slice(0, i), ...path.slice(i + 1)];
    const sr = run(level, skipSeq);
    const skipMatters = matters(sr, base);

    if (shown.length === 0 && !skipMatters && !full) continue;

    keyCount += 1;
    console.log(
      `\n[第 ${i + 1} 步] 正确：${act(chosen)}   （T${st.turn} 手${st.ap}）`,
    );
    for (const x of shown) {
      const mark = matters(x.r, base) ? "✗" : "·";
      console.log(`   ${mark} 换成 ${x.alt.padEnd(16)} → ${sig(x.r)}${why(x.r)}`);
    }
    if (full || skipMatters) {
      const mark = skipMatters ? "✗" : "·";
      console.log(`   ${mark} ${"（干脆不做）".padEnd(16)} → ${sig(sr)}${why(sr)}`);
    }
  }
  if (keyCount === 0 && !full) {
    console.log("     （每一步换掉都不影响结局 —— 本关是纯执行关，没有分叉）");
  }
}
console.log("");
