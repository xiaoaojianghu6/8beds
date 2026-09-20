import { actionCost, dischargedCount, legalActions } from "../core/rules";
import { reduce, targetDischarges } from "../core/reducer";
import { cloneState, createInitialState } from "../core/state";
import type { GameState, LevelDef, PlayerAction } from "../core/types";

/**
 * 关卡求解器 —— 直接复用 reducer / legalActions，不另写一套规则。
 *
 * 用途：
 *  1. 判定关卡是否可解（Solver Gate）
 *  2. 给出**最小 AP 解**，从而算出容错余量 slack = 总AP - 最小解AP
 *  3. 扫描参数空间，给数值配平提供依据
 *
 * 前提：确定性 reducer（Contract 第一条禁止随机）。若未来引入随机，本文件必须重写。
 *
 * 算法：A*（启发式可采纳 + 允许 reopen，保证最优解），
 *      配 branch-and-bound 剪枝。纯 BFS 在 turns≥8 时会指数爆炸，撑不住参数扫描。
 *
 * 【v2 修正】搜索代价 g 是 **AP**，不是动作数。
 * v1 写死 `g = node.g + 1`，而 ISOLATE 实际消耗 `isolateCost`（默认 1，v1 时是 2）。
 * 凡最优解含隔离，v1 报出的最小 AP / 余量 / 可解性全部偏乐观
 * —— 这是会直接影响关卡是否成立的错误。
 */

export type SolveOptions = {
  /** 节点上限。触及上限时 exhausted=false，结论不可信。默认 500k */
  maxNodes?: number;
  /** 关掉启发式退化为 Dijkstra（用于校验启发式是否可采纳） */
  noHeuristic?: boolean;
  /**
   * 加权 A*：f = g + weight × h。weight > 1 牺牲最优性换速度，
   * 用于巨型关卡（地狱关）快速找可行解 —— 解的质量随 weight 升高而变差。
   * 返回的 solvable 仍然可信（找到的路径重放必胜）；minAP 不再是最优值。
   */
  weight?: number;
  /**
   * 已知解的上界（通常来自加权 A* 的快速解）。精确 A* 从一开始就按它做
   * branch-and-bound 剪枝 —— 若最终穷尽且没有找到更小的 g，上界即最小值。
   * 传「上界路径的 AP」；若搜到严格更小的解，返回的就是真最优。
   */
  upperBound?: number;
  /**
   * 从**中途局面**开始搜。用途：回答「先犯了这个错，后面还有没有得救」。
   *
   * 与开局最优解互补：从开局搜出来的最优解永远不会走进「已经犯了错」的局面，
   * 所以「犯错之后还能不能赢」只能从中途开局问。诊断工具靠它把这类问题钉死。
   *
   * （v2 时期它是「误治之后还有没有补救线」的唯一验证手段；2026-09-17 误诊改成
   * 当帧判负之后，那个特定问题已经不需要它回答了 —— 误诊的当帧 `outcome` 就是 LOSE。）
   *
   * 传入的 state 会被克隆，调用方那份不受影响。
   *
   * ⚠️ 用 `startState` 时 **`slack` 没有意义**（它是拿整关总预算减后端 minAP 算的，
   * 而中途开局要减的是「剩下的手」）。只看 `solvable` / `path` / `minAP`(后端消耗)。
   */
  startState?: GameState;
};

export type SolveResult = {
  levelId: string;
  solvable: boolean;
  /** 最小 AP 消耗。注意：不等于动作数，隔离更贵。 */
  minAP: number | null;
  /** 最优解动作序列（AP 消耗最小） */
  path: PlayerAction[] | null;
  /** 容错余量 = maxTurns × actionPoints - minAP。null 表示不可解 */
  slack: number | null;
  totalAP: number;
  nodesExplored: number;
  /**
   * true = 搜索空间**按预算穷尽**，`solvable=false` 是真的「这一关赢不了」；
   * false = 触及 maxNodes 上限，结论作废。
   *
   * ⚠️ 口径要说清：穷尽是指「所有**预算内**的分支都走完了」，不是「把所有能到达的
   * 局面都数了一遍」。搜索带三种**合法**剪枝 —— 支配剪枝（不搜必然劣的动作）、
   * 预算界剪枝（`已花 + 下界 > 总手数` ⇒ 这条分支不可能赢）、branch-and-bound。
   * 三者都只砍掉**可证明赢不了**的分支，所以结论仍然成立。
   */
  exhausted: boolean;
};

