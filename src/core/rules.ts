import type {
  EdgeKey,
  GameState,
  HiddenKey,
  Patient,
  PlayerAction,
} from "./types";

export const BED_IDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/**
 * Contract §1。2×4 病房的满邻接 —— 两排四床，中间一条通道。
 *
 *   1 — 2 — 3 — 4
 *   |   |   |   |
 *   5 — 6 — 7 — 8
 *
 * 10 条边：行内 6 条（上排 3 + 下排 3）+ 跨越通道 4 条。
 * 这是唯一邻接定义，UI 与传播都从这里取。
 */
const ADJACENCY: Record<number, number[]> = {
  1: [2, 5],
  2: [1, 3, 6],
  3: [2, 4, 7],
  4: [3, 8],
  5: [1, 6],
  6: [2, 5, 7],
  7: [3, 6, 8],
  8: [4, 7],
};

/** Contract §6.2：暴露每跨过 2 的倍数升一级。 */
export const ESCALATION_STEP = 2;

/**
 * 观察作废。**任何把 acuity 抬离 0 的事件都必须调用它** ——
 * 否则患者会带着「观察中」的标记被抬到 acuity 2，倒计时继续走，直接白送出院。
 * （原为 reducer 私有；2026-09-18 脏手加重让 actions 的接触结算也会抬 acuity，遂上移共享。）
 */
export function breakObservation(p: Patient, events: string[]): void {
  if (!p.observing) return;
  p.observing = false;
  p.observationClock = 0;
  events.push(`OBSERVATION_BROKEN:${p.id}`);
}

