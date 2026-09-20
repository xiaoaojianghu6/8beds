import { killPatient } from "./death";
import {
  breakObservation,
  canDischarge,
  deliriumNeighbor,
  edgesOfBed,
  ESCALATION_STEP,
  isBedIsolated,
  nextAdmittable,
  nextRevealKey,
  patientOnBed,
  stabilizeCost,
} from "./rules";
import type { GameState, Patient, PlayerAction } from "./types";

export function applyAction(
  state: GameState,
  action: PlayerAction,
  events: string[],
): boolean {
  switch (action.type) {
    case "ADMIT":
      return admit(state, action.bedId, events);
    case "STABILIZE":
      return stabilize(state, action.patientId, events);
    case "SCAN":
      return scan(state, action.patientId, events);
    case "ISOLATE":
      return isolate(state, action.patientId, events);
    case "HAND_HYGIENE":
      return handHygiene(state, events);
    case "SKIP_HAND":
      return skipHand(state, events);
  }
}

function spend(state: GameState, amount = 1): void {
  state.ap -= amount;
}

/**
 * 接触结算（Contract §6A.1）。每次「动手」（处置/检测）都走一遍：
 *   脏手 + 非 HIGH 患者 → 对方 exposure +2，并**当场**走升级结算（2026-09-18 加重：
 *   旧版 +1 只静默累积，玩家感知不到 —— 现在脏手治疗当帧就能看到病情被推重一级，
 *   洗手这 1 手从此买的是真金白银的病情）。
 *   患者是 HIGH 源 → 动完手必然脏。
 * handHygieneEnabled = false 的关卡整块跳过（手永远干净）。
 */
function touch(state: GameState, p: Patient, events: string[]): void {
  if (!state.handHygieneEnabled) return;
  if (state.handState === "CONTAMINATED" && p.transmission !== "HIGH" && p.alive && !p.discharged) {
    p.exposure += 2;
    events.push(`HAND_CONTAMINATED:${p.id}:+2:${p.exposure}`);
    const level = Math.floor(p.exposure / ESCALATION_STEP);
    while (p.escalations < level) {
      p.escalations += 1;
      p.acuity += 1;
      // 被脏手推回病态：观察期作废（Contract §2.2）
      breakObservation(p, events);
      // 占用本回合的病程变化，不再叠加自然恶化
      p.escalatedThisTurn = true;
      state.infectionEvents += 1;
      events.push(`EXPOSURE_ESCALATE:${p.id}:acuity${p.acuity}`);
      events.push("INFECTION_EVENT");
    }
  }
  if (p.transmission === "HIGH") {
    state.handState = "CONTAMINATED";
  }
}

/** 洗手：1 手，手回干净。对干净的手洗手合法但纯浪费 —— 教学点自己体会。 */
function handHygiene(state: GameState, events: string[]): boolean {
  if (!state.handHygieneEnabled) return false;
  if (state.handState === "CLEAN") {
    spend(state);
    events.push("HAND_WASHED:CLEAN");
    return true;
  }
  spend(state);
  state.handState = "CLEAN";
  events.push("HAND_WASHED:CLEAN");
  return true;
}

/**
 * 跳过一手：这只手不用了，什么都不做，白扣 1 手。
 *
 * 结算时机不变 —— 仍然只有 ap 归零（或无合法动作）才进回合末结算。
 * 它的存在意义：剩最后 1 手、想做的事都做不起时，玩家可以空过这一手，
 * 而不是被逼着花冤枉钱做一次不想要的检测。
 */
function skipHand(state: GameState, events: string[]): boolean {
  if (state.ap <= 0) return false;
  spend(state);
  events.push("SKIPPED_HAND");
  return true;
}

