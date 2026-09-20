import { describe, expect, it } from "vitest";
import night01 from "../levels/night-01.json";
import { reduce } from "../src/core/reducer";
import { replay } from "../src/core/replay";
import { actionCost, dischargedCount } from "../src/core/rules";
import { createInitialState } from "../src/core/state";
import { solve } from "../src/solver";
import type { AxisIntervention, LevelDef, PatientDef, PlayerAction } from "../src/core/types";
import { GOLDEN } from "./golden";

const level = night01 as unknown as LevelDef;
const gold = GOLDEN["night-01"];
const solved = solve(level, { maxNodes: 100_000 });

describe("night-01「先分真假」", () => {
  it("最优解把 4 个人送走，零死亡", () => {
    const { state, log } = replay(level, solved.path!);
    expect(log.every((r) => r.accepted)).toBe(true);
    expect(dischargedCount(state)).toBe(gold.discharged);
    expect(state.deaths).toBe(0);
    expect(state.outcome).toBe("WIN");
  });

  it("余量 1 —— D1 修复后处置当回合不再收账，minAP 15 → 14", () => {
    expect(solved.minAP).toBe(gold.minAP);
    expect(solved.slack).toBe(gold.slack);
    expect(solved.slack).toBe(1);
    expect(solved.minAP).toBe(level.turns * level.actionPoints - 1);
  });

  it("这一关没有传播，也不提供隔离", () => {
    expect(level.rules.infectionEnabled).toBe(false);
    expect(level.enabledActions).not.toContain("ISOLATE");
    // 帘 = 隔离本身（v5）：开局没有帘，又没有 ISOLATE 动作 ⇒ 全场永远无帘
    expect(createInitialState(level).curtains).toHaveLength(0);
    expect(createInitialState(level).isolatedBedId).toBeNull();
    expect(Object.values(createInitialState(level).patients).every((p) => p.transmission === "NONE")).toBe(true);
    expect(solved.path!.some((a) => a.type === "ISOLATE")).toBe(false);
  });
});

