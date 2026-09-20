/**
 * 类型定义 —— 权威规格见 `spec/SIMULATION_CONTRACT.md`（v2）。
 *
 * 本文件是 Contract 的机器化表达。改动前先改 Contract，再改 `tests/contract.test.ts`。
 */

export type ActionType = "ADMIT" | "SCAN" | "STABILIZE" | "ISOLATE" | "HAND_HYGIENE";

/** 边的规范键：两端床号升序，`"3-7"`。无向图的唯一表示。 */
export type EdgeKey = string;

export type Transmission = "NONE" | "LOW" | "HIGH";
export type Outcome = "ONGOING" | "WIN" | "LOSE";
export type HiddenKey = "riskProfile" | "transmission" | "disposition";

/**
 * 干预轴。取代旧的 `requiresScanBeforeStabilize: boolean`。
 * 三档构成连续惩罚曲线：浪费（DIRECT 去检查）→ 无效（SCAN_FIRST 不检查）→ 致命（MIRROR 赌错）。
 */
export type AxisIntervention = "DIRECT" | "SCAN_FIRST" | "MIRROR";

/** 镜像分支。标记这个患者「真正」患的是哪一面，供检测后自动执行正确方案。 */
export type MirrorBranch = "A" | "B";

export type PlayerAction =
  | { type: "ADMIT"; bedId: number }
  | { type: "SCAN"; patientId: string }
  | { type: "STABILIZE"; patientId: string }
  | { type: "ISOLATE"; patientId: string }
  | { type: "HAND_HYGIENE" }
  /** 跳过一手：这只手不用了，什么都不做。手用光才进入下一回合（结算时机不变）。 */
  | { type: "SKIP_HAND" };

/** 手的状态（Contract §6A.1）。处置/检测 HIGH 患者后污染，污染手上动手会传给下一个人。 */
export type HandState = "CLEAN" | "CONTAMINATED";

export type VitalReading = {
  label: string;
  value: string;
  flag?: "high" | "low" | "critical";
};

export type Patient = {
  id: string;
  archetype: string;
  /** 患者原话：第一人称、口语、含时间/进行性措辞。禁止病名。 */
  utterance: string;
  /** 紧凑短标签，供日志与窄 UI 使用。 */
  chiefComplaint: string;
  vitals: VitalReading[];
  /** 关键鉴别线索。教学关显示，后期关可隐藏。 */
  keyClue: string;
  /** 检查后揭示的客观数据（不是病名），玩家据此推理选方案。 */
  scanResult: string;
  acuity: number;
  deteriorationRate: number;
  transmission: Transmission;
  axisIntervention: AxisIntervention;
  mirrorBranch: MirrorBranch | null;
  /** 检测后自动执行的方案名。MIRROR 必填，仅供展示 —— 选择由检测结果决定，不是玩家。 */
  planA: string;
  planB: string;
  revealOrder: HiddenKey[];
  revealed: HiddenKey[];
  hidden: Record<string, string>;
  bedId: number | null;
  /**
   * 这个人**曾经**待过的床位（离开床位也不清空）。
   *
   * 存在的唯一理由：界面上指代一个病人只能用「4 号床」这种玩家看得见的位置，
   * 而 `bedId` 在出院 / 死亡时会被清空（reducer 的 autoDischarge / reapDead）。
   * 没有它，失败复盘想点名一个已经死掉的人，就只能回退到内部编号 N01 ——
   * 那正是用户点名要删掉的东西（「那一堆 N01、s01、t01，这什么鬼？」）。
   */
  homeBed: number | null;
  exposure: number;
  /** 已发生的暴露升级次数。每 floor(exposure/2) 升一级。 */
  escalations: number;
  /**
   * 本回合被暴露升级过。
   * 用途：Contract §6 规定「一次暴露升级 = 一档 acuity，不多不少」。
   * 若升级与自然病程在同回合叠加，acuity 1 的患者一次暴露就会 1→3 直接死亡，
   * 传播从「持续租金」变成「一碰即死」，四个设计杠杆全部失效。
   */
  escalatedThisTurn: boolean;
  deteriorationClock: number;
  stabilizedThisTurn: boolean;
  /** 时间窗（Contract §6A.4）。缺省 0 = 无窗口。 */
  timeWindow?: number;
  /** 入床时 = timeWindow，每回合末 -1；归零触发 WINDOW_CLOSED。0 = 无窗口/已走。 */
  windowClock: number;
  /** 错过时间窗：遗留损伤。仍会离床，但计入 sequelaCount。 */
  sequela: boolean;
  /** 谵妄（Contract §6A.3）：在床时，相邻床患者的处置 +1 手。 */
  disruptive: boolean;
  missedStabilizationWindow: number;
  /**
   * 观察中（Contract §2.2）。acuity 已归零但还没走 —— 人还占着床、还在邻接图上、源还在传。
   * 被暴露抬升则作废（回到未观察态），必须重新治到 0 并重新计时。
   */
  observing: boolean;
  /** 观察期剩余回合数。>0 时不到点不出院。`observationTurns=0` 时恒为 0。 */
  observationClock: number;
  alive: boolean;
  discharged: boolean;
};