/** 边的规范键。无向图的唯一表示，`edgeKey(7, 3) === "3-7"`。 */
export function edgeKey(a: number, b: number): EdgeKey {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function neighbors(bedId: number): number[] {
  return ADJACENCY[bedId] ?? [];
}

/** 全部边（无向、去重），供 UI 画连线、传播结算与一致性测试使用。 */
export function allEdges(): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const a of BED_IDS) {
    for (const b of ADJACENCY[a]) {
      const k = edgeKey(a, b);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a < b ? [a, b] : [b, a]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 帘位（2026-09-18 最终裁定：帘子 = 隔离本身。全场最多一床隔离帘，
// 围新人 = 帘整体搬到新人那边；开局没有任何帘。）
// ---------------------------------------------------------------------------

/** 一张床的全部边（它的「暴露面」）。 */
export function edgesOfBed(bedId: number): EdgeKey[] {
  return neighbors(bedId)
    .map((b) => edgeKey(bedId, b))
    .sort();
}

/** 该帘位是否已挂帘（= 这条边被封闭，不再传播）。 */
export function isScreened(state: GameState, edge: EdgeKey): boolean {
  return state.curtains.includes(edge);
}

/** 一张床上还有几条没挂帘的边 —— 即「还有几条路能传进来/传出去」。 */
export function openEdgesOfBed(state: GameState, bedId: number): EdgeKey[] {
  return edgesOfBed(bedId).filter((e) => !isScreened(state, e));
}

/**
 * 一张床是否已被完全隔离。
 *
 * **这是推导量，不是存储量。** 隔离不是一个人身上的标志，而是「这张床的每一条边都挂了帘」。
 * 部分封帘（3 条边里封了 2 条）是合法状态（开局布局可以只封一部分），且真的少传一路。
 */
export function isBedIsolated(state: GameState, bedId: number): boolean {
  const edges = edgesOfBed(bedId);
  return edges.length > 0 && edges.every((e) => isScreened(state, e));
}

export function isStable(patient: Patient): boolean {
  return patient.acuity === 0 && patient.alive && !patient.discharged;
}

/**
 * Contract §2.1：出院**只看 acuity**。
 * v1 的 `ISOLATED_AND_STABLE`（必须隔离才能出院）已废除——隔离不是出院的门票。
 * 这条是「没有必做项」的机器化表达：玩家永远不必为了出院而隔离。
 */
export function canDischarge(patient: Patient): boolean {
  return isStable(patient) && patient.bedId != null;
}

export function patientOnBed(
  state: GameState,
  patientId: string,
): Patient | null {
  const p = state.patients[patientId];
  if (!p || !p.alive || p.discharged || p.bedId == null) return null;
  return p;
}

export function nextRevealKey(patient: Patient): HiddenKey | undefined {
  return patient.revealOrder.find((k) => !patient.revealed.includes(k));
}

export function dischargedCount(state: GameState): number {
  return Object.values(state.patients).filter((p) => p.discharged).length;
}

/**
 * 动作的 AP 成本。Contract §4。
 *
 * 隔离消耗 `isolateCost`（默认 1，一只手）。
 * 治疗按档定价（见 `stabilizeCost`），其余动作 1 AP。
 * v1 的 Solver 把所有动作都算成 1 AP，凡解法含隔离，最小 AP 与余量全错。
 *
 * 注意：隔离的 AP 价格是**常数**（默认 1，一只手）。它的真实代价是**纯支出**：
 * 围住不产出任何治疗收益，患者留在床上继续恶化，占着邻接图和床位。
 */
export function actionCost(state: GameState, action: PlayerAction): number {
  switch (action.type) {
    case "ISOLATE":
      return state.isolateCost;
    case "STABILIZE": {
      const p = state.patients[action.patientId];
      return p ? stabilizeCost(state, p) : 1;
    }
    default:
      return 1;
  }
}

/**
 * Contract §4.1 —— 治疗的分档定价。**这是全场唯一的价格来源**：
 * `actions.ts → stabilize()` 的扣费、`Ward.ts` 的按钮说明、`forecast.ts` 的
 * 代价预览都必须调它，谁也不许自己再写一遍价格。
 *
 * 「把病人压住」与「把病人治好」是两件事、两个价钱：
 *
 * | 档位 | 动作 | 成本 |
 * |---|---|---|
 * | 急救 | acuity ≥ 2 → 降一档（病危 → 黄） | `emergencyCost`（默认 1） |
 * | 治愈 | acuity 1 → 0（黄 → 出院） | `curativeCost`（默认 2） |
 *
 * **只有两档。** v2 曾有第三档「补救」（误治拉回，`remedyCost`），2026-09-17 随
 * Contract §5.3 改成「误诊即刻判负」一并删除 —— 没有不可逆通道，就没有补救。
 *
 * 两个档位都要再加谵妄附加费（Contract §6A.3 要求「actionCost 与 legalActions
 * 同步生效」，没有豁免档位）。
 *
 * **为什么必须分档**：若每档恒为 1 AP，「清掉一个传染源」的最低价就等于他的 acuity ——
 * 一个黄档源 1 手就能清干净，比隔离还便宜。清人于是结构性地压倒隔离，
 * 无论怎么配平都救不回来（`tools/iso-value.ts` 在分档前实测 Δ=0）。
 *
 * 分档之后，清一个黄档源要 2 手、一个病危档源要 3 手，而**一回合只有 3 手** ——
 * 「治不起，但挡得起」第一次成为真实处境：隔离的那 1 手就是腾出来的。
 */
export function stabilizeCost(state: GameState, p: Patient): number {
  const cost = p.acuity <= 1 ? state.curativeCost : state.emergencyCost;
  // 谵妄干扰（Contract §6A.3）：相邻床坐着谵妄患者，这一手要多安抚一次。
  return cost + deliriumSurcharge(state, p);
}

/** 谵妄附加费：目标患者的相邻床上有在床的谵妄患者 → +1。 */
export function deliriumSurcharge(state: GameState, p: Patient): number {
  return deliriumNeighbor(state, p) ? 1 : 0;
}

/**
 * 让这次治疗多花一只手的那个人是谁（相邻床上神志不清的患者）。
 *
 * 单独抽出来是因为**失败结算要能点名到人**：多花的那只手是「他」造成的，
 * 复盘与贴士该指的是他，不是被治疗的那个无辜病人（`docs/SOLUTIONS.md §3` E11）。
 */
export function deliriumNeighbor(state: GameState, p: Patient): Patient | null {
  if (p.bedId == null) return null;
  for (const edge of edgesOfBed(p.bedId)) {
    const [a, b] = edge.split("-").map(Number);
    const other = a === p.bedId ? b : a;
    const id = state.beds[other];
    if (!id) continue;
    const neighbor = state.patients[id];
    if (neighbor && neighbor.alive && !neighbor.discharged && neighbor.disruptive) {
      return neighbor;
    }
  }
  return null;
}

/**
 * 走廊里真正**可以入床**的下一个人。
 *
 * 正常情况就是 `queue[0]`；但队列里若混进了已出院 / 已死亡 / 已在床的幽灵条目
 * （历史存档，或将来某条路径忘了清理），ADMIT 会把这些条目当成「人」放到床上，
 * 制造出一个占着床却永远不会出现在病房里的幽灵 —— 那张床从此谁也住不进。
 * 这里把「谁可入床」收成一个判据，`legalActions` 与 `admit` 共用同一个口径。
 */
export function nextAdmittable(state: GameState): string | undefined {
  for (const id of state.queue) {
    const p = state.patients[id];
    if (p && p.alive && !p.discharged && p.bedId == null) return id;
  }
  return undefined;
}

export function legalActions(state: GameState): PlayerAction[] {
  if (state.outcome !== "ONGOING") return [];
  const actions: PlayerAction[] = [];
  const enabled = new Set(state.enabledActions);

  if (enabled.has("ADMIT") && nextAdmittable(state) != null) {
    for (const bedId of BED_IDS) {
      if (state.beds[bedId] == null) actions.push({ type: "ADMIT", bedId });
    }
  }

  for (const p of Object.values(state.patients)) {
    if (!p.alive || p.discharged || p.bedId == null) continue;

    if (enabled.has("STABILIZE")) {
      // 已经稳定（acuity 0）的人没有可处置的东西。
      //
      // 这不只是体验问题：本作**没有「过回合」动作**，回合只在 ap 归零或 legalActions 为空时才结算。
      // 若把 acuity 0 当成合法的处置目标，玩家（和求解器）就被迫用一次无意义操作把 AP 烧掉才能推进回合，
      // 于是 `minAP` 里混进了纯浪费，把「隔离省下的 AP」抹平 —— Δ 会假性归零。
      // 观察期的患者正好长期停在 0，这个瑕疵在那里第一次咬人，所以在此一并修掉。
      if (p.acuity > 0) {
        // 分档定价（Contract §4.1）：急救 1 手、治愈 2 手（`stabilizeCost`）。
        // AP 不够就不该出现在选项里 —— 否则求解器会挑一个注定失败的动作把余下的 AP 烧掉。
        const cost = stabilizeCost(state, p);
        if (state.ap >= cost) {
          actions.push({ type: "STABILIZE", patientId: p.id });
        }
      }
    }

    if (enabled.has("SCAN") && nextRevealKey(p) && state.ap >= 1) {
      actions.push({ type: "SCAN", patientId: p.id });
    }

    // 已经围严实的床不该再出现「隔离」——那是一手纯粹的空动作
    if (
      enabled.has("ISOLATE") &&
      state.ap >= state.isolateCost &&
      !isBedIsolated(state, p.bedId)
    ) {
      actions.push({ type: "ISOLATE", patientId: p.id });
    }
  }

  if (enabled.has("HAND_HYGIENE") && state.ap >= 1) {
    // 洗干净的手是合法的纯浪费（没有必做项的反面：没有必禁项）——求解器负责不去搜它
    actions.push({ type: "HAND_HYGIENE" });
  }
  return actions;
}

/**
 * Contract §6.1：谁有可能向外传播。
 *
 * **不再检查 `isolated` 标志**——隔离已经变成边上的帘。
 * 一个患者是否在传、传给谁，由「他的床还有几条边没挂帘」决定。
 * 完全围严的床自然一条开放边都没有，于是传不出去。
 */
export function isTransmitting(p: Patient): boolean {
  return p.alive && !p.discharged && p.bedId != null && p.transmission !== "NONE";
}

/**
 * 每回合末的暴露剂量。HIGH = LOW = 2（2026-09-18 用户裁决：LOW「两回合才传染」
 * 的宽限过松 —— 现在一回合不隔离就传染，与 HIGH 同档；HIGH 的独有威胁保留在
 * 接触污染：动 HIGH 源必脏手）。步长仍为 ESCALATION_STEP = 2，
 * 因此每个回合末至多升一级，不会一回合跳两级。
 */
export function exposureDose(_p: Patient): number {
  return 2;
}