describe("镜像轴的教学点", () => {
  it("B01：不检测就处置 = 误诊，当帧判负 —— 「读体征赌方向」不是技能", () => {
    const s = createInitialState(level);
    const r = reduce(s, { type: "STABILIZE", patientId: "B01" });
    expect(r.accepted).toBe(true);
    expect(r.events).toContain("MISDIAGNOSIS:B01:A");
    expect(r.state.patients.B01.alive).toBe(false);
    expect(r.state.outcome).toBe("LOSE");
  });

  it("B01：检测后处置必然成功 —— 检测就是镜像患者的全部代价", () => {
    let s = createInitialState(level);
    s = reduce(s, { type: "SCAN", patientId: "B01" }).state;
    const r = reduce(s, { type: "STABILIZE", patientId: "B01" });
    expect(r.accepted).toBe(true);
    expect(r.state.patients.B01.acuity).toBe(0);
    expect(r.state.patients.B01.revealed).toContain("riskProfile");
    expect(r.state.outcome).not.toBe("LOSE");
    // 3 − 1(检测) − 2(治愈档) = 0 → 回合自动推进，进入新回合的 3 手
    expect(r.state.ap).toBe(r.state.actionPointsPerTurn);
  });

  it("B02 是 B 面：不检测就处置，和 A 面一样当场判负", () => {
    // 用夹具把 B02 的配置单独拿出来，避免受到达时序干扰
    const p = (level.arrivalSchedule[1] as PatientDef[])[0];
    expect(p.id).toBe("B02");
    expect(p.rules.mirrorBranch).toBe("B");

    const f: LevelDef = {
      id: "f",
      title: "f",
      turns: 4,
      actionPoints: 2,
      enabledActions: ["SCAN", "STABILIZE"],
      rules: {
        infectionEnabled: false,
        corridorGraceTurns: 1,
        maxDeaths: 0,
        requiredDischarges: "ALL",
      },
      initialPatients: [{ ...p, state: { bedId: 1 } }],
      arrivalSchedule: [],
    };
    const r = reduce(createInitialState(f), { type: "STABILIZE", patientId: "B02" });
    expect(r.events).toContain("MISDIAGNOSIS:B02:B");
    expect(r.state.patients.B02.alive).toBe(false);
    expect(r.state.outcome).toBe("LOSE");
  });

  /**
   * 契约 §5.4（误诊判死版）：镜像患者的结局只有两种 ——
   *   检测 → 1(检测) + 2(治愈档) = **3 AP**，人救回来了；
   *   不检测 → **本局当场结束**。
 * 本关余量是 1（D1 修复后）：镜像患者本人仍是「检测 3 手救回来」——
 * 而不检测那条路照样不存在（旧模型说盲治净贵 4 AP，那意味着错一次还能赢）。
   */
  it("镜像患者只有两种结局：花 3 手救回来，或者这一夜到此为止", () => {
    const fixture = (branch: "A" | "B"): LevelDef => ({
      id: "f",
      title: "f",
      turns: 9,
      actionPoints: 9,
      enabledActions: ["SCAN", "STABILIZE"],
      rules: {
        infectionEnabled: false,
        corridorGraceTurns: 1,
        maxDeaths: 0,
        requiredDischarges: "ALL",
      },
      initialPatients: [
        {
          id: "M",
          archetype: "T",
          visible: { chiefComplaint: "M", acuity: 1 },
          rules: {
            deteriorationRate: 0,
            transmission: "NONE",
            axisIntervention: "MIRROR" as AxisIntervention,
            mirrorBranch: branch,
          },
          hidden: {},
          revealOrder: ["riskProfile"],
          state: { bedId: 1 },
        },
      ],
      arrivalSchedule: [],
    });

    const correct = (branch: "A" | "B") => {
      let s = createInitialState(fixture(branch));
      let cost = 0;
      const step = (a: PlayerAction) => {
        cost += actionCost(s, a);
        s = reduce(s, a).state;
      };
      step({ type: "SCAN", patientId: "M" });
      step({ type: "STABILIZE", patientId: "M" }); // 检测过 → 自动走对的方向
      return { cost, acuity: s.patients.M.acuity, outcome: s.outcome, alive: s.patients.M.alive };
    };

    // 两个分支的正确打法完全一样：3 手，人出院
    for (const branch of ["A", "B"] as const) {
      expect(correct(branch), `${branch} 面`).toEqual({
        cost: 3,
        acuity: 0,
        outcome: "WIN",
        alive: true,
      });
    }

    // 不检测 = 终局。不是「贵 4 手」，是没有后半局：
    // 玩家的下一步动作会被直接拒绝，唯一能做的就是重开。
    const blind = reduce(createInitialState(fixture("B")), { type: "STABILIZE", patientId: "M" });
    expect(blind.state.outcome).toBe("LOSE");
    expect(blind.state.patients.M.alive).toBe(false);
    expect(reduce(blind.state, { type: "SCAN", patientId: "M" }).accepted).toBe(false);

    // 本关余量是 1（D1 修复后）：多出的一点余量买不回一条命 ——
    // 误诊没有「之后」，重开是唯一出路，这与余量多少无关
    expect(gold.slack).toBe(1);
  });
});

describe("走廊宽限", () => {
  it("A01 到达后先消耗宽限，不立刻掉血", () => {
    const { state } = replay(level, [
      { type: "SCAN", patientId: "B01" },
      { type: "STABILIZE", patientId: "B01" },
    ]);
    // A01 现在带 acuity 2 进来（重配平后），宽限回合内不掉血 ⇒ 仍是 2
    expect(state.patients.A01.acuity).toBe(2);
    expect(state.patients.A01.deteriorationClock).toBe(0); // 宽限 1 回合已用完
    expect(state.patients.A01.bedId).toBeNull();
  });
});