/**
 * 启发式：达成出院目标至少还要花多少 AP。
 *
 * 可采纳性（admissible）：每个患者出院所需 AP 不可能低于这个估算。
 *
 *  - 收治：不在床就要 1 AP
 *  - 检查：SCAN_FIRST 与 MIRROR 都是**规则强制**的——不检测就处置，
 *    前者无效后者必然进不可逆通道（Contract §5）。DIRECT 才可以省下检查的钱
 *  - 处置：每次降 1 点，所以是 acuity（急救 1 手、治愈 2 手，见 `stabilizeCost`）
 *  - 隔离：**不计入**。出院只看 acuity（Contract §2.1），隔离永远不是规则要求的，
 *    把它算进下界会让启发式变成可采纳但极松，顺带把「隔离是可选的」这条设计约束抹掉
 *  - 误诊：不建模。未检测就处置 MIRROR = 当帧判负（Contract §5.3），
 *    它不是「更贵的路」，是「不存在的路」，所以对下界没有影响
 *
 * 病情恶化只会让代价更高，所以下界成立。
 */
export function heuristic(state: GameState): number {
  const need = targetDischarges(state) - dischargedCount(state);
  if (need <= 0) return 0;

  // 后遗症余量：还有几个「窗口关闭免费离床」的名额可用。
  // 有名额时，开放时间窗的患者存在一条近乎 0 手离床的合法路径 ——
  // 给他们记满额治疗费会高估（不可采纳），在地狱关（sequelaLimit ≥ 1）会漏最优解。
  // 但名额只有 sequelaRoom 个：只有这么多的「免费」可以抵扣 —— 全部记 0 又会过于宽松。
  // 折中（仍可采纳）：正常计价，最后至多减去一个最大的窗口节省额。
  const sequelaRoom =
    state.sequelaLimit == null
      ? Infinity
      : Math.max(0, state.sequelaLimit - state.sequelaCount);

  const entries: Array<{ c: number; saving: number }> = [];
  for (const p of Object.values(state.patients)) {
    if (!p.alive || p.discharged) continue;
    let c = 0;
    if (p.bedId == null) c += 1; // 收治
    const admitPart = c;
    if (
      (p.axisIntervention === "SCAN_FIRST" || p.axisIntervention === "MIRROR") &&
      !p.revealed.includes("riskProfile")
    ) {
      c += 1; // 检测是这两类患者出院的必经一手
    }
    // 处置（Contract §4.1 分档）：降到黄档是 (acuity−1) 次急救档，最后一步是治愈档。
    if (p.acuity > 0) c += (p.acuity - 1) * state.emergencyCost + state.curativeCost;
    // 注意：谵妄附加费不能计入下界 —— 玩家可以先处置谵妄患者解除附加费，
    // 计入会让启发式不可采纳（会漏掉「先治谵妄再治别人」的最优解）。
    const saving =
      sequelaRoom > 0 && p.timeWindow && p.windowClock > 0 && !p.sequela
        ? c - admitPart // 趁窗口关闭免费走人，省下检测+治疗的全部
        : 0;
    entries.push({ c, saving }); // 出院免费，隔离非必需，都不计入
  }

  entries.sort((a, b) => a.c - b.c);
  let sum = 0;
  let maxSaving = 0;
  for (let i = 0; i < Math.min(need, entries.length); i++) {
    sum += entries[i].c;
    if (entries[i].saving > maxSaving) maxSaving = entries[i].saving;
  }
  sum -= maxSaving; // 至多一名患者走后遗症路线（sequelaRoom ≥ 1 时）
  // 脏手（Contract §6A.1）：只要最便宜的那批出院目标里有一个非 HIGH 源，
  // 动手前就必须先洗一次 —— 这是可采纳的下界（全是 HIGH 目标时不用洗）。
  if (state.handHygieneEnabled && state.handState === "CONTAMINATED") {
    const targets = Object.values(state.patients)
      .filter((p) => p.alive && !p.discharged)
      .sort(
        (a, b) =>
          (a.transmission === "HIGH" ? 0 : 1) - (b.transmission === "HIGH" ? 0 : 1),
      )
      .slice(0, need);
    if (targets.some((p) => p.transmission !== "HIGH")) sum += 1;
  }
  // 尚未到达的患者不能按「不可能」处理——他们会在后续回合进场。
  // 用乐观下界补齐（仅收治，假设到场即康复且无需检查/隔离），以保持可采纳性。
  if (entries.length < need) sum += need - entries.length;
  return sum;
}

/**
 * 状态指纹。排除 history（只增、不影响状态转移）与 arrivalSchedule（静态、所有分支相同）。
 */
