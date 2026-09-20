/**
 * `src/ui/forecast.ts` —— 「算得出但看不见」的那些数字。
 *
 * 这层是玩法可读性的地基：玩家没法在脑子里同时维护 8 个患者的
 * （acuity, rate, clock, exposure, escalations），所以倒计时与阈值必须由代码算准、
 * 由界面直给。算错了，玩家就会照着一个错误的数字做决策 —— 比不显示更糟。
 */
import { describe, expect, it } from "vitest";
import night02 from "../levels/night-02.json";
import { createInitialState } from "../src/core/state";
import { reduce } from "../src/core/reducer";
import type { LevelDef, Patient } from "../src/core/types";
import { countdown, countdownText, exposureStatus } from "../src/ui/forecast";

const n02 = night02 as unknown as LevelDef;

/** 取一个患者并覆盖若干字段（测试内改 state 的拷贝，不影响别的用例）。 */
function patched(p: Patient, o: Partial<Patient>): Patient {
  return { ...p, ...o };
}

function anyPatient(): Patient {
  const s = createInitialState(n02);
  return Object.values(s.patients)[0];
}

describe("forecast.countdown —— 自然病程倒计时", () => {
  it("红档 + rate 1：下个回合末就会死", () => {
    const c = countdown(patched(anyPatient(), { acuity: 2, deteriorationRate: 1, deteriorationClock: 0 }));
    expect(c.turnsToDeath).toBe(1);
    expect(c.turnsToNextTier).toBe(1);
  });

  it("黄档 + rate 1：1 回合转红、2 回合死", () => {
    const c = countdown(patched(anyPatient(), { acuity: 1, deteriorationRate: 1, deteriorationClock: 0 }));
    expect(c.turnsToNextTier).toBe(1);
    expect(c.turnsToDeath).toBe(2);
  });

  it("rate 0：要说清「他的病情不会自己加重」—— 这句话本身就是重要信息", () => {
    const c = countdown(patched(anyPatient(), { acuity: 2, deteriorationRate: 0 }));
    expect(c.stable).toBe(true);
    expect(c.turnsToDeath).toBeNull();
    expect(countdownText(patched(anyPatient(), { acuity: 2, deteriorationRate: 0 })).text).toBe(
      "他的病情不会自己加重",
    );
  });

  it("红档只剩 1 个回合：说「他这一回合就会死」，不能说成「再撑 1 个回合」", () => {
    // 说「最多再撑 1 个回合」会被读成「还有一回合可以等」，
    // 而床卡上另有一行告警写着同一件事 —— 两句话必须是一个意思。
    const p = patched(anyPatient(), { acuity: 2, deteriorationRate: 1, deteriorationClock: 0 });
    expect(countdown(p).turnsToDeath).toBe(1);
    expect(countdownText(p).text).toBe("他这一回合就会死");
    expect(countdownText(p).urgent).toBe(true);
  });

  it("红档还剩 2 个回合以上：说「他 N 个回合后会死」", () => {
    const p = patched(anyPatient(), { acuity: 2, deteriorationRate: 1, deteriorationClock: 1 });
    expect(countdown(p).turnsToDeath).toBe(2);
    expect(countdownText(p).text).toBe("他 2 个回合后会死");
  });

  /**
   * 文案纪律的机器护栏。
   *
   * 用户原话：「什么叫不会自己变差？」「说话说标准」「不能说的话人听不懂」。
   * 所以倒计时文案**永远**必须是完整句子 —— 有主语、有后果；
   * 不许出现缺主语的碎片（「不会自己变差」「撑不过这一回合」），
   * 也不许出现内部编号（N01 / S01）。
   */
  it("永远是完整句子：有主语、无碎片、无内部编号", () => {
    const cases: Array<Partial<Patient>> = [
      { acuity: 2, deteriorationRate: 0 },
      { acuity: 2, deteriorationRate: 1, deteriorationClock: 0 },
      { acuity: 2, deteriorationRate: 1, deteriorationClock: 1 },
      { acuity: 2, deteriorationRate: 1, deteriorationClock: 3 },
      { acuity: 1, deteriorationRate: 1, deteriorationClock: 0 },
      { acuity: 1, deteriorationRate: 0, deteriorationClock: 0 },
      { acuity: 1, deteriorationRate: 2, deteriorationClock: 2 },
    ];
    for (const o of cases) {
      const { text, detail } = countdownText(patched(anyPatient(), o));
      const why = `acuity${o.acuity}/rate${o.deteriorationRate}/clock${o.deteriorationClock} → 「${text}」`;
      expect(text.startsWith("他") || text.startsWith("他的"), `缺主语：${why}`).toBe(true);
      expect(text, `出现内部编号：${why}`).not.toMatch(/[A-Z]\d{2}/);
      expect(text, `旧碎片句式回来了：${why}`).not.toMatch(/不会自己变差|撑不过|最多再撑|再 \d+ 个回合会死/);
      if (detail) expect(detail).toMatch(/^第 \d+ 个回合会死$/);
    }
  });

  it("稳定缓冲按回合数抵扣，且 rate > 1 时按整除向上取整", () => {
    // 缓冲 2 回合，之后 acuity 1 → 3 需要 2 档、每回合 2 档 ⇒ 1 个恶化回合
    const c = countdown(
      patched(anyPatient(), { acuity: 1, deteriorationRate: 2, deteriorationClock: 2 }),
    );
    expect(c.turnsToDeath).toBe(3); // 2 缓冲 + 1 恶化
  });

  // 这里原本有一组「不可逆通道倒计时」的用例（`reversing` / `reversedThisTurn` 宽限）。
  // 那两个字段已随补救通道一起删除（2026-09-17）：未检测的 MIRROR 患者被处置
  // 是**当帧判负**，不存在一段「还能看着它恶化几个回合」的时间。
  // 倒计时逻辑因此回到单一来源 —— 只有自然病程。
});

