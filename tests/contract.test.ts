/**
 * Contract 一致性测试 —— 权威契约 `spec/SIMULATION_CONTRACT.md` §11。
 *
 * 这个文件的唯一职责：把契约里每条**可机器校验**的条款变成会失败的断言。
 * 契约改了而这里没改 → 断言会红；代码改了而契约没改 → 断言也会红。
 * 两种红都意味着「分叉」，必须停下来对齐，而不是改断言让它变绿。
 *
 * 禁止在这个文件里写「实现细节」。这里只写契约明文承诺过的行为。
 */
import { describe, expect, it } from "vitest";
import night00 from "../levels/night-00.json";
import night01 from "../levels/night-01.json";
import night02 from "../levels/night-02.json";
import { reduce } from "../src/core/reducer";
import { replay } from "../src/core/replay";
import { createInitialState } from "../src/core/state";
import {
  actionCost,
  allEdges,
  canDischarge,
  stabilizeCost,
  edgesOfBed,
  ESCALATION_STEP,
  exposureDose,
  isBedIsolated,
  isScreened,
  isTransmitting,
  legalActions,
  neighbors,
} from "../src/core/rules";
import { targetDischarges } from "../src/core/reducer";
import { solve } from "../src/solver";
import type {
  ActionType,
  AxisIntervention,
  LevelDef,
  MirrorBranch,
  PatientDef,
  PlayerAction,
} from "../src/core/types";

// ────────────────────────────────────────────────────────────────
// 测试夹具：手搓最小关卡，让每条断言只测一个契约条款
// ────────────────────────────────────────────────────────────────

type POpts = {
  bedId?: number | null;
  acuity?: number;
  rate?: number;
  transmission?: "NONE" | "LOW" | "HIGH";
  axis?: AxisIntervention;
  branch?: MirrorBranch;
  disruptive?: boolean;
  timeWindow?: number;
};

function pdef(id: string, o: POpts = {}): PatientDef {
  return {
    id,
    archetype: "T",
    visible: { chiefComplaint: id, acuity: o.acuity ?? 1 },
    rules: {
      deteriorationRate: o.rate ?? 0,
      transmission: o.transmission ?? "NONE",
      axisIntervention: o.axis ?? "DIRECT",
      mirrorBranch: o.branch,
      disruptive: o.disruptive,
      timeWindow: o.timeWindow,
    },
    hidden: {},
    revealOrder: ["riskProfile", "transmission", "disposition"],
    state: o.bedId == null ? {} : { bedId: o.bedId },
  };
}

/**
 * 「烧手陪衬」：一个放在角落（8 号床，只挨 4/7 两张床）、不会自然恶化、
 * 且**处在急救档**（acuity ≥ 2 ⇒ 处置只收 emergencyCost = 1 手）的患者。
 *
 * 为什么必须是 acuity ≥ 2：分档定价后治愈档要 2 手（Contract §4.1），
 * 拿 acuity 1 的患者去「花 1 AP 触发回合结算」会直接因 AP 不足被 legalActions 过滤掉，
 * 回合不推进 —— 这在 3 手制下是最容易踩的坑。
 *
 * 本作没有「过回合」动作，回合只在 ap 归零或合法动作为空时结算，
 * 所以凡是要观察「回合末发生了什么」的用例，都得有一个能精确烧掉 1 AP 的陪衬。
 */
function burner(id = "W", bedId = 8): PatientDef {
  return pdef(id, { bedId, acuity: 2 });
}

function mk(o: {
  patients?: PatientDef[];
  arrivals?: PatientDef[][];
  turns?: number;
  ap?: number;
  actions?: ActionType[];
  rules?: Partial<LevelDef["rules"]>;
} = {}): LevelDef {
  return {
    id: "fixture",
    title: "fixture",
    turns: o.turns ?? 4,
    actionPoints: o.ap ?? 2,
    enabledActions: o.actions ?? ["ADMIT", "SCAN", "STABILIZE", "ISOLATE"],
    rules: {
      infectionEnabled: false,
      corridorGraceTurns: 1,
      // 开局没有任何帘（布景帘已废除）。要测帘的用例自己执行 ISOLATE。
      maxDeaths: 0,
      requiredDischarges: "ALL",
      ...o.rules,
    },
    initialPatients: o.patients ?? [],
    arrivalSchedule: o.arrivals ?? [],
  };
}

const shipped = [night00, night01, night02] as unknown as LevelDef[];

/**
 * 求解很贵（一关几十秒，堆也不小）。§8 与 §9 要的是同一条路径，
 * 缓存一次就够 —— 内存护栏见 vitest.config.ts（单线程池）与 tools/ 下的 NODE_CAP 注释。
 */
const SOLVE_CACHE = new Map<string, ReturnType<typeof solve>>();
function solveLevel(lv: LevelDef, maxNodes = 100_000): ReturnType<typeof solve> {
  const hit = SOLVE_CACHE.get(lv.id);
  if (hit) return hit;
  const r = solve(lv, { maxNodes });
  SOLVE_CACHE.set(lv.id, r);
  return r;
}

