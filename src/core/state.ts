import { BED_IDS } from "./rules";
import type { EdgeKey, GameState, LevelDef, Patient, PatientDef } from "./types";

const DEFAULT_PLAN_A = "标准治疗";
const DEFAULT_PLAN_B = "反向治疗";

export function instantiatePatient(def: PatientDef, deteriorationClock = 0): Patient {
  return {
    id: def.id,
    archetype: def.archetype,
    utterance: def.visible.utterance ?? def.visible.chiefComplaint,
    chiefComplaint: def.visible.chiefComplaint,
    vitals: def.visible.vitals ?? [],
    keyClue: def.visible.keyClue ?? "",
    scanResult: def.rules.scanResult ?? "",
    acuity: def.visible.acuity,
    deteriorationRate: def.rules.deteriorationRate,
    transmission: def.rules.transmission,
    axisIntervention: def.rules.axisIntervention,
    mirrorBranch: def.rules.mirrorBranch ?? null,
    planA: def.rules.planA ?? DEFAULT_PLAN_A,
    planB: def.rules.planB ?? DEFAULT_PLAN_B,
    revealOrder: [...def.revealOrder],
    revealed: [],
    hidden: { ...def.hidden },
    bedId: def.state?.bedId ?? null,
    homeBed: def.state?.bedId ?? null,
    exposure: 0,
    escalations: 0,
    escalatedThisTurn: false,
    deteriorationClock,
    stabilizedThisTurn: false,
    timeWindow: def.rules.timeWindow,
    windowClock: def.state?.bedId != null ? (def.rules.timeWindow ?? 0) : 0,
    sequela: false,
    disruptive: def.rules.disruptive ?? false,
    missedStabilizationWindow: 0,
    observing: false,
    observationClock: 0,
    alive: true,
    discharged: false,
  };
}

export function applyArrival(state: GameState, scheduleIndex: number, schedule: PatientDef[][]): void {
  const wave = schedule[scheduleIndex];
  if (!wave) return;
  for (const def of wave) {
    if (state.patients[def.id]) continue;
    const bedId = def.state?.bedId;
    // 「到达即入床」（`state.bedId`）：直接落床，**不进走廊队列**。
    //
    // 曾经这里无条件 `queue.push`，于是带床位的到达者同时占着床和在走廊排队 ——
    // 一个人既能在床位上被处置，又能被 ADMIT 再收治一次（挪到新床，旧床留下
    // 一个幽灵占位，且该患者仍可在原床位接受处置）。night-04 的 S01 就是这种幽灵：
    // 它让求解器的最优解里凭空多出一手「收治 S01」，把 minAP 抬高了 1。
    // 床若已被占（关卡配置冲突），退化为走廊患者，不静默覆盖别人的床。
    const direct = bedId != null && state.beds[bedId] == null;
    const p = instantiatePatient(def, direct ? 0 : state.corridorGraceTurns);
    if (direct) {
      p.bedId = bedId;
      p.homeBed = bedId;
      state.beds[bedId] = p.id;
    } else {
      p.bedId = null;
      p.windowClock = 0;
      state.queue.push(p.id);
    }
    state.patients[p.id] = p;
  }
}

/**
 * 患者总数：初始在床 + 全部到达批次（按 id 去重，避免 applyArrival 跳过时重复计数）。
 */
export function countTotalPatients(level: LevelDef): number {
  const ids = new Set<string>();
  for (const def of level.initialPatients) ids.add(def.id);
  for (const wave of level.arrivalSchedule) for (const def of wave) ids.add(def.id);
  return ids.size;
}

/**
 * 状态的**快速深拷贝**。
 *
 * `reduce` 的第一步就是把入参拷一份（reducer 是纯函数，入参不可改）。
 * 原先这里用 `structuredClone` —— 它是通用的、要处理循环引用和各类宿主对象，
 * 实测 63µs/次，占了求解器 95% 的时间：一夜 02 要跑 110 万次 `reduce`，慢在这里。
 *
 * 本函数只拷 `GameState` / `Patient` 的实际形状（见 types.ts），省掉通用逻辑，
 * 实测快一个数量级，同时堆上的垃圾也少得多（内存护栏的一部分）。
 *
 * 两处**刻意的共享**（都不是妥协，是正确）：
 *  - `arrivalSchedule`：静态关卡数据，`applyArrival` 只读不写。
 *  - `history` 里的条目：条目一旦 push 就不再改（`reduce` 只改它本轮刚新建的那一条），
 *    所以数组做浅拷贝即可；`trim()` 在求解器里还会直接清空它。
 *
 * 与 `structuredClone` 等价性由 `tests/state.test.ts` 的「快速克隆 ≡ structuredClone」守着：
 * 一旦有人给 `Patient` 加了引用类型的字段却忘了在这里登记，那条测试立刻红。
 */
export function cloneState(s: GameState): GameState {
  const patients: Record<string, Patient> = {};
  for (const id in s.patients) {
    const p = s.patients[id];
    patients[id] = {
      ...p,
      vitals: p.vitals.map((v) => ({ ...v })),
      revealed: p.revealed.slice(),
      hidden: { ...p.hidden },
    };
  }
  return {
    ...s,
    enabledActions: s.enabledActions.slice(),
    curtains: s.curtains.slice(),
    beds: { ...s.beds },
    bedRisk: { ...s.bedRisk },
    patients,
    queue: s.queue.slice(),
    history: s.history.slice(),
  };
}

export function createInitialState(level: LevelDef): GameState {
  const patients: Record<string, Patient> = {};
  const beds: Record<number, string | null> = {};
  for (const id of BED_IDS) beds[id] = null;

  for (const def of level.initialPatients) {
    const p = instantiatePatient(def);
    patients[p.id] = p;
    if (p.bedId != null) beds[p.bedId] = p.id;
  }

  // 2026-09-18 最终裁定：帘子 = 隔离本身。开局没有任何帘（布景帘已废除），
  // 全场唯一的隔离位在玩家第一次 ISOLATE 之前是空的。
  const curtains: EdgeKey[] = [];

  const state: GameState = {
    nightId: level.id,
    title: level.title,
    turn: 1,
    maxTurns: level.turns,
    actionPointsPerTurn: level.actionPoints,
    ap: level.actionPoints,
    enabledActions: [...level.enabledActions],
    infectionEnabled: level.rules.infectionEnabled,
    corridorGraceTurns: level.rules.corridorGraceTurns ?? 1,
    curtains,
    isolatedBedId: null,
    isolateCost: level.rules.isolateCost ?? 1,
    emergencyCost: level.rules.emergencyCost ?? 1,
    curativeCost: level.rules.curativeCost ?? 2,
    observationTurns: level.rules.observationTurns ?? 0,
    maxDeaths: level.rules.maxDeaths,
    requiredDischarges: level.rules.requiredDischarges,
    totalPatients: countTotalPatients(level),
    beds,
    bedRisk: {},
    handState: "CLEAN" as const,
    handHygieneEnabled: level.rules.handHygieneEnabled ?? false,
    bedUnitEnabled: level.rules.bedUnitEnabled ?? false,
    queueLimit: level.rules.queueLimit ?? null,
    sequelaLimit: level.rules.sequelaLimit ?? null,
    sequelaCount: 0,
    patients,
    queue: [],
    deaths: 0,
    infectionEvents: 0,
    outcome: "ONGOING",
    history: [],
    arrivalSchedule: level.arrivalSchedule,
  };
  applyArrival(state, 0, state.arrivalSchedule);
  return state;
}
