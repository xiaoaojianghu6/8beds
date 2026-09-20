import { describe, expect, it } from "vitest";
import night00 from "../levels/night-00.json";
import night01 from "../levels/night-01.json";
import night02 from "../levels/night-02.json";
import { reduce } from "../src/core/reducer";
import { createInitialState } from "../src/core/state";
import { actionCost, isBedIsolated, isScreened, legalActions } from "../src/core/rules";
import type { LevelDef, PatientDef } from "../src/core/types";

const n00 = night00 as unknown as LevelDef;
const n01 = night01 as unknown as LevelDef;
const n02 = night02 as unknown as LevelDef;

/**
 * 最小夹具：只放一个患者，用于隔离造价 / 缓冲这类单点行为。
 *
 * 现行定价（Contract §4.1）：急救 1 手、治愈 2 手、隔离 1 手。
 * 因此这类夹具的 ap 常常要给到 3，才够「治一次 + 压一次」。
 */
function fixture(
  p: PatientDef,
  opts: {
    ap?: number;
    actions?: LevelDef["enabledActions"];
    rules?: Partial<LevelDef["rules"]>;
  } = {},
): LevelDef {
  return {
    id: "fixture",
    title: "fixture",
    turns: 4,
    actionPoints: opts.ap ?? 3,
    enabledActions: opts.actions ?? ["STABILIZE"],
    rules: {
      infectionEnabled: false,
      corridorGraceTurns: 1,
      maxDeaths: 0,
      requiredDischarges: "ALL",
      ...opts.rules,
    },
    initialPatients: [p],
    arrivalSchedule: [],
  };
}

const direct = (id: string, acuity: number, rate = 0, bedId = 1): PatientDef => ({
  id,
  archetype: "T",
  visible: { chiefComplaint: id, acuity },
  rules: { deteriorationRate: rate, transmission: "NONE", axisIntervention: "DIRECT" },
  hidden: {},
  revealOrder: ["riskProfile", "transmission", "disposition"],
  state: { bedId },
});

describe("非法 vs 无效", () => {
  it("收治到已占用的床 = 非法：拒绝，不扣 AP，队首原地不动", () => {
    const s = createInitialState(n00);
    const r = reduce(s, { type: "ADMIT", bedId: 1 });
    expect(r.accepted).toBe(false);
    expect(r.events).toContain("REJECTED_ILLEGAL");
    expect(r.state.ap).toBe(3);
    expect(r.state.queue).toEqual(["A02"]);
    expect(r.state.patients.A02.bedId).toBeNull();
  });

  it("关卡未启用的动作 = 拒绝且不扣 AP（night-00 没有 SCAN）", () => {
    const s = createInitialState(n00);
    const r = reduce(s, { type: "SCAN", patientId: "A01" });
    expect(r.accepted).toBe(false);
    expect(r.events).toContain("REJECTED_DISABLED");
    expect(r.state.ap).toBe(3);
    expect(r.state.patients.A01.revealed).toEqual([]);
  });

  it("分档定价：急救 1 手降一档，治愈 2 手才送走", () => {
    const s = createInitialState(fixture(direct("R01", 2)));
    // 第一手：急救档（acuity ≥ 2）—— 只降一档，人还在床上
    const once = reduce(s, { type: "STABILIZE", patientId: "R01" });
    expect(once.state.patients.R01.acuity).toBe(1);
    expect(once.state.patients.R01.discharged).toBe(false);
    expect(once.state.beds[1]).toBe("R01");
    expect(once.state.ap).toBe(2); // 3 − 1
    // 第二手：治愈档（acuity 1）—— 两只手，人才走
    const twice = reduce(once.state, { type: "STABILIZE", patientId: "R01" });
    expect(twice.state.patients.R01.acuity).toBe(0);
    expect(twice.state.patients.R01.discharged).toBe(true);
    expect(twice.state.beds[1]).toBeNull();
    expect(twice.state.ap).toBe(0); // 2 − 2
  });

  it("只剩 1 只手时，治愈档不出现在 legalActions（付不起就不给选项）", () => {
    const s = createInitialState(fixture(direct("R01", 1), { ap: 1 }));
    expect(s.ap).toBe(1);
    expect(legalActions(s).some((a) => a.type === "STABILIZE")).toBe(false);
    // 反过来：acuity 2 的急救档只要 1 只手，仍然合法
    const s2 = createInitialState(fixture(direct("R02", 2), { ap: 1 }));
    expect(legalActions(s2).some((a) => a.type === "STABILIZE")).toBe(true);
  });
});