function admit(state: GameState, bedId: number, events: string[]): boolean {
  if (bedId < 1 || bedId > 8) return false;
  if (state.beds[bedId] != null) return false;
  // 只收治「真的能入床」的人（见 rules.nextAdmittable）——
  // 队列里的幽灵条目直接丢弃，绝不放到床上占位。
  const id = nextAdmittable(state);
  if (id == null) return false;
  state.queue = state.queue.filter((q) => q !== id);
  const p = state.patients[id];
  p.bedId = bedId;
  p.homeBed = bedId; // 出床也不清空 —— 界面点名要用「4 号床」，不是内部编号
  state.beds[bedId] = id;
  // 床单元沾染（Contract §6A.2）：住进污染床，立刻吃一次暴露；时间窗同时起算
  if (state.bedUnitEnabled) {
    const risk = state.bedRisk[bedId] ?? 0;
    if (risk > 0) {
      p.exposure += risk;
      events.push(`BED_UNIT_EXPOSURE:${id}:bed${bedId}:+${risk}:${p.exposure}`);
    }
  }
  if (p.timeWindow != null && p.windowClock === 0) p.windowClock = p.timeWindow;
  spend(state);
  events.push(`ADMITTED:${id}:bed${bedId}`);
  return true;
}

/** 处置成功：降一档，进入本回合已处置状态（不再结算病程）。 */
function treat(p: Patient, events: string[]): void {
  p.acuity = Math.max(0, p.acuity - 1);
  // Contract §4「处置当回合」：这一手按在他身上的那一回合，病程不同时收账。
  // 曾漏写此行 —— 字段被读 4 处、写 0 处，整条规则是死的（SOLUTIONS §5.1 D1）。
  p.stabilizedThisTurn = true;
  events.push(`STABILIZED:${p.id}:${p.acuity}`);
}
/**
 * Contract §5.3 —— MISDIAGNOSIS：误诊即刻判死。
 *
 * 两种病长得一模一样、治疗方向正好相反，不检测就动手 = 100% 用错药。
 * v2 曾把它做成「推进不可逆通道 → 花 2 手补救」（`REVERSE_INTERVENTION`），
 * 2026-09-17 用户拍板改成**当场判死**，理由是一条玩家行为学事实：
 *
 *   误治之后，玩家的第一选择不是继续玩，而是**重开**。既然重开是免费的、瞬间的、
 *   状态干净的，「补救」这条线在玩家的决策空间里根本不存在 —— 它只存在于求解器的
 *   动作空间里。一个玩家永远不会走的通道，留着只会让后继逻辑变复杂
 *   （要算剩下的手、要算不补救之后的事），而且把「你害死了一个人」这件本该刺眼的
 *   事，稀释成一次昂贵的抄近路。
 *
 * 判负**不依赖回合末结算**（Contract I2）：当帧就让 `outcome = LOSE`。
 * 于是这一局的最后一句永远是失败页上那条真实病例贴士
 * （`docs/level-design/08-DEATH-TIPS.md`），而不是一串抽象的状态变化。
 */
function misdiagnose(state: GameState, p: Patient, events: string[]): void {
  const branch = p.mirrorBranch ?? "?";
  // 归因事件必须**先于**死亡事件：复盘与贴士按 `history[].events` 顺次取第一条命中，
  // 顺序反了就会把死因读成「没撑住」，把玩家的错读成关卡的错。
  events.push(`MISDIAGNOSIS:${p.id}:${branch}`);
  killPatient(state, p, events);
  state.outcome = "LOSE";
  events.push("LOSE");
}

/**
 * Contract §5 —— 干预轴。取代旧的 requiresScanBeforeStabilize 布尔值。
 *
 *   DIRECT      直接处置有效；去检查才是浪费 1 AP
 *   SCAN_FIRST  未检查就处置 = 无效，浪费 1 AP，患者继续恶化
 *   MIRROR      两种病长得一模一样，不检测就动手 = **确定性失败** → 当场判死；
 *               检测（riskProfile 揭示）之后处置 = 自动执行正确方案，必然成功。
 *               玩家面对的从来不是「选哪个方案」的知识测验，而是「要不要花这一手检测」的手经济。
 */