export type GameState = {
  nightId: string;
  title: string;
  turn: number;
  maxTurns: number;
  actionPointsPerTurn: number;
  ap: number;
  enabledActions: ActionType[];
  infectionEnabled: boolean;
  corridorGraceTurns: number;
  /**
   * 当前已封闭的边（挂帘的帘位），升序。**这是传染与隔离的唯一状态。**
   *
   * 2026-09-18 裁定（两次迭代后的最终形态）：**帘子 = 隔离本身**。
   * 全场同时最多只有一个人被隔离（见 isolatedBedId），围上谁，帘就整体搬到谁那边；
   * 开局没有任何帘，布景帘已废除。「谁的邻床会传给他」= 这张床的边里**还有几条没挂帘**。
   */
  curtains: EdgeKey[];
  /**
   * 当前被隔离的那张床（全场唯一），null = 无人被隔离。
   *
   * 这是「围上谁」的可读写形态：ISOLATE 一个新人前，先撤走这一床的全部帘。
   * 开局若关卡布局恰好封死了一整张床（如 night-03/05 的 6 号床），这里就是那床 ——
   * 玩家围别人时，它同样会被解除。隔离不挂在人身上，挂在床上。
   */
  isolatedBedId: number | null;
  /**
   * 隔离的 AP 成本。默认 **1** —— 一枚动作、一只手，不是一整个回合。
   *
   * 隔离是**纯支出、不治病**：患者留在床上继续按病程恶化，且仍占着邻接图与床位。
   * 2026-09-18 裁定：围住一床不牵连别处，帘子没有资源属性。
   */
  isolateCost: number;
  /**
   * **急救档**：acuity ≥ 2 → 降一档 的 AP 成本。默认 1。见 Contract §4.1。
   *
   * 把病人从死亡线上压回来是便宜的一手 —— 但压住不等于治好。
   */
  emergencyCost: number;
  /**
   * **治愈档**：acuity 1 → 0（真正送出病房）的 AP 成本。默认 **2**。见 Contract §4.1。
   *
   * 「压住便宜、治好昂贵」是隔离能在价格上站住的**唯一来源**：
   * 清一个黄档传染源要 2 手，而隔离只要 1 手 —— 当别处还有病危的人在抢手时，
   * 隔离的那 1 手才是买得到的。
   */
  curativeCost: number;
  /**
   * 观察期长度（Contract §2.2）。默认 **0 = 关闭**（acuity 归零当帧出院，即 v3 旧行为）。
   *
   * 开启后「治好 ≠ 走了」：治到 0 的人还占着床、还被暴露、源还继续传 N 个回合。
   * **这是「隔离是否划算」的开关** —— 源的剩余寿命由它决定，而隔离买的就是时间。
   */
  observationTurns: number;
  maxDeaths: number;
  /** 出院目标。"ALL" = 全部患者都必须出院（含尚未到达者）。 */
  requiredDischarges: number | "ALL";
  /** 本关患者总数（含尚未到达者）。供 "ALL" 目标使用，静态不变。 */
  totalPatients: number;
  beds: Record<number, string | null>;
  /** 床单元污染（Contract §6A.2）：源离床留下，入住沾染，每回合末衰减。bedUnitEnabled=false 时恒 0。 */
  bedRisk: Record<number, number>;
  handState: HandState;
  handHygieneEnabled: boolean;
  bedUnitEnabled: boolean;
  /** 走廊容量。null = 无限（Contract §6A.5）。 */
  queueLimit: number | null;
  /** 错过时间窗的人数。sequelaLimit 存在且被超过 → 判负。 */
  sequelaCount: number;
  sequelaLimit: number | null;
  patients: Record<string, Patient>;
  queue: string[];
  deaths: number;
  infectionEvents: number;
  outcome: Outcome;
  history: HistoryEntry[];
  arrivalSchedule: PatientDef[][];
};

export type HistoryEntry = {
  turn: number;
  action: PlayerAction;
  accepted: boolean;
  events: string[];
};

export type ReduceResult = {
  state: GameState;
  accepted: boolean;
  events: string[];
};

export type PatientDef = {
  id: string;
  archetype: string;
  visible: {
    chiefComplaint: string;
    /** 患者原话。缺省退回 chiefComplaint。 */
    utterance?: string;
    acuity: number;
    vitals?: VitalReading[];
    keyClue?: string;
  };
  rules: {
    deteriorationRate: number;
    transmission: Transmission;
    axisIntervention: AxisIntervention;
    mirrorBranch?: MirrorBranch;
    scanResult?: string;
    planA?: string;
    planB?: string;
    timeWindow?: number;
    disruptive?: boolean;
  };
  hidden: Record<string, string>;
  revealOrder: HiddenKey[];
  state?: { bedId?: number };
};

export type LevelDef = {
  id: string;
  title: string;
  turns: number;
  actionPoints: number;
  enabledActions: ActionType[];
  rules: {
    infectionEnabled: boolean;
    corridorGraceTurns?: number;
    /** 隔离的 AP 成本，默认 1。见 GameState.isolateCost。 */
    isolateCost?: number;
    /** 急救档 AP 成本，默认 1。见 GameState.emergencyCost / Contract §4.1。 */
    emergencyCost?: number;
    /** 治愈档 AP 成本，默认 2。见 GameState.curativeCost / Contract §4.1。 */
    curativeCost?: number;
    /** 观察期长度，默认 0（关闭）。见 GameState.observationTurns / Contract §2.2。 */
    observationTurns?: number;
    /** 手卫生（Contract §6A.1）。缺省 false —— Night 04「看不见的手」首次开启。 */
    handHygieneEnabled?: boolean;
    /** 床单元污染（Contract §6A.2）。缺省 false —— Night 04 首次开启。 */
    bedUnitEnabled?: boolean;
    /** 走廊容量（Contract §6A.5）。缺省无限。超员的回合末，走廊患者集体额外恶化一档。 */
    queueLimit?: number;
    /** 后遗症上限（Contract §6A.4）。缺省不设限；超出即判负。 */
    sequelaLimit?: number;
    maxDeaths: number;
    /** 出院目标。"ALL" = 全部患者都必须出院（含尚未到达者）。 */
    requiredDischarges: number | "ALL";
  };
  initialPatients: PatientDef[];
  arrivalSchedule: PatientDef[][];
};