describe("SCAN_FIRST 轴：无效 ≠ 非法", () => {
  const scanFirst: PatientDef = {
    id: "S01",
    archetype: "T",
    visible: { chiefComplaint: "S01", acuity: 1 },
    rules: { deteriorationRate: 0, transmission: "NONE", axisIntervention: "SCAN_FIRST" },
    hidden: {},
    revealOrder: ["riskProfile", "transmission", "disposition"],
    state: { bedId: 1 },
  };

  it("未检查就处置：接受、照价扣 AP、acuity 不降、窗口计数 +1", () => {
    // ap 给 5：扣掉治愈档的 2 手后还剩 3 手，STABILIZE 仍然合法 ⇒ 回合**不**结算，
    // 这样 ap 的变化才纯粹反映这一次动作的价钱。
    // （给 3 的话：3−2=1 之后没人付得起 2 手的治愈档，legalActions 为空 ⇒ 回合推进、ap 被重置。）
    const s = createInitialState(fixture(scanFirst, { ap: 5 }));
    const r = reduce(s, { type: "STABILIZE", patientId: "S01" });
    expect(r.accepted).toBe(true);
    expect(r.events.some((e) => e.startsWith("STABILIZE_INEFFECTIVE:S01:UNSCANNED"))).toBe(
      true,
    );
    // 无效处置仍按档收费（acuity 1 ⇒ 治愈档 2 手）
    expect(r.state.ap).toBe(3);
    expect(r.state.patients.S01.acuity).toBe(1);
    expect(r.state.patients.S01.missedStabilizationWindow).toBe(1);
  });

  it("检查后处置：有效降档", () => {
    const s = createInitialState(fixture(scanFirst, { ap: 3, actions: ["SCAN", "STABILIZE"] }));
    const scanned = reduce(s, { type: "SCAN", patientId: "S01" });
    expect(scanned.state.patients.S01.revealed).toContain("riskProfile");
    const r = reduce(scanned.state, { type: "STABILIZE", patientId: "S01" });
    expect(r.state.patients.S01.acuity).toBe(0);
    expect(r.events.some((e) => e.startsWith("STABILIZE_INEFFECTIVE"))).toBe(false);
  });
});

describe("MIRROR 轴：盲治 = 误诊，当帧判负", () => {
  const mirror = (branch: "A" | "B"): PatientDef => ({
    id: "M01",
    archetype: "T",
    visible: { chiefComplaint: "M01", acuity: 1 },
    rules: {
      deteriorationRate: 0,
      transmission: "NONE",
      axisIntervention: "MIRROR",
      mirrorBranch: branch,
      planA: "方案甲",
      planB: "方案乙",
    },
    hidden: {},
    revealOrder: ["riskProfile", "transmission", "disposition"],
    state: { bedId: 1 },
  });

  it("night-01 的 B01：未检测就处置 = 误诊（没有盲治命中这回事）", () => {
    const s = createInitialState(n01);
    const r = reduce(s, { type: "STABILIZE", patientId: "B01" });
    expect(r.accepted).toBe(true);
    expect(r.events).toContain("MISDIAGNOSIS:B01:A");
    expect(r.state.patients.B01.alive).toBe(false);
    expect(r.state.outcome).toBe("LOSE");
    expect(r.state.deaths).toBe(1);
  });

  it("A 面 / B 面一视同仁：没有「赌对方向」这回事", () => {
    for (const branch of ["A", "B"] as const) {
      const r = reduce(createInitialState(fixture(mirror(branch), { ap: 3 })), {
        type: "STABILIZE",
        patientId: "M01",
      });
      expect(r.accepted, `${branch} 面`).toBe(true);
      expect(r.events).toContain(`MISDIAGNOSIS:M01:${branch}`);
      expect(r.state.outcome, `${branch} 面`).toBe("LOSE");
      expect(r.state.patients.M01.alive, `${branch} 面`).toBe(false);
    }
  });

  it("误诊照同一张价目表扣手，但扣掉的手没有意义 —— 结局与 AP 无关", () => {
    const s = createInitialState(fixture(mirror("A"), { ap: 6 }));
    // 第一手是治愈档（acuity 1）：2 只手
    expect(actionCost(s, { type: "STABILIZE", patientId: "M01" })).toBe(s.curativeCost);
    expect(s.curativeCost).toBe(2);
    const r = reduce(s, { type: "STABILIZE", patientId: "M01" });
    expect(r.state.ap).toBe(4); // 6 − 2
  });

  it("MIRROR 患者的 legalActions 只有一个处置（方向由检测决定）", () => {
    const stabs = legalActions(createInitialState(fixture(mirror("B")))).filter(
      (a) => a.type === "STABILIZE",
    );
    expect(stabs).toHaveLength(1);
  });
});