export function stateKey(s: GameState): string {
  let out =
    `${s.turn}|${s.ap}|${s.deaths}|${s.infectionEvents}|${s.curtains.join("+")}|${s.outcome}|` +
    `${s.queue.join(">")}|${s.handState}|${s.sequelaCount}|`;
  for (let i = 1; i <= 8; i++) out += (s.beds[i] ?? "_") + `,${s.bedRisk[i] ?? 0}` + ",";
  out += "|";
  for (const id of Object.keys(s.patients).sort()) {
    const p = s.patients[id];
    out +=
      `${id}:${p.acuity},${p.alive ? 1 : 0}${p.discharged ? 1 : 0},${p.bedId ?? -1},` +
      `${p.exposure},${p.escalations},${p.deteriorationClock},` +
      `${p.stabilizedThisTurn ? 1 : 0},${p.escalatedThisTurn ? 1 : 0},` +
      `${p.missedStabilizationWindow},${[...p.revealed].sort().join("+")},` +
      `${p.observing ? 1 : 0}:${p.observationClock}:${p.windowClock}:${p.sequela ? 1 : 0};`;
  }
  return out;
}

/**
 * 状态指纹的 64 位哈希（FNV-1a 双趟）。
 * 完整指纹串每态可达 1KB，百万态的 Map 会吃掉数 GB —— 哈希成 16 字符短键，
 * 内存降一个量级。双 32 位组合把碰撞空间推到 2^64（同一搜索内实际无碰撞）。
 */
function hashState(s: GameState): string {
  const k = stateKey(s);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < k.length; i++) {
    const ch = k.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 16777619);
    h2 = Math.imul(h2 + ch + i, 2246822519);
  }
  return (h1 >>> 0).toString(36) + "." + (h2 >>> 0).toString(36);
}

/** 剥离 history：reduce 持续追加，保留它会让内存随深度线性增长 */
function trim(state: GameState): GameState {
  state.history = [];
  return state;
}

/** 最小二叉堆。A* 需要按 f = g + h 取最小 */
class MinHeap<T> {
  private a: T[] = [];
  constructor(private readonly keyOf: (t: T) => number) {}
  get size(): number {
    return this.a.length;
  }
  push(v: T): void {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keyOf(a[parent]) <= this.keyOf(a[i])) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.keyOf(a[l]) < this.keyOf(a[m])) m = l;
        if (r < a.length && this.keyOf(a[r]) < this.keyOf(a[m])) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

type Node = {
  /** 弹出展开后即置空 —— 路径回溯只需要 parent+action，状态留着纯粹是内存泄漏。 */
  state: GameState | null;
  parent: number;
  action: PlayerAction | null;
  /** 从开局到这里的**累计 AP 消耗** */
  g: number;
};

function reconstruct(nodes: Node[], index: number): PlayerAction[] {
  const path: PlayerAction[] = [];
  let cur = index;
  while (cur > 0) {
    const node = nodes[cur];
    if (node.action) path.push(node.action);
    cur = node.parent;
  }
  return path.reverse();
}

