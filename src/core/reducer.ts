import { applyAction } from "./actions";
import { killPatient } from "./death";
import { applyArrival, cloneState } from "./state";
import {
  allEdges,
  breakObservation,
  dischargedCount,
  edgeKey,
  ESCALATION_STEP,
  exposureDose,
  isScreened,
  isTransmitting,
  legalActions,
} from "./rules";
import type { GameState, Patient, PlayerAction, ReduceResult } from "./types";

export function reduce(state: GameState, action: PlayerAction): ReduceResult {
  if (state.outcome !== "ONGOING") {
    return { state, accepted: false, events: ["GAME_OVER"] };
  }

  const next = cloneState(state);
  const events: string[] = [];

  // 跳过一手不挂在 enabledActions 上（solver 的动作空间保持不变），
  // 只要求 ap > 0 —— applyAction 里的 skipHand 负责合法性。
  if (action.type !== "SKIP_HAND" && !next.enabledActions.includes(action.type)) {
    events.push("REJECTED_DISABLED");
    next.history.push({ turn: next.turn, action, accepted: false, events: [...events] });
    return { state: next, accepted: false, events };
  }

  const accepted = applyAction(next, action, events);
  if (!accepted) events.unshift("REJECTED_ILLEGAL");
  const actionTurn = next.turn;
  next.history.push({ turn: actionTurn, action, accepted, events: [...events] });

  if (accepted) {
    autoDischarge(next, events);
    checkWin(next, events);
    if (
      // `next.outcome !== "LOSE"` 这一句是为了**不重复打 LOSE 事件**：
      // 误诊（Contract §5.3）在 `applyAction` 当帧就已经判负并 push 过 LOSE 了，
      // 而它同时也会让 deaths 超限 —— 没有这个判断，事件流里会出现两次 LOSE，
      // 贴士与复盘会把同一件事说成两件。
      // 保持「WIN 仍可被超限翻成 LOSE」的旧行为不变（只挡 LOSE→LOSE）。
      next.outcome !== "LOSE" &&
      (next.deaths > next.maxDeaths ||
        (next.sequelaLimit != null && next.sequelaCount > next.sequelaLimit))
    ) {
      next.outcome = "LOSE";
      events.push("LOSE");
    }
    if (next.outcome === "ONGOING" && (next.ap === 0 || legalActions(next).length === 0)) {
      resolvePhase(next, events);
    }
    next.history[next.history.length - 1].events = [...events];
  }

  return { state: next, accepted, events };
}

/** 出院目标数。"ALL" = 全部患者（含尚未到达者）都必须出院。 */
export function targetDischarges(state: GameState): number {
  return state.requiredDischarges === "ALL"
    ? state.totalPatients
    : state.requiredDischarges;
}

/**
 * 出院结算（Contract §2.1 / §2.2）。
 *
 * `observationTurns === 0`（缺省）：acuity 归零即可离床 —— 这是 v3 的行为，逐位不变。
 * `observationTurns > 0`：**治好 ≠ 走了**。治到 0 只是进入观察期，
 * 人还占着床、还在邻接图上、源还继续传 —— 真正的离床由 `tickObservation` 在回合末执行。
 *
 * 为什么要分成两处：观察期必须跨过至少一次 TRANSMISSION 才有意义。
 * 若仍然在这里当帧出院，患者会在回合末传播结算之前离场，机制等于没做。
 */
export function autoDischarge(state: GameState, events: string[]): void {
  for (const p of Object.values(state.patients)) {
    if (p.bedId == null) continue;
    if (!(p.alive && p.acuity === 0 && !p.discharged)) continue;

    if (state.observationTurns > 0) {
      if (!p.observing) {
        p.observing = true;
        p.observationClock = state.observationTurns;
        events.push(`OBSERVING:${p.id}:${p.observationClock}`);
      }
      continue;
    }

    dischargePatient(state, p, events);
  }
}

function dischargePatient(state: GameState, p: Patient, events: string[]): void {
  if (p.bedId == null) return;
  const bed = p.bedId;
  state.beds[bed] = null;
  p.bedId = null;
  p.discharged = true;
  p.observing = false;
  p.observationClock = 0;
  // 床单元污染（Contract §6A.2）：源走了，床记着他
  if (state.bedUnitEnabled) {
    const risk = p.transmission === "HIGH" ? 2 : p.transmission === "LOW" ? 1 : 0;
    if (risk > 0) {
      state.bedRisk[bed] = Math.max(state.bedRisk[bed] ?? 0, risk);
      events.push(`BED_CONTAMINATED:${bed}:risk${risk}`);
    }
  }
  events.push(`DISCHARGED:${p.id}:AUTO`);
}