describe("隔离：一只手的纯支出（2026-09-18 裁定：围谁就封谁，不牵连别处）", () => {
  it("night-02 里隔离 D01 是合法的，扣 isolateCost（1 只手）", () => {
    const s = createInitialState(n02);
    expect(s.ap).toBe(3);
    const r = reduce(s, { type: "ISOLATE", patientId: "D01" });
    expect(r.accepted).toBe(true);
    // 隔离不是「一个人身上的标志」，而是「他这张床的每条缝都挂了帘」
    expect(isBedIsolated(r.state, 3)).toBe(true);
    expect(r.events).toContain("ISOLATED:D01:cost1");
    expect(actionCost(s, { type: "ISOLATE", patientId: "D01" })).toBe(1);
    // 隔离只要一只手：ap 3→2，回合不推进 —— 剩下两只手还能救人
    expect(r.state.turn).toBe(1);
    expect(r.state.ap).toBe(2);
  });

  it("围住 3 号床 = 三条边全部挂帘；开局场上没有别的帘", () => {
    const s = createInitialState(n02);
    expect(s.curtains).toEqual([]);
    const r = reduce(s, { type: "ISOLATE", patientId: "D01" });
    // 3 号床的三条边全部挂帘
    for (const e of ["2-3", "3-4", "3-7"]) expect(isScreened(r.state, e), e).toBe(true);
    // 场上只有这一床隔离帘
    expect(r.state.curtains).toEqual(["2-3", "3-4", "3-7"]);
    expect(r.state.isolatedBedId).toBe(3);
    expect(r.events.some((e) => e.startsWith("CURTAIN_MOVED"))).toBe(true);
  });

  it("AP 不足以支付 isolateCost 时，隔离不出现在 legalActions", () => {
    const s = createInitialState(fixture(direct("X", 1), { ap: 1, actions: ["ISOLATE"], rules: { isolateCost: 2 } }));
    expect(s.isolateCost).toBe(2);
    expect(s.ap).toBe(1);
    expect(legalActions(s).some((a) => a.type === "ISOLATE")).toBe(false);
  });

  it("全场唯一：围上新人，旧人的隔离帘全部撤走", () => {
    let s = createInitialState(n02);
    s = reduce(s, { type: "ISOLATE", patientId: "D01" }).state;
    expect(isBedIsolated(s, 3)).toBe(true);

    // ap 还剩 2，够再隔离一次；现在改去围 2 号床
    const r = reduce(s, { type: "ISOLATE", patientId: "H01" });
    expect(r.accepted).toBe(true);
    expect(isBedIsolated(r.state, 2)).toBe(true);
    // 3 号床恢复敞开 —— 帘跟着人走，全场同时只有一个人被隔离
    expect(isScreened(r.state, "3-7")).toBe(false);
    expect(isBedIsolated(r.state, 3)).toBe(false);
    expect(r.events).toContain("ISOLATION_CLEARED:bed3");
  });

  it("已经围严的床不再产出隔离动作；重复执行被拒且不扣 AP", () => {
    const s = createInitialState(n02);
    const done = reduce(s, { type: "ISOLATE", patientId: "D01" }).state;
    expect(isBedIsolated(done, 3)).toBe(true);
    expect(
      legalActions(done).some((a) => a.type === "ISOLATE" && a.patientId === "D01"),
    ).toBe(false);

    const r = reduce(done, { type: "ISOLATE", patientId: "D01" });
    expect(r.accepted).toBe(false);
    expect(r.state.ap).toBe(done.ap);
  });
});