// ────────────────────────────────────────────────────────────────
describe("§1 拓扑", () => {
  it("邻接表与契约明文一致（2×4 满邻接）", () => {
    expect(neighbors(1)).toEqual([2, 5]);
    expect(neighbors(2)).toEqual([1, 3, 6]);
    expect(neighbors(3)).toEqual([2, 4, 7]);
    expect(neighbors(4)).toEqual([3, 8]);
    expect(neighbors(5)).toEqual([1, 6]);
    expect(neighbors(6)).toEqual([2, 5, 7]);
    expect(neighbors(7)).toEqual([3, 6, 8]);
    expect(neighbors(8)).toEqual([4, 7]);
    expect(neighbors(99)).toEqual([]);
  });

  it("边集无向、去重，共 10 条，与契约边表一致", () => {
    const edges = allEdges().map(([a, b]) => `${a}-${b}`);
    expect(edges.sort()).toEqual(
      ["1-2", "1-5", "2-3", "2-6", "3-4", "3-7", "4-8", "5-6", "6-7", "7-8"].sort(),
    );
    // 对称性：a 的邻接里有 b ⇔ b 的邻接里有 a
    for (const [a, b] of allEdges()) {
      expect(neighbors(a), `${a} 的邻接应含 ${b}`).toContain(b);
      expect(neighbors(b), `${b} 的邻接应含 ${a}`).toContain(a);
    }
  });
});