/**
 * 观察期倒计时（Contract §2.2）。**只在回合末结算一次**，不是每按一次按钮减一。
 *
 * 调用位置必须在 TRANSMISSION 之后 —— 「观察期里吃到暴露，于是白观察了」正是这条机制的全部意义。
 * 顺序反了，观察期就退化成「白送一回合」，机制再次变成装饰。
 */
function tickObservation(state: GameState, events: string[]): void {
  if (state.observationTurns <= 0) return;
  for (const p of Object.values(state.patients)) {
    if (!p.alive || p.discharged || p.bedId == null) continue;
    if (p.acuity > 0) {
      breakObservation(p, events);
      continue;
    }
    if (!p.observing) continue;

    p.observationClock -= 1;
    if (p.observationClock > 0) {
      events.push(`OBSERVING_TICK:${p.id}:${p.observationClock}`);
      continue;
    }
    events.push(`OBSERVED:${p.id}`);
    dischargePatient(state, p, events);
  }
}

/**
 * 观察作废 —— 已上移至 rules.ts（actions 的接触结算同样会抬 acuity）。
 */

function checkWin(state: GameState, events: string[]): void {
  // 感染不判负（2026-09-18 用户裁决）：判负只看死亡、后遗症与出院进度。
  // 传染的代价走它自己的经济 —— 被传上的人要多花手才能救，这就是时间压力。
  if (
    dischargedCount(state) >= targetDischarges(state) &&
    state.deaths <= state.maxDeaths &&
    (state.sequelaLimit == null || state.sequelaCount <= state.sequelaLimit)
  ) {
    state.outcome = "WIN";
    events.push("WIN");
  }
}

/** 时间窗倒计时（Contract §6A.4）。窗口归零 = 遗留后遗症 + 当回合末自动离床。 */
function tickWindows(state: GameState, events: string[]): void {
  for (const p of Object.values(state.patients)) {
    if (!p.alive || p.discharged || p.bedId == null) continue;
    if (!p.timeWindow || p.sequela || p.windowClock <= 0) continue;
    p.windowClock -= 1;
    if (p.windowClock > 0) {
      events.push(`WINDOW_TICK:${p.id}:${p.windowClock}`);
      continue;
    }
    p.sequela = true;
    state.sequelaCount += 1;
    events.push(`WINDOW_CLOSED:${p.id}`);
    dischargePatient(state, p, events);
  }
}

function resolvePhase(state: GameState, events: string[]): void {
  if (state.infectionEnabled) transmit(state, events);
  deteriorate(state, events);
  reapDead(state, events);

  // 时间窗倒计时：在恶化/死亡之后、判负检查之前 —— 后遗症突破上限必须当场判负
  tickWindows(state, events);

  // 感染不判负（2026-09-18 用户裁决）：传染次数只是统计，不是失败条件。
  if (
    state.deaths > state.maxDeaths ||
    (state.sequelaLimit != null && state.sequelaCount > state.sequelaLimit)
  ) {
    state.outcome = "LOSE";
    events.push("LOSE");
    return;
  }

  // 观察期倒计时（Contract §3 第 7 步）。必须在 transmit 之后、autoDischarge 之前。
  tickObservation(state, events);
  autoDischarge(state, events);
  checkWin(state, events);
  if (state.outcome !== "ONGOING") return;

  if (state.turn >= state.maxTurns) {
    state.outcome = "LOSE";
    events.push("TIMEOUT");
    return;
  }

  for (const p of Object.values(state.patients)) {
    p.stabilizedThisTurn = false;
    p.escalatedThisTurn = false;
  }
  // 床单元污染自然衰减（Contract §6A.2）：污渍会淡，但当晚等不到零
  if (state.bedUnitEnabled) {
    for (const bed of Object.keys(state.bedRisk)) {
      const id = Number(bed);
      state.bedRisk[id] = Math.max(0, (state.bedRisk[id] ?? 0) - 1);
      if (state.bedRisk[id] === 0) delete state.bedRisk[id];
    }
  }
  state.turn += 1;
  state.ap = state.actionPointsPerTurn;
  applyArrival(state, state.turn - 1, state.arrivalSchedule);
}