function stabilize(state: GameState, patientId: string, events: string[]): boolean {
  const p = patientOnBed(state, patientId);
  if (!p) return false;

  // ── 定价只算一次 ──────────────────────────────────────────────
  // 扣费与报价必须走同一个 `stabilizeCost()` —— 它才是唯一的价目表。
  // 曾经这里自己写 `state.remedyCost`，而 `stabilizeCost()` 还要加谵妄附加费，
  // 于是**界面显示 3 手、实际扣 2 手**，也就是 Contract §6A.3 说的
  // 「actionCost 与 legalActions 同步生效」没做到。
  const cost = stabilizeCost(state, p);

  // 谵妄附加费（Contract §6A.3）：旁边床坐着一个神志不清的人，这一手要多花一次安抚。
  //
  // **必须发出事件，而且必须点名到那个闹的人**：不然「这一手为什么比别人贵」
  // 在 `history` 里不留痕，失败结算就无从归因，`08-DEATH-TIPS.md` 的 T8 那两条
  // 永远触发不了（`docs/SOLUTIONS.md §3` 把它列为实现缺口 E11）。
  // 事件里第二个 id 是**闹的那个人**，不是被治疗的这个 —— 贴士要指的是他。
  const rowdy = deliriumNeighbor(state, p);
  if (rowdy) events.push(`DELIRIUM_TAX:${p.id}:${rowdy.id}`);

  // 治疗必须有钱先付 —— 这也是为什么「一次无意义操作把 AP 烧掉推进回合」的漏洞要堵死：
  // 它会凭空造出 AP，把治愈档的真实价格抹平。
  if (state.ap < cost) return false;

  if (p.axisIntervention === "SCAN_FIRST" && !p.revealed.includes("riskProfile")) {
    p.missedStabilizationWindow += 1;
    touch(state, p, events);
    spend(state, cost);
    events.push(`STABILIZE_INEFFECTIVE:${p.id}:UNSCANNED:cost${cost}`);
    return true;
  }

  if (p.axisIntervention === "MIRROR" && !p.revealed.includes("riskProfile")) {
    // 不检测 = 一定错。玩家没有医学知识，「赌方向」不是技能而是出题；
    // 镜像的全部代价被折叠成一只手的保险费：检测 1 手。
    // 这一下没有「之后」—— 当场结束（Contract §5.3）。
    touch(state, p, events);
    spend(state, cost);
    misdiagnose(state, p, events);
    return true;
  }

  touch(state, p, events);
  spend(state, cost);
  treat(p, events);
  return true;
}

function scan(state: GameState, patientId: string, events: string[]): boolean {
  const p = patientOnBed(state, patientId);
  if (!p) return false;
  const key = nextRevealKey(p);
  if (!key) return false;
  touch(state, p, events);
  p.revealed.push(key);
  spend(state);
  events.push(`SCANNED:${p.id}:${key}`);
  return true;
}

/**
 * 隔离 = 把这张床的每一条边都拉上帘。
 *
 * **纯支出**：只切断传播，不产出任何治疗收益。患者留在床上继续按病程恶化。
 *
 * 2026-09-18 最终裁定：**帘子 = 隔离本身，全场唯一**。
 * 围上新人 = 旧人的帘全部撤走、整体搬到新人那边（`isolatedBedId` 是唯一的隔离位）。
 * 开局没有任何帘；没有隔离时，场上一条帘都没有。
 */
function isolate(state: GameState, patientId: string, events: string[]): boolean {
  const p = patientOnBed(state, patientId);
  if (!p) return false;
  if (state.ap < state.isolateCost) return false;
  if (isBedIsolated(state, p.bedId!)) return false;

  // 帘整体搬迁：旧床恢复敞开（CURTAIN_MOVED:负号 = 撤），新床逐条挂上。
  if (state.isolatedBedId != null) {
    for (const e of state.curtains) events.push(`CURTAIN_MOVED:-${e}`);
    events.push(`ISOLATION_CLEARED:bed${state.isolatedBedId}`);
  }

  state.curtains = edgesOfBed(p.bedId!).slice().sort();
  for (const edge of state.curtains) {
    events.push(`CURTAIN_MOVED:${edge}`);
  }
  state.isolatedBedId = p.bedId;

  spend(state, state.isolateCost);
  events.push(`ISOLATED:${p.id}:cost${state.isolateCost}`);
  return true;
}

export { canDischarge };