describe("forecast.exposureStatus —— 暴露到几点升档", () => {
  it("邻床有传染源时，剂量与阈值都要给出来", () => {
    const s = createInitialState(n02);
    const exposed = Object.values(s.patients)
      .filter((p) => p.bedId != null)
      .map((p) => ({ p, ex: exposureStatus(s, p) }))
      .filter((x) => x.ex.dose > 0);
    expect(exposed.length).toBeGreaterThan(0);
    for (const { ex } of exposed) {
      expect(ex.threshold).toBeGreaterThan(0);
      expect(ex.need).toBe(ex.threshold - ex.value);
    }
  });

  it("被围严的床剂量为 0 —— 挂帘确实断掉了那条线", () => {
    const s0 = createInitialState(n02);
    // 开局没有任何帘；围上 D01（3 号床）之后，邻床全部安全
    const s = reduce(s0, { type: "ISOLATE", patientId: "D01" }).state;
    const h = s.patients["H01"];
    expect(h.bedId).toBe(2);
    expect(exposureStatus(s, h).dose).toBe(0);
  });

  it("willEscalate 的判据与 ESCALATION_STEP 同源（差 1 点就报警）", () => {
    const s = createInitialState(n02);
    const p = Object.values(s.patients).find((x) => x.bedId === 7)!;
    const ex = exposureStatus(s, p);
    if (ex.dose > 0) {
      const almost = patched(p, { exposure: ex.threshold - 1 });
      expect(exposureStatus(s, almost).willEscalate).toBe(true);
      const safe = patched(p, { exposure: ex.threshold - ex.dose - 1 });
      expect(exposureStatus(s, safe).willEscalate).toBe(false);
    }
  });

  it("disclosed：源未揭示且没被撞过时闭嘴；被撞过或源已检测揭示才解锁预告", () => {
    const s = createInitialState(n02);
    // 7 号床（E01）挨着 3 号床的隐藏传染源：开局有剂量，但没资格预告
    const victim = Object.values(s.patients).find((x) => x.bedId === 7)!;
    const ex0 = exposureStatus(s, victim);
    if (ex0.dose > 0) {
      expect(ex0.disclosed).toBe(false);
      // 被撞过（既成事实）→ 解锁
      expect(exposureStatus(s, patched(victim, { exposure: 2 })).disclosed).toBe(true);
      // 源的「传染性」被检测揭示 → 也解锁
      const s2 = createInitialState(n02);
      s2.patients["D01"].revealed.push("transmission");
      const victim2 = Object.values(s2.patients).find((x) => x.bedId === 7)!;
      expect(exposureStatus(s2, victim2).disclosed).toBe(true);
    }
  });
});