function deteriorate(state: GameState, events: string[]): void {
  // 队列压力（Contract §6A.5）：走廊超员，等的人一起遭殃（宽限烧完后才开始计）
  const pressure =
    state.queueLimit != null && state.queue.length > state.queueLimit;
  for (const p of Object.values(state.patients)) {
    if (!p.alive || p.discharged) continue;

    if (p.stabilizedThisTurn || p.escalatedThisTurn || p.acuity <= 0) continue;

    if (p.deteriorationClock > 0) {
      p.deteriorationClock -= 1;
      events.push(`DETERIORATION_DELAYED:${p.id}:${p.deteriorationClock}`);
    } else if (p.deteriorationRate > 0) {
      p.acuity += p.deteriorationRate;
      breakObservation(p, events);
      const location = p.bedId == null ? "QUEUE" : `BED${p.bedId}`;
      events.push(`DETERIORATED:${p.id}:${p.acuity}:${location}`);
    }
    if (
      pressure &&
      p.bedId == null &&
      p.deteriorationClock === 0 &&
      !p.stabilizedThisTurn
    ) {
      p.acuity += 1;
      events.push(`QUEUE_PRESSURE:${p.id}:${p.acuity}`);
    }
  }
}

function reapDead(state: GameState, events: string[]): void {
  for (const p of Object.values(state.patients)) {
    if (p.alive && !p.discharged && p.acuity >= 3) killPatient(state, p, events);
  }
}

/**
 * Contract §6 —— 传播结算。
 *
 * 两条设计决定：
 *
 * 1. 剂量同速（2026-09-18）：HIGH / LOW 每回合末都 +2 —— 一回合即达感染阈值。
 *    v1 统一 +1，导致 HIGH 传染源只要邻床能在两回合内清场就永远不会触发感染；
 *    旧版「LOW 慢性」分级被实测证伪（玩家感知不到差别，只会漏防）。
 *
 * 2. 升级是**阶梯**而不是一次性布尔：exposure 每跨过 2 的倍数就升一级，
 *    可以升多次。v1 的 `if / else if` 在 exposure 从 0 一次跳到 4 时只记第一个阈值，
 *    整条漏判——既不升级 acuity 也不计感染事件。
 *
 * 3. 传播沿**未挂帘的边**发生，双向。挂帘是唯一的阻断手段。
 *    2026-09-18 裁定：隔离谁就围上谁，围住这床不牵连别处的帘。
 */
function transmit(state: GameState, events: string[]): void {
  for (const [a, b] of allEdges()) {
    // 挂了帘的缝不传 —— 这是本作唯一的防疫物理。
    if (isScreened(state, edgeKey(a, b))) continue;

    const idA = state.beds[a];
    const idB = state.beds[b];
    if (!idA && !idB) continue;

    // 双向：A 传给 B，B 也传给 A。哪一端在传由 isTransmitting 判定。
    // 不再需要「隔离者不收不发」的特例 —— 围严的床一条开放边都没有。
    for (const [fromId, toId] of [
      [idA, idB],
      [idB, idA],
    ] as const) {
      if (!fromId || !toId) continue;
      const source = state.patients[fromId];
      const target = state.patients[toId];
      if (!isTransmitting(source)) continue;
      if (!target.alive || target.discharged) continue;
      applyExposure(state, source, target, exposureDose(source), events);
    }
  }
}

/** 累积暴露并结算阶梯升级。 */
function applyExposure(
  state: GameState,
  source: Patient,
  target: Patient,
  dose: number,
  events: string[],
): void {
  target.exposure += dose;
  events.push(`EXPOSURE:${source.id}->${target.id}:+${dose}:${target.exposure}`);

  const level = Math.floor(target.exposure / ESCALATION_STEP);
  while (target.escalations < level) {
    target.escalations += 1;
    target.acuity += 1;
    // 被暴露抬回病态：观察期作废（Contract §2.2）。源把「已经治好的人」重新拉回床上。
    breakObservation(target, events);
    // 本回合的病程变化由这次感染事件占用，不再叠加自然恶化（见 Patient.escalatedThisTurn）
    target.escalatedThisTurn = true;
    state.infectionEvents += 1;
    events.push(`EXPOSURE_ESCALATE:${target.id}:acuity${target.acuity}`);
    events.push("INFECTION_EVENT");
  }
}