// ────────────────────────────────────────────────────────────────
describe("§1.1 帘：隔离的唯一机制（2026-09-18 裁定：帘不是资源）", () => {
  it("隔离 = 把这张床的每条边都挂上帘；由此可推出，不需要存标志位", () => {
    const s0 = createInitialState(night02 as unknown as LevelDef);
    expect(isBedIsolated(s0, 3)).toBe(false);
    const s1 = reduce(s0, { type: "ISOLATE", patientId: "D01" }).state;
    expect(isBedIsolated(s1, 3)).toBe(true);
    for (const e of edgesOfBed(3)) expect(isScreened(s1, e), e).toBe(true);
  });

  it("帘跟着隔离走：围上新人 = 旧人恢复敞开，全场始终只有一床隔离帘", () => {
    const s0 = createInitialState(night02 as unknown as LevelDef);
    // 开局没有任何帘；隔离位是空的
    expect(s0.curtains).toEqual([]);
    expect(s0.isolatedBedId).toBeNull();

    const r1 = reduce(s0, { type: "ISOLATE", patientId: "D01" });
    const s1 = r1.state;
    expect(s1.isolatedBedId).toBe(3);
    expect(s1.curtains).toEqual([...edgesOfBed(3)].sort());
    expect(r1.events.some((e) => e.startsWith("ISOLATION_CLEARED"))).toBe(false);

    // 围上 2 号床：3 号床的帘全部撤走（帘跟着人走），不是叠加
    const r2 = reduce(s1, { type: "ISOLATE", patientId: "H01" });
    expect(r2.accepted).toBe(true);
    expect(r2.state.isolatedBedId).toBe(2);
    expect(r2.state.curtains).toEqual([...edgesOfBed(2)].sort());
    expect(r2.events).toContain("ISOLATION_CLEARED:bed3");
    expect(isBedIsolated(r2.state, 3), "旧人恢复敞开").toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
describe("§2 动作 AP 成本", () => {
  it("ADMIT / SCAN = 1 AP；STABILIZE 按档（治愈 curativeCost，急救 emergencyCost）", () => {
    const s = createInitialState(mk({ patients: [pdef("P", { bedId: 1 })] }));
    expect(actionCost(s, { type: "ADMIT", bedId: 2 })).toBe(1);
    expect(actionCost(s, { type: "SCAN", patientId: "P" })).toBe(1);
    // pdef 默认 acuity 1 ⇒ 治愈档，两只手（Contract §4.1）
    expect(s.patients.P.acuity).toBe(1);
    expect(actionCost(s, { type: "STABILIZE", patientId: "P" })).toBe(s.curativeCost);
    expect(s.curativeCost).toBe(2);
    // 提到 acuity 2 ⇒ 急救档，一只手
    s.patients.P.acuity = 2;
    expect(actionCost(s, { type: "STABILIZE", patientId: "P" })).toBe(s.emergencyCost);
    expect(s.emergencyCost).toBe(1);
  });

  it("ISOLATE = isolateCost（默认 1 = 一只手）", () => {
    const s = createInitialState(mk({ patients: [pdef("P", { bedId: 1 })] }));
    expect(s.isolateCost).toBe(1);
    expect(actionCost(s, { type: "ISOLATE", patientId: "P" })).toBe(1);
    // 关卡可覆写
    const s2 = createInitialState(
      mk({ patients: [pdef("P", { bedId: 1 })], rules: { isolateCost: 3 } }),
    );
    expect(actionCost(s2, { type: "ISOLATE", patientId: "P" })).toBe(3);
  });

  it("处置只有两档：acuity ≥ 2 走急救档，acuity ≤ 1 走治愈档", () => {
    // 第三档「补救价」（remedyCost）已随不可逆通道一起删除（2026-09-17）——
    // 同一枚 STABILIZE 的价格现在只由 acuity 与谵妄附加费决定，
    // 于是「报价」与「扣费」天然同源，不再需要一条专门的护栏去盯它们分家。
    const s = createInitialState(mk({ patients: [pdef("P", { bedId: 1, acuity: 2 })] }));
    expect(actionCost(s, { type: "STABILIZE", patientId: "P" })).toBe(s.emergencyCost);
    const s2 = createInitialState(mk({ patients: [pdef("P", { bedId: 1, acuity: 1 })] }));
    expect(actionCost(s2, { type: "STABILIZE", patientId: "P" })).toBe(s2.curativeCost);
    expect(s2.emergencyCost).not.toBe(s2.curativeCost);
  });

  it("ap 不够时，对应动作不出现在 legalActions 里", () => {
    // 把 isolateCost 抬到 2：STABILIZE 花掉 1 手后只剩 1 手，付不起隔离
    let s = createInitialState(
      mk({
        patients: [pdef("P", { bedId: 1, acuity: 2 })],
        rules: { isolateCost: 2 },
      }),
    );
    expect(s.ap).toBe(2);
    expect(legalActions(s).some((a) => a.type === "ISOLATE")).toBe(true);
    s = reduce(s, { type: "STABILIZE", patientId: "P" }).state; // ap → 1
    expect(s.ap).toBe(1);
    expect(legalActions(s).some((a) => a.type === "ISOLATE")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
describe("§2.1 出院指征只看 acuity", () => {
  it("acuity = 0 且在床即可出院，与是否挂帘无关", () => {
    const s = createInitialState(mk({ patients: [pdef("P", { bedId: 1, acuity: 0 })] }));
    expect(isBedIsolated(s, 1)).toBe(false);
    expect(canDischarge(s.patients.P)).toBe(true);
  });

  it("acuity > 0 不可出院，哪怕四面都挂上帘", () => {
    const s = createInitialState(mk({ patients: [pdef("P", { bedId: 1, acuity: 1 })] }));
    s.curtains = edgesOfBed(1); // 手动把他围严
    expect(isBedIsolated(s, 1)).toBe(true);
    expect(canDischarge(s.patients.P)).toBe(false);
  });

  it("不在床上不可出院", () => {
    const s = createInitialState(
      mk({ patients: [pdef("P", { bedId: null, acuity: 0 })], arrivals: [] }),
    );
    expect(canDischarge(s.patients.P)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
describe("§4 动作集合里没有 DISCHARGE", () => {
  it("ActionType 不含 DISCHARGE —— 出院是结算不是动作", () => {
    const legal: ActionType[] = ["ADMIT", "SCAN", "STABILIZE", "ISOLATE"];
    expect(legal).not.toContain("DISCHARGE" as ActionType);
  });

  it("对已上线的三关，legalActions 永不产出 DISCHARGE", () => {
    for (const lv of shipped) {
      const s = createInitialState(lv);
      for (const a of legalActions(s)) {
        expect((a as { type: string }).type).not.toBe("DISCHARGE");
      }
      expect(s.enabledActions).not.toContain("DISCHARGE" as ActionType);
    }
  });

  it("伪装成 DISCHARGE 的动作被拒绝，且不扣 AP", () => {
    const s = createInitialState(mk({ patients: [pdef("P", { bedId: 1 })] }));
    const bogus = { type: "DISCHARGE", patientId: "P" } as unknown as PlayerAction;
    const r = reduce(s, bogus);
    expect(r.accepted).toBe(false);
    expect(r.events).toContain("REJECTED_DISABLED");
    expect(r.state.ap).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
describe("§5 干预轴 axisIntervention", () => {
  it("DIRECT：直接处置有效", () => {
    const s = createInitialState(mk({ patients: [pdef("P", { bedId: 1, acuity: 2 })] }));
    const r = reduce(s, { type: "STABILIZE", patientId: "P" });
    expect(r.accepted).toBe(true);
    expect(r.state.patients.P.acuity).toBe(1);
  });

  it("SCAN_FIRST：未检查就处置 = 无效，按档收费，患者不降档，窗口 +1", () => {
    // ap 给 3：acuity 1 属治愈档（2 手），扣完还剩 1 手 ⇒ 回合不结算，可干净地只看这一次动作
    const s = createInitialState(
      mk({ ap: 3, patients: [pdef("P", { bedId: 1, acuity: 1, axis: "SCAN_FIRST" })] }),
    );
    const r = reduce(s, { type: "STABILIZE", patientId: "P" });
    expect(r.accepted).toBe(true);
    expect(
      r.events.some((e) => e.startsWith("STABILIZE_INEFFECTIVE:P:UNSCANNED")),
      `事件里应有 UNSCANNED 归因，实际：${r.events.join(", ")}`,
    ).toBe(true);
    expect(r.state.patients.P.acuity).toBe(1);
    expect(r.state.patients.P.missedStabilizationWindow).toBe(1);
    // 无效处置照样按档收治愈档的 2 手 —— 手花出去了，什么也没换来
    expect(r.state.ap).toBe(1);
  });

  it("SCAN_FIRST：检查之后处置有效", () => {
    const s = createInitialState(
      mk({ ap: 3, patients: [pdef("P", { bedId: 1, acuity: 1, axis: "SCAN_FIRST" })] }),
    );
    const r = reduce(s, { type: "SCAN", patientId: "P" });
    expect(r.state.patients.P.revealed).toContain("riskProfile");
    const r2 = reduce(r.state, { type: "STABILIZE", patientId: "P" });
    expect(r2.state.patients.P.acuity).toBe(0);
    expect(r2.state.ap).toBe(0); // 1(检查) + 2(治愈档)
  });

  it("MIRROR：未检测就处置 = 误诊，当帧判死判负（branch A 也一样，没有赌赢这回事）", () => {
    const s = createInitialState(
      mk({ patients: [pdef("P", { bedId: 1, acuity: 1, axis: "MIRROR", branch: "A" })] }),
    );
    const r = reduce(s, { type: "STABILIZE", patientId: "P" });
    expect(r.accepted).toBe(true);
    expect(r.state.patients.P.alive).toBe(false);
    expect(r.state.outcome).toBe("LOSE");
    expect(r.events).toContain("MISDIAGNOSIS:P:A");
    // 归因必须排在死亡事件**之前**：复盘与贴士按顺序取第一条命中，
    // 顺序反了就会把「你治错了」读成「他没撑住」。
    expect(r.events.indexOf("MISDIAGNOSIS:P:A")).toBeLessThan(
      r.events.findIndex((e) => e.startsWith("DIED:P")),
    );
  });

  it("MIRROR：未检测就处置（branch B）同样当帧判负 —— 失败与分支无关", () => {
    const s = createInitialState(
      mk({ patients: [pdef("P", { bedId: 1, acuity: 1, axis: "MIRROR", branch: "B" })] }),
    );
    const r = reduce(s, { type: "STABILIZE", patientId: "P" });
    expect(r.accepted).toBe(true);
    expect(r.events).toContain("MISDIAGNOSIS:P:B");
    expect(r.state.patients.P.alive).toBe(false);
    expect(r.state.outcome).toBe("LOSE");
    expect(r.state.deaths).toBe(1);
  });

  it("MIRROR：判负当帧结束 —— 不结算回合、不重复打 LOSE、人从床上消失", () => {
    const s = createInitialState(
      mk({ ap: 3, patients: [pdef("P", { bedId: 1, acuity: 1, axis: "MIRROR", branch: "A" })] }),
    );
    const r = reduce(s, { type: "STABILIZE", patientId: "P" });
    expect(r.state.ap).toBe(1); // 3 − 2(治愈档)：还剩一只手，但没有「之后」了
    expect(r.state.turn).toBe(s.turn); // 回合没推进 —— 也不需要推进
    expect(r.events.filter((e) => e === "LOSE")).toHaveLength(1);
    expect(r.state.patients.P.bedId).toBeNull();
    expect(r.state.beds[1]).toBeNull();
  });

  it("MIRROR：检测之后处置 = 自动执行正确方案，必然成功", () => {
    const s = createInitialState(
      mk({ ap: 3, patients: [pdef("P", { bedId: 1, acuity: 1, axis: "MIRROR", branch: "B" })] }),
    );
    const scanned = reduce(s, { type: "SCAN", patientId: "P" });
    expect(scanned.state.patients.P.revealed).toContain("riskProfile");
    const r = reduce(scanned.state, { type: "STABILIZE", patientId: "P" });
    expect(r.accepted).toBe(true);
    expect(r.state.patients.P.acuity).toBe(0);
    expect(r.state.patients.P.alive).toBe(true);
    expect(r.state.outcome).not.toBe("LOSE");
    expect(r.state.ap).toBe(0); // 1(检测) + 2(治愈档)
  });

  it("MIRROR 只产出一个处置（方向由检测结果决定，不由玩家声明）", () => {
    const s = createInitialState(
      mk({ patients: [pdef("P", { bedId: 1, acuity: 1, axis: "MIRROR", branch: "A" })] }),
    );
    const stabs = legalActions(s).filter((a) => a.type === "STABILIZE");
    expect(stabs).toHaveLength(1);
  });

  it("对 DIRECT 患者同样只产出一个处置", () => {
    const s = createInitialState(mk({ patients: [pdef("P", { bedId: 1, acuity: 1 })] }));
    const stabs = legalActions(s).filter((a) => a.type === "STABILIZE");
    expect(stabs).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
describe("§5.3 MISDIAGNOSIS：误诊即刻判死", () => {
  it("误诊的完整事件链：归因在前、死亡在后、最后 LOSE", () => {
    const lv = mk({
      ap: 3,
      patients: [pdef("M", { bedId: 1, acuity: 1, axis: "MIRROR", branch: "B" }), burner()],
    });
    const r = reduce(createInitialState(lv), { type: "STABILIZE", patientId: "M" });
    // 归因排在死亡之前 —— 复盘与贴士都靠这个顺序读死因
    expect(r.events).toContain("MISDIAGNOSIS:M:B");
    expect(r.events.indexOf("MISDIAGNOSIS:M:B")).toBeLessThan(
      r.events.findIndex((e) => e.startsWith("DIED:M")),
    );
    expect(r.events).toContain("LOSE");
    // 陪衬还在床上，但这一局已经结束了：剩下那只手没有任何用处
    expect(r.state.patients.W.alive).toBe(true);
    expect(r.state.ap).toBe(1);
    expect(reduce(r.state, { type: "STABILIZE", patientId: "W" }).accepted).toBe(false);
  });

  it("误诊不依赖回合末结算：不等 ap 归零，人当场就没了", () => {
    const lv = mk({
      ap: 3,
      turns: 6,
      patients: [pdef("M", { bedId: 1, acuity: 1, axis: "MIRROR", branch: "B" }), burner()],
    });
    const s0 = createInitialState(lv);
    const r = reduce(s0, { type: "STABILIZE", patientId: "M" });
    expect(r.state.patients.M.alive).toBe(false);
    expect(r.state.outcome).toBe("LOSE");
    expect(r.state.turn).toBe(s0.turn); // 结算阶段整段没有跑
    expect(r.events.some((e) => e.startsWith("DETERIORATED"))).toBe(false);
  });

  it("没有补救：判负之后再给一次 STABILIZE 也不会把人救回来", () => {
    const lv = mk({
      ap: 99,
      turns: 99,
      patients: [pdef("M", { bedId: 1, acuity: 1, axis: "MIRROR", branch: "B" })],
    });
    const dead = reduce(createInitialState(lv), { type: "STABILIZE", patientId: "M" }).state;
    // 未检测就治是终局。「补救档」已经删掉：玩家的第一选择是重开，不是继续玩
    // （2026-09-17 拍板，见 spec §5.3）。
    const again = reduce(dead, { type: "STABILIZE", patientId: "M" });
    expect(again.accepted).toBe(false);
    expect(again.events).toEqual(["GAME_OVER"]);
  });

  it("代价对照：正确路径 3 手；盲治不是「贵 4 手」，是这一局直接结束", () => {
    // 旧模型（v2 不可逆通道）说「盲治净贵 4 AP」—— 那意味着错一次还能赢回来。
    // 现行模型把这句话换成一句更简单也更有分量的话：**错不起。**
    const base = (branch: MirrorBranch) =>
      mk({ ap: 99, turns: 99, patients: [pdef("P", { bedId: 1, acuity: 1, axis: "MIRROR", branch })] });

    const ap = (lv: LevelDef, acts: PlayerAction[]) => {
      let s = createInitialState(lv);
      let cost = 0;
      for (const a of acts) {
        cost += actionCost(s, a);
        s = reduce(s, a).state;
      }
      return { cost, state: s };
    };

    const scanThenTreat = ap(base("A"), [
      { type: "SCAN", patientId: "P" },
      { type: "STABILIZE", patientId: "P" }, // 自动走对的方向
    ]);
    expect(scanThenTreat.cost).toBe(3); // 1(检测) + 2(治愈档)
    expect(scanThenTreat.state.patients.P.acuity).toBe(0);
    expect(scanThenTreat.state.patients.P.alive).toBe(true);
    expect(scanThenTreat.state.outcome).not.toBe("LOSE");

    for (const branch of ["A", "B"] as MirrorBranch[]) {
      const blind = ap(base(branch), [{ type: "STABILIZE", patientId: "P" }]);
      expect(blind.state.outcome, `${branch} 面盲治`).toBe("LOSE");
      expect(blind.state.patients.P.alive, `${branch} 面盲治`).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────────
describe("§6.1 暴露累积", () => {
  it("剂量：HIGH = 2，LOW = 2（LOW 不再是慢性威胁，一回合同样一步传）", () => {
    const s = createInitialState(
      mk({ patients: [pdef("H", { bedId: 1, transmission: "HIGH" }), pdef("L", { bedId: 5, transmission: "LOW" })] }),
    );
    expect(exposureDose(s.patients.H)).toBe(2);
    expect(exposureDose(s.patients.L)).toBe(2);
  });

  it("源条件由 isTransmitting 统一判定：出院 / 无床者不传播", () => {
    const s = createInitialState(mk({ patients: [pdef("H", { bedId: 1, transmission: "HIGH" })] }));
    expect(isTransmitting(s.patients.H)).toBe(true);
    s.patients.H.bedId = null;
    expect(isTransmitting(s.patients.H)).toBe(false);
  });

  it("挂帘的缝不传，而且**双向**都断", () => {
    const lv = mk({
      ap: 1,
      patients: [
        pdef("SRC", { bedId: 1, transmission: "HIGH", acuity: 1 }),
        pdef("TB", { bedId: 2, acuity: 1 }),
        burner(),
      ],
      rules: { infectionEnabled: true },
    });
    // (a) 1-2 这条缝开着：TB 被 +2
    let s = createInitialState(lv);
    expect(isScreened(s, "1-2")).toBe(false);
    s = reduce(s, { type: "STABILIZE", patientId: "W" }).state;
    expect(s.patients.TB.exposure).toBe(2);

    // (b) 把 1-2 挂上帘 → TB 不再被暴露
    let s2 = createInitialState(lv);
    s2.curtains = ["1-2"];
    s2 = reduce(s2, { type: "STABILIZE", patientId: "W" }).state;
    expect(s2.patients.TB.exposure).toBe(0);

    // (c) 反方向同样被切断：TB 也传不出去
    let s3 = createInitialState(lv);
    s3.curtains = ["1-2"];
    s3.patients.SRC.transmission = "NONE";
    s3.patients.TB.transmission = "HIGH";
    s3 = reduce(s3, { type: "STABILIZE", patientId: "W" }).state;
    expect(s3.patients.SRC.exposure).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
describe("§6.2 暴露升级是阶梯，不是一次性", () => {
  it("ESCALATION_STEP = 2；一个 HIGH 源 → exposure 2 → 升 1 级、1 次感染事件", () => {
    expect(ESCALATION_STEP).toBe(2);
    const lv = mk({
      ap: 1,
      patients: [
        pdef("SRC", { bedId: 1, transmission: "HIGH" }),
        pdef("TB", { bedId: 2, acuity: 1 }),
        burner(),
      ],
      rules: { infectionEnabled: true },
    });
    let s = createInitialState(lv);
    s = reduce(s, { type: "STABILIZE", patientId: "W" }).state;
    expect(s.patients.TB.exposure).toBe(2);
    expect(s.patients.TB.escalations).toBe(1);
    expect(s.infectionEvents).toBe(1);
    expect(s.patients.TB.acuity).toBe(2); // 1 → 2
  });

  it("两个 HIGH 源夹着同一目标 → exposure 4 → 同一次结算连升 2 级、2 次感染事件", () => {
    // 2 号床与 4 号床都是 3 号床的邻床
    const lv = mk({
      ap: 1,
      patients: [
        pdef("A", { bedId: 2, transmission: "HIGH" }),
        pdef("B", { bedId: 4, transmission: "HIGH" }),
        pdef("TB", { bedId: 3, acuity: 1 }),
        // 陪衬放 5 号床：它只挨 1/6，两个 HIGH 源都够不到，
        // 否则它自己也会被 +2 升级，多出第 3 次感染事件，把要观察的计数搅浑
        burner("W", 5),
      ],
      rules: { infectionEnabled: true },
    });
    let s = createInitialState(lv);
    s = reduce(s, { type: "STABILIZE", patientId: "W" }).state;
    expect(s.patients.TB.exposure).toBe(4);
    expect(s.patients.TB.escalations).toBe(2);
    expect(s.infectionEvents).toBe(2);
    expect(s.patients.TB.acuity).toBe(3); // 1 → 3
  });

  it("LOW 源一回合就升一级（B 路线：LOW 与 HIGH 同速）", () => {
    const lv = mk({
      ap: 1,
      turns: 5,
      patients: [
        pdef("SRC", { bedId: 1, transmission: "LOW" }),
        pdef("TB", { bedId: 2, acuity: 1 }),
        burner(),
      ],
      rules: { infectionEnabled: true },
    });
    let s = createInitialState(lv);
    s = reduce(s, { type: "STABILIZE", patientId: "W" }).state; // T1 末
    expect(s.patients.TB.exposure).toBe(2);
    expect(s.patients.TB.escalations).toBe(1);
    expect(s.infectionEvents).toBe(1);
    expect(s.patients.TB.acuity).toBe(2); // 1 → 2
  });
});

// ────────────────────────────────────────────────────────────────
describe("§3 / §6 升级与自然病程同回合互斥", () => {
  it("被暴露升级的患者，当回合不再结算自然恶化", () => {
    // rate = 2：若升级与自然恶化叠加，acuity 1 → 1 +1(升级) +2(恶化) = 4，当场死；
    // 互斥则只有升级生效 → 2。这是能区分两种实现的锐利对照。
    const lv = mk({
      ap: 1,
      patients: [
        pdef("SRC", { bedId: 1, transmission: "HIGH" }),
        pdef("TB", { bedId: 2, acuity: 1, rate: 2 }),
        burner(),
      ],
      rules: { infectionEnabled: true },
    });
    let s = createInitialState(lv);
    s = reduce(s, { type: "STABILIZE", patientId: "W" }).state;
    expect(s.infectionEvents).toBe(1);
    expect(s.patients.TB.acuity).toBe(2);
    expect(s.patients.TB.alive).toBe(true);

    // 对照组：关掉感染，同一个患者只吃自然恶化 → 1 + 2 = 3 → 死
    const lv2 = mk({
      ap: 1,
      patients: [pdef("TB", { bedId: 2, acuity: 1, rate: 2 }), burner()],
    });
    let s2 = createInitialState(lv2);
    s2 = reduce(s2, { type: "STABILIZE", patientId: "W" }).state;
    expect(s2.patients.TB.acuity).toBe(3);
    expect(s2.patients.TB.alive).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
describe("§7 胜负判据", () => {
  it("W1：死一个就判负（maxDeaths = 0）", () => {
    const lv = mk({
      ap: 1,
      patients: [pdef("P", { bedId: 1, acuity: 2, rate: 1 }), burner()],
    });
    let s = createInitialState(lv);
    s = reduce(s, { type: "STABILIZE", patientId: "W" }).state; // P 自然恶化 2 → 3
    expect(s.deaths).toBe(1);
    expect(s.outcome).toBe("LOSE");
  });

  it("W2：requiredDischarges = ALL → 目标 = 全部患者（含未到达者）", () => {
    const lv = mk({
      patients: [pdef("P1", { bedId: 1, acuity: 0 })],
      arrivals: [[pdef("P2", { bedId: null, acuity: 0 })]],
    });
    const s = createInitialState(lv);
    expect(s.totalPatients).toBe(2);
    expect(targetDischarges(s)).toBe(2);
  });

  it("W2：数字目标按数字结账", () => {
    const lv = mk({
      patients: [pdef("P1", { bedId: 1, acuity: 0 })],
      arrivals: [[pdef("P2", { bedId: null, acuity: 0 })]],
      rules: { requiredDischarges: 1 },
    });
    expect(targetDischarges(createInitialState(lv))).toBe(1);
  });

  it("W3：出院本身不消耗 AP（acuity 归零当帧离床）", () => {
    // ap 给 3：治愈档 2 手，扣完还剩 1 手 —— 那 1 手不是出院费，出院是结算不是动作
    const lv = mk({ ap: 3, patients: [pdef("P", { bedId: 1, acuity: 1 })] });
    const s = createInitialState(lv);
    const r = reduce(s, { type: "STABILIZE", patientId: "P" });
    expect(r.state.patients.P.discharged).toBe(true);
    expect(r.state.beds[1]).toBeNull();
    expect(r.state.ap).toBe(1); // 3 − 2(治愈档)，出院没额外收费
  });

  it("感染只计数，不判负（2026-09-18 用户裁决）", () => {
    const lv = mk({
      ap: 1,
      patients: [
        pdef("SRC", { bedId: 1, transmission: "HIGH" }),
        pdef("TB", { bedId: 2, acuity: 1 }),
        burner(),
      ],
      rules: { infectionEnabled: true },
    });
    let s = createInitialState(lv);
    s = reduce(s, { type: "STABILIZE", patientId: "W" }).state;
    expect(s.infectionEvents).toBe(1);
    expect(s.outcome).toBe("ONGOING");
  });
});

// ────────────────────────────────────────────────────────────────
describe("§8 I4：ONGOING 状态下永远有合法动作", () => {
  // 三关串行求解，节点上限 10 万，耗时可达数十秒 —— 超时给到 120s
  it(
    "求解器给出的每条路径上，每个中间状态 legalActions 非空",
    { timeout: 120_000 },
    () => {
      for (const lv of shipped) {
        const r = solveLevel(lv);
        expect(r.solvable, `${lv.id} 应可解`).toBe(true);
        for (let g = 0; g < r.path!.length; g++) {
          const state = replay(lv, r.path!.slice(0, g)).state;
          if (state.outcome !== "ONGOING") continue;
          expect(
            legalActions(state).length,
            `${lv.id} 第 ${g} 步出现无动作死锁`,
          ).toBeGreaterThan(0);
        }
      }
    },
  );
});

// ────────────────────────────────────────────────────────────────
describe("§9 Replay 确定性", () => {
  it(
    "同一 action 序列两次重放终态 deepEqual",
    { timeout: 120_000 },
    () => {
      const r = solveLevel(night02 as unknown as LevelDef);
      const a = replay(night02 as unknown as LevelDef, r.path!).state;
      const b = replay(night02 as unknown as LevelDef, r.path!).state;
      expect(a).toEqual(b);
    },
  );
});

// ────────────────────────────────────────────────────────────────
describe("§6A.1 手卫生：脏手是第二传播向量", () => {
  it("处置 HIGH 源后手被污染；脏手再碰非 HIGH 患者 → 对方 exposure +2 并当回合升级；洗手后停止", () => {
    const s0 = createInitialState(
      mk({
        ap: 9,
        turns: 9,
        actions: ["ADMIT", "SCAN", "STABILIZE", "ISOLATE", "HAND_HYGIENE"],
        rules: { handHygieneEnabled: true },
        patients: [
          pdef("V", { bedId: 1, acuity: 1 }),
          pdef("V2", { bedId: 5, acuity: 1 }),
          pdef("S", { bedId: 8, acuity: 1, transmission: "HIGH" }),
        ],
      }),
    );
    const s1 = reduce(s0, { type: "STABILIZE", patientId: "V" }).state; // 干净手，正常
    const s2 = reduce(s1, { type: "STABILIZE", patientId: "S" }).state; // 治走源 → 手脏
    expect(s2.handState).toBe("CONTAMINATED");
    const r3 = reduce(s2, { type: "STABILIZE", patientId: "V2" }); // 脏手碰 V2
    const s3 = r3.state;
    expect(s3.patients.V2.exposure).toBe(2);
    expect(s3.patients.V2.escalations).toBe(1); // 脏手当场升级，不是慢性攒
    // 顺序是先 touch 后 treat：脏手把 acuity 顶到 2，这一手的治愈又压回 1 ——
    // 升级的事实留在 escalations 与事件流里，不在终态 acuity 上。
    expect(s3.infectionEvents).toBe(1);
    expect(r3.events.some((e) => e.startsWith("HAND_CONTAMINATED:V2"))).toBe(true);
    expect(r3.events).toContain("EXPOSURE_ESCALATE:V2:acuity2");
    const s4 = reduce(s3, { type: "HAND_HYGIENE" }).state;
    expect(s4.handState).toBe("CLEAN");
    const r5 = reduce(s4, { type: "SCAN", patientId: "V2" });
    expect(r5.state.patients.V2.exposure).toBe(2); // 干净手不再传染
  });

  it("handHygieneEnabled=false（缺省）时整块机制关闭", () => {
    const s0 = createInitialState(
      mk({
        patients: [pdef("S", { bedId: 1, acuity: 1, transmission: "HIGH" })],
      }),
    );
    const s1 = reduce(s0, { type: "STABILIZE", patientId: "S" }).state;
    expect(s1.handState).toBe("CLEAN");
    expect(s1.handHygieneEnabled).toBe(false);
  });
});

describe("§6A.2 床单元污染：源走了，床记着他", () => {
  it("HIGH 源出院留 risk 2；入住沾染 exposure+2；回合末衰减", () => {
    const s0 = createInitialState(
      mk({
        ap: 4,
        turns: 9,
        rules: { bedUnitEnabled: true },
        patients: [
          pdef("S", { bedId: 3, acuity: 1, transmission: "HIGH" }),
        ],
        arrivals: [[pdef("Q", { acuity: 1 })]],
      }),
    );
    // Q 在队列里（arrivals wave0 进队列）；先把 S 治走
    const withQ = { ...s0, queue: ["Q"] };
    const s1 = reduce(withQ, { type: "STABILIZE", patientId: "S" }).state;
    expect(s1.patients.S.discharged).toBe(true);
    expect(s1.bedRisk[3]).toBe(2);
    // 收治 Q 到 3 号床 → 立刻吃 2 点暴露
    const r2 = reduce(s1, { type: "ADMIT", bedId: 3 });
    const s2 = r2.state;
    expect(s2.patients.Q.exposure).toBe(2);
    expect(r2.events.some((e) => e.startsWith("BED_UNIT_EXPOSURE"))).toBe(true);
    // ap 恰好烧完（4 − 2 治愈 − 1 收治 − 1 检测）→ 回合结算 → 污染衰减 2 → 1
    const s3 = reduce(s2, { type: "SCAN", patientId: "Q" }).state;
    expect(s3.bedRisk[3]).toBe(1);
  });

  it("bedUnitEnabled=false（缺省）不留污", () => {
    const s0 = createInitialState(
      mk({ patients: [pdef("S", { bedId: 3, acuity: 1, transmission: "HIGH" })] }),
    );
    const s1 = reduce(s0, { type: "STABILIZE", patientId: "S" }).state;
    expect(s1.bedRisk[3] ?? 0).toBe(0);
  });
});

describe("§6A.3 谵妄：邻床处置 +1 手", () => {
  it("谵妄患者在床时，相邻床的处置多花 1 手；他走了就恢复", () => {
    const s0 = createInitialState(
      mk({
        ap: 9,
        turns: 9,
        patients: [
          pdef("V", { bedId: 1, acuity: 1 }),
          pdef("D", { bedId: 2, acuity: 1, disruptive: true }),
        ],
      }),
    );
    expect(stabilizeCost(s0, s0.patients.V)).toBe(3); // 治愈 2 + 谵妄 1
    // 治好谵妄患者 → 干扰解除
    const s1 = reduce(s0, { type: "STABILIZE", patientId: "D" }).state;
    expect(s1.patients.D.discharged).toBe(true);
    expect(stabilizeCost(s1, s1.patients.V)).toBe(2);
  });

  it("不相邻的谵妄患者不加价", () => {
    const s0 = createInitialState(
      mk({
        patients: [
          pdef("V", { bedId: 1, acuity: 1 }),
          pdef("D", { bedId: 8, acuity: 1, disruptive: true }),
        ],
      }),
    );
    expect(stabilizeCost(s0, s0.patients.V)).toBe(2);
  });
});

describe("§6A.4 时间窗与后遗症", () => {
  it("窗口归零 → WINDOW_CLOSED：带后遗症自动离床，sequelaCount +1", () => {
    const s0 = createInitialState(
      mk({
        ap: 9,
        turns: 9,
        rules: { sequelaLimit: 0 },
        patients: [pdef("T", { bedId: 1, acuity: 1, timeWindow: 1 })],
      }),
    );
    expect(s0.patients.T.windowClock).toBe(1);
    // 烧手推进回合（acuity 1 处置 2 手会直接出院，改用 SCAN 烧）
    let s = reduce(s0, { type: "SCAN", patientId: "T" }).state; // ap 8，未归零
    // 用合法动作把 ap 烧到 0：对他反复 SCAN（revealOrder 3 项后 REJECTED —— 用隔离铺满代替）
    s = reduce(s, { type: "ISOLATE", patientId: "T" }).state; // ap 7
    // 直接以非法动作触发不了回合 —— 改为验证：legalActions 为空时回合自动结算
    // 此处用一个 acuity 0 的陪衬不可行；改用「合法动作烧完」：
    // 简化：replay 三个 SCAN 后 ap=7，回合不推进 —— 用 HAND 不可用。
    // 最直接：把 ap 调低重跑本用例太啰嗦 —— 这里接受「不推进」路径，单独验证 tick：
    void s;
    // —— 用直接构造验证窗口结算 ——
    const lv = mk({
      ap: 1,
      turns: 9,
      rules: { sequelaLimit: 0 },
      patients: [pdef("T2", { bedId: 1, acuity: 1, timeWindow: 1 })],
    });
    const st0 = createInitialState(lv);
    const r1 = reduce(st0, { type: "ISOLATE", patientId: "T2" }); // 1 手 → ap 0 → 回合结算
    const st1 = r1.state;
    expect(r1.events.some((e) => e === "WINDOW_CLOSED:T2")).toBe(true);
    expect(st1.patients.T2.sequela).toBe(true);
    expect(st1.patients.T2.discharged).toBe(true);
    expect(st1.sequelaCount).toBe(1);
    expect(st1.outcome).toBe("LOSE"); // sequelaLimit 0 被突破
  });
});

describe("§6A.5 队列压力", () => {
  it("走廊超员：回合末等候者集体额外恶化一档", () => {
    const s0 = createInitialState(
      mk({
        ap: 1,
        turns: 9,
        rules: { queueLimit: 1, corridorGraceTurns: 0 },
        patients: [pdef("W", { bedId: 8, acuity: 2 })],
        arrivals: [[pdef("Q1", { acuity: 1 }), pdef("Q2", { acuity: 1 })]],
      }),
    );
    expect(s0.queue.length).toBe(2); // 超员（限 1）
    // 烧 1 手推进回合（急救档陪衬）
    const r1 = reduce(s0, { type: "STABILIZE", patientId: "W" });
    const s1 = r1.state;
    expect(r1.events.some((e) => e.startsWith("QUEUE_PRESSURE:Q1"))).toBe(true);
    expect(r1.events.some((e) => e.startsWith("QUEUE_PRESSURE:Q2"))).toBe(true);
    expect(s1.patients.Q1.acuity).toBe(2); // 1 + 压力 1（rate 0）
    expect(s1.patients.Q2.acuity).toBe(2);
  });
});