export function solve(level: LevelDef, opts: SolveOptions = {}): SolveResult {
  const maxNodes = opts.maxNodes ?? 200_000;
  const totalAP = level.turns * level.actionPoints;
  const weight = opts.weight ?? 1;
  const h = opts.noHeuristic ? () => 0 : heuristic;

  const start = trim(opts.startState ? cloneState(opts.startState) : createInitialState(level));
  const nodes: Node[] = [{ state: start, parent: -1, action: null, g: 0 }];

  // bestG 记录到达某状态的最小 AP；允许 reopen 以保证最优性
  // （本启发式可采纳但不一致，closed-set 不 reopen 可能返回次优解）
  const bestG = new Map<string, number>([[hashState(start), 0]]);

  const open = new MinHeap<{ index: number; f: number }>((n) => n.f);
  open.push({ index: 0, f: h(start) * weight });

  let nodesExplored = 0;
  let exhausted = true;
  let best: { g: number; index: number } | null = null;
  // 上界种子：index = -1 表示「这个界来自外部解，本搜索内没有对应路径」。
  // 若搜索结束时 index 仍是 -1，说明没有任何严格更小的解 —— 上界即最小值。
  if (opts.upperBound != null) {
    best = { g: opts.upperBound, index: -1 };
  }

  while (open.size > 0) {
    const current = open.pop()!;
    const node = nodes[current.index];
    if (node.state === null) continue; // 已展开过的壳（f 相同的重复入堆条目）

    // branch-and-bound：已找到解且这条路径不可能更优（用未加权 h 保持可采纳剪枝口径）
    if (best && node.g + h(node.state!) >= best.g) continue;
    if (best && node.g >= best.g) continue;

    if (node.state.outcome === "WIN") {
      if (!best || node.g < best.g) best = { g: node.g, index: current.index };
      continue;
    }
    if (node.state.outcome === "LOSE") continue;

    const st = node.state;
    node.state = null; // 立即释放：展开只用这一份
    for (const action of legalActions(st)) {
      // 支配剪枝：对未检测的 MIRROR 患者处置 = 100% 误诊判负（Contract §5.3），
      // 整条分支当场结束。这不是「更差的一条路」，是**不可能赢**的一条路，
      // 所以直接不展开 —— 剪掉它不损失任何最优解。
      // 玩家侧动作保持合法（这是教学点：撞一次，然后看结算页上的真实病例），
      // 只是求解器不去搜它。
      const target = action.type === "STABILIZE" ? st.patients[action.patientId] : undefined;
      if (
        target &&
        target.axisIntervention === "MIRROR" &&
        !target.revealed.includes("riskProfile")
      ) {
        continue;
      }
      // 支配剪枝：对干净的手洗手是纯浪费（Contract §6A.1）
      if (action.type === "HAND_HYGIENE" && st.handState === "CLEAN") {
        continue;
      }
      const { state: next, accepted } = reduce(st, action);
      if (!accepted) continue;

      const trimmed = trim(next);
      const key = hashState(trimmed);
      // 【关键】代价是 AP，不是动作数
      const g = node.g + actionCost(st, action);

      const known = bestG.get(key);
      if (known !== undefined && known <= g) continue;
      bestG.set(key, g);

      // 关键剪枝：h 是下界，连下界都超出总 AP 说明这条分支不可能赢
      // （口径用未加权 h；排序用加权 f —— 加权只影响弹出顺序，不参与可行性剪枝）
      const hRaw = h(trimmed);
      if (g + hRaw > totalAP) continue;
      const f = g + hRaw * weight;
      // branch-and-bound：已找到解且这条路径不可能更优
      if (best && g + hRaw >= best.g) continue;

      const index = nodes.length;
      nodes.push({ state: trimmed, parent: current.index, action, g });
      open.push({ index, f });
      nodesExplored += 1;

      if (nodesExplored >= maxNodes) {
        exhausted = false;
        break;
      }
    }
    if (!exhausted) break;
  }

  if (best) {
    return {
      levelId: level.id,
      solvable: true,
      minAP: best.g,
      path: best.index >= 0 ? reconstruct(nodes, best.index) : null,
      slack: totalAP - best.g,
      totalAP,
      nodesExplored,
      exhausted,
    };
  }

  return {
    levelId: level.id,
    solvable: false,
    minAP: null,
    path: null,
    slack: null,
    totalAP,
    nodesExplored,
    exhausted,
  };
}

export type BudgetScanRow = {
  turns: number;
  actionPoints: number;
  requiredDischarges: number | "ALL";
  maxDeaths: number;
  totalAP: number;
  solvable: boolean;
  minAP: number | null;
  slack: number | null;
  nodesExplored: number;
  exhausted: boolean;
};

export type ScanOptions = SolveOptions & {
  turns?: number[];
  actionPoints?: number[];
  requiredDischarges?: (number | "ALL")[];
  maxDeaths?: number[];
};

/**
 * 扫描参数空间，输出「哪个配置刚好可解」。
 * 用于回答：这一关到底该给几个回合、几只手、要求送走几人。
 */
export function scanBudget(level: LevelDef, opts: ScanOptions = {}): BudgetScanRow[] {
  const turnsList = opts.turns ?? [level.turns];
  const apList = opts.actionPoints ?? [level.actionPoints];
  const reqList = opts.requiredDischarges ?? [level.rules.requiredDischarges];
  const deathList = opts.maxDeaths ?? [level.rules.maxDeaths];

  const rows: BudgetScanRow[] = [];
  for (const turns of turnsList) {
    for (const actionPoints of apList) {
      for (const requiredDischarges of reqList) {
        for (const maxDeaths of deathList) {
          const variant: LevelDef = {
            ...level,
            turns,
            actionPoints,
            rules: { ...level.rules, requiredDischarges, maxDeaths },
          };
          const r = solve(variant, opts);
          rows.push({
            turns,
            actionPoints,
            requiredDischarges,
            maxDeaths,
            totalAP: r.totalAP,
            solvable: r.solvable,
            minAP: r.minAP,
            slack: r.slack,
            nodesExplored: r.nodesExplored,
            exhausted: r.exhausted,
          });
        }
      }
    }
  }
  return rows;
}

/** 把动作序列渲染成可读步骤，便于人工核对与写进 GDD */
export function formatPath(path: PlayerAction[]): string[] {
  return path.map((a, i) => {
    const n = String(i + 1).padStart(2, "0");
    switch (a.type) {
      case "ADMIT":
        return `${n}. 收治 → ${a.bedId} 号床`;
      case "SCAN":
        return `${n}. 检查 ${a.patientId}`;
      case "STABILIZE":
        return `${n}. 治疗 ${a.patientId}`;
      case "ISOLATE":
        return `${n}. 隔离 ${a.patientId}`;
      case "HAND_HYGIENE":
        return `${n}. 洗手`;
      case "SKIP_HAND":
        return `${n}. 跳过一手`;
    }
  });
}
