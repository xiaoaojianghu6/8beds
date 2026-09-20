/**
 * 把「算得出但玩家算不出来」的信息算出来 —— 供 UI 直接显示。
 *
 * 存在的理由：这个游戏的所有决策都建立在两个倒计时上 ——
 *   ① 这个人还有几个回合会恶化 / 会死（自然病程）
 *   ② 邻床的暴露还有几点就升档（传播）
 * 玩家没法在脑子里同时维护 8 个患者的（acuity, rate, clock, exposure, escalations）
 * 五元组，所以必须在界面上直接给结论数字，而不是只给原始字段让他自己算。
 *
 * 反过来说：这里**只显示事实与算术结果**，不显示「所以你该点检测 / 该点隔离」——
 * 该做什么是玩家的判断，本模块不越界。
 *
 * 全部是纯函数，不依赖 Phaser，可单测。
 */
import {
  ESCALATION_STEP,
  exposureDose,
  isBedIsolated,
  isTransmitting,
  openEdgesOfBed,
} from "../core/rules";
import type { GameState, Patient } from "../core/types";

/** 死亡线：acuity ≥ 3 当帧死亡（Contract §6 / reducer.reapDead）。 */
export const DEATH_ACUITY = 3;
/** 红灯线：acuity ≥ 2 视为危重。 */
export const RED_ACUITY = 2;

export type Countdown = {
  /** 不会自己恶化（rate 0）。 */
  stable: boolean;
  /** 还要几个回合才自然恶化到下一档。null = 到不了。 */
  turnsToNextTier: number | null;
  /** 还要几个回合会死。null = 自然病程到不了。 */
  turnsToDeath: number | null;
};

/**
 * 自然病程倒计时。
 *
 * 回合末结算顺序（`reducer.resolvePhase → deteriorate`，Contract §4）：
 *  1. 本回合被处置过（`stabilizedThisTurn`）或因暴露升过档（`escalatedThisTurn`）→ 跳过；
 *  2. `deteriorationClock > 0` → 消耗 1 点缓冲，不恶化；
 *  3. 否则 `acuity += deteriorationRate`。
 *
 * 所以 `总回合数 = 缓冲 + ceil(还需的档数 / 每回合档数)`。
 *
 * v2 这里还有一个「误治之后进不可逆通道、每回合额外 +1」的分支，2026-09-17 随
 * Contract §5.3 改成「误诊即刻判负」整体删除 —— 没有那个状态了，也就没有那个倒计时。
 */
export function countdown(p: Patient): Countdown {
  if (!p.alive || p.discharged || p.acuity <= 0) {
    return { stable: true, turnsToNextTier: null, turnsToDeath: null };
  }
  const turnsTo = (target: number): number | null => {
    const gap = target - p.acuity;
    if (gap <= 0) return 0;
    if (p.deteriorationRate <= 0) return null;
    return p.deteriorationClock + Math.ceil(gap / p.deteriorationRate);
  };
  return {
    stable: p.deteriorationRate <= 0,
    turnsToNextTier: turnsTo(p.acuity + 1),
    turnsToDeath: turnsTo(DEATH_ACUITY),
  };
}

/**
 * 把倒计时说成一句**完整的话**（有主语、有后果、能独立读懂）。
 *
 * 纪律（2026-09-16 复审）：上一版写「不会自己变差」「最多再撑 2 个回合」——
 * 用户原话「什么叫不会自己变差？」。缺主语的碎片等于没说。
 * 现在一律以「他 / 他的病情」作主语，且长度控制在床卡一行放得下的范围内：
 *   - 「他的病情不会自己加重」
 *   - 「他 3 个回合后会死」
 *   - 「他的病情 4 个回合后变成红灯」+ detail「第 6 个回合会死」（侧栏才显示 detail）
 * `detail` 单独给侧栏用 —— 床卡一行塞不下，但侧栏有宽度，多给的这一句是纯收益。
 */
export function countdownText(p: Patient): { text: string; detail: string; urgent: boolean } {
  const c = countdown(p);
  if (c.turnsToDeath == null) {
    return { text: "他的病情不会自己加重", detail: "", urgent: false };
  }
  if (c.turnsToDeath === 0) return { text: "他这一回合就会死", detail: "", urgent: true };
  if (p.acuity >= RED_ACUITY) {
    // 红灯 + 只剩 1 个回合 = 就是这个回合末。说成「1 个回合后会死」会被读成
    // 「还有一回合可以等」，与床卡上的红色告警自相矛盾 —— 必须说成一件事。
    if (c.turnsToDeath === 1) return { text: "他这一回合就会死", detail: "", urgent: true };
    return {
      text: `他 ${c.turnsToDeath} 个回合后会死`,
      detail: "",
      urgent: c.turnsToDeath <= 2,
    };
  }
  if (c.turnsToNextTier != null) {
    return {
      text: `他的病情 ${c.turnsToNextTier} 个回合后变成红灯`,
      detail: `第 ${c.turnsToDeath} 个回合会死`,
      urgent: c.turnsToDeath <= 2,
    };
  }
  return { text: `他 ${c.turnsToDeath} 个回合后会死`, detail: "", urgent: c.turnsToDeath <= 2 };
}

export type ExposureStatus = {
  /** 当前暴露值。 */
  value: number;
  /** 下一档的阈值。 */
  threshold: number;
  /** 还差几点升档。 */
  need: number;
  /** 邻床一回合能给的最大剂量（0 = 没人传给他）。 */
  dose: number;
  /** 按当前剂量，下个回合末会不会升档。 */
  willEscalate: boolean;
  /** 这一档升上去会落到几。 */
  resultingAcuity: boolean extends never ? never : number;
  /**
   * 玩家**现在**有没有资格知道这个风险。
   *
   * 信息纪律：谁在传病是检测之后才揭示的隐藏信息。剂量预测如果对没撞过、
   * 也没检测过的邻床提前广播，就等于替玩家免费剧透了传染源 —— 检测的手经济
   * 就被架空了。所以只有两条路能解锁预告：
   *   ① 他已经被撞过（exposure > 0，既成事实）；
   *   ② 邻床里至少一个正在传病的人的「传染性」已被检测揭示。
   * 两条都不满足时，UI 一律闭嘴，把「猜猜谁在传」留给玩家自己。
   */
  disclosed: boolean;
};

/**
 * 暴露状态（Contract §6）。暴露每跨 `ESCALATION_STEP(=2)` 升一档，
 * 升档 = acuity +1。`willEscalate` 用与 reducer.applyExposure 同源的判据。
 */
export function exposureStatus(state: GameState, p: Patient): ExposureStatus {
  const threshold = (p.escalations + 1) * ESCALATION_STEP;
  let dose = 0;
  let disclosed = p.exposure > 0;
  if (p.bedId != null) {
    for (const e of openEdgesOfBed(state, p.bedId)) {
      const [a, b] = e.split("-").map(Number);
      const other = a === p.bedId ? b : a;
      const id = state.beds[other];
      if (!id) continue;
      const src = state.patients[id];
      if (!isTransmitting(src)) continue;
      if (src.revealed.includes("transmission")) disclosed = true;
      dose = Math.max(dose, exposureDose(src));
    }
  }
  return {
    value: p.exposure,
    threshold,
    need: Math.max(0, threshold - p.exposure),
    dose,
    willEscalate: dose > 0 && p.exposure + dose >= threshold,
    resultingAcuity: p.acuity + 1,
    disclosed,
  };
}

/** 这张床现在是不是已经被帘子围严。 */
export function isSealed(state: GameState, bedId: number): boolean {
  return isBedIsolated(state, bedId);
}
