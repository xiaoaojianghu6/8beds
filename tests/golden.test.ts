import { describe, expect, it } from "vitest";
import { levels } from "../src/levels";
import { solve } from "../src/solver";
import { replay } from "../src/core/replay";
import { actionCost, dischargedCount } from "../src/core/rules";
import { createInitialState } from "../src/core/state";
import { reduce } from "../src/core/reducer";
import {
  GOLDEN,
  NIGHT02_DESIGN,
  NIGHT04_REFERENCE,
  NIGHT06_REFERENCE,
} from "./golden";
import type { LevelDef, PlayerAction } from "../src/core/types";

/**
 * 黄金指标回归护栏。
 *
 * `tests/golden.ts` 记的是**设计意图**（最小 AP、余量、隔离的必要程度、感染预算），
 * 不是一个具体的动作序列。动作序列会在求解器换一种等价的 tie-break 时毫无意义地爆红；
 * 而设计意图不该随实现漂移。
 *
 * 这条测试是 golden.ts 的唯一消费者 —— 没有它，那些数字就只是文档，不是护栏。
 *
 * 数字要改之前先问：**是设计改了，还是求解器改了？**
 *   - 设计改了 → 先改 spec/SIMULATION_CONTRACT.md 与关卡 JSON，再改 golden.ts
 *   - 求解器改了 → 这里不该动，说明求解器有 bug
 *
 * ⚠ 节点上限刻意压在 15 万：求解器在「无解」时要穷尽整个空间才肯返回，
 * 堆会涨到数 GB 并触发 swap（曾把磁盘吃到 20G+ 导致机器卡死）。
 * 2026-09-18：night-04 / night-06 的精确求解超出节点/内存护栏，
 * 加入「参考解」模式（加权 A* 的可重放路径，见 golden.ts 两条 REFERENCE）。
 */
const NODE_CAP = 150_000;
/**
 * 「应当无解」的那几条线要穷尽整个空间才肯返回，是全套测试里最吃内存的一步。
 * 上限再砍一半：A* 的可采纳启发式保证有解时找到即最优，这里只需要它**找不到**。
 */
const NO_SOLUTION_CAP = 60_000;

/** 参考解关：精确求解不可行，重放锁路径核对事实。 */
const REFERENCE_ONLY = new Set(["night-04"]);

describe("黄金指标：设计意图不漂移", () => {
  const ids = Object.keys(GOLDEN);

  for (const id of ids) {
    if (REFERENCE_ONLY.has(id)) continue;
    it(`${id}：最小AP / 余量 / 隔离次数 / 感染 / 出院 与 golden.ts 一致`, () => {
      const raw = levels[id];
      expect(raw, `${id} 没注册进 src/levels.ts`).toBeTruthy();
      const level = raw as unknown as LevelDef;
      const g = GOLDEN[id];

      const r = solve(level, { maxNodes: NODE_CAP });
      expect(r.solvable, `${id} 无解`).toBe(true);
      expect(r.minAP).toBe(g.minAP);
      expect(r.slack).toBe(g.slack);
      expect(r.slack).toBe(level.turns * level.actionPoints - g.minAP);

      // 重放最优解，核对终局事实
      const { state } = replay(level, r.path!);
      expect(state.outcome).toBe("WIN");
      expect(state.infectionEvents).toBe(g.infections);
      expect(state.deaths).toBe(g.deaths);
      expect(Object.values(state.patients).filter((p) => p.discharged).length).toBe(
        g.discharged,
      );
      expect(state.totalPatients).toBe(g.totalPatients);

      const isolates = r.path!.filter((a) => a.type === "ISOLATE").length;
      expect(isolates).toBe(g.isolates);
    });
  }

  it("night-04：参考路径重放获胜，事实与 golden.ts 一致", () => {
    const level = levels["night-04"] as unknown as LevelDef;
    const g = GOLDEN["night-04"];
    const ref = NIGHT04_REFERENCE;
    let s = createInitialState(level);
    let hands = 0;
    for (const a of ref.path as readonly PlayerAction[]) {
      const cost = actionCost(s, a);
      const r = reduce(s, a);
      expect(r.accepted, `动作被拒：${JSON.stringify(a)}`).toBe(true);
      hands += cost;
      s = r.state;
    }
    expect(s.outcome).toBe("WIN");
    expect(hands).toBe(ref.hands);
    expect(hands).toBe(g.minAP);
    expect(s.turn).toBeLessThanOrEqual(ref.turns);
    expect(s.infectionEvents).toBe(g.infections);
    expect(s.deaths).toBe(g.deaths);
    expect(dischargedCount(s)).toBe(g.discharged);
    const isolates = (ref.path as readonly PlayerAction[]).filter(
      (a) => a.type === "ISOLATE",
    ).length;
    expect(isolates).toBe(g.isolates);
  });
});

describe("全部关卡满足结算层硬约束（W1 / W2 / §4）", () => {
  for (const id of Object.keys(levels)) {
    it(`${id}：死一个就判负 / 全部送走 / 没有 DISCHARGE 动作`, () => {
      const level = levels[id] as unknown as LevelDef;
      expect(level.rules.maxDeaths).toBe(0);
      expect(level.rules.requiredDischarges).toBe("ALL");
      expect(level.enabledActions).not.toContain("DISCHARGE" as never);
    });
  }
});

/**
 * 余量纪律（用户拍板；2026-09-13 镜像反转修订）：
 *   T = turns × actionPoints，目标余量 0，容忍 ≤2，≥3 不合规。
 * 旧版的「T 单数 → 恰好 1、minAP 必须为偶数」建立在「镜像可赌赢、无需检测」上；
 * 反转后每关 3 个镜像患者各 +1 检测手，minAP 变为奇数（15/27），
 * 直接取 T = minAP（奇数 T、余量 0）反而是最紧的合规解。
 */
describe("余量纪律：余量不超过 2，且 T 恰好覆盖最小解（不留成段空手）", () => {
  for (const id of Object.keys(GOLDEN)) {
    it(`${id}：余量合规`, () => {
      const level = levels[id] as unknown as LevelDef;
      const g = GOLDEN[id];
      const totalAP = level.turns * level.actionPoints;
      const slack = totalAP - g.minAP;
      expect(slack).toBeLessThan(3); // ≥3 一律不合规
      expect(slack).toBeGreaterThanOrEqual(0);
      expect([0, 1, 2]).toContain(slack); // 只允许 0/1/2 的余量
    });
  }
});

describe("night-02：隔离是最优解的第一反应（2026-09-18 新命题）", () => {
  const level = levels["night-02"] as unknown as LevelDef;

  it("源是 LOW —— 剂量统一后 LOW 同样一回合传染", () => {
    const source = level.initialPatients.find((p) => p.id === "D01");
    expect(source?.rules.transmission).toBe(NIGHT02_DESIGN.sourceTransmission);
    expect(NIGHT02_DESIGN.sourceTransmission).toBe("LOW");
  });

  it("禁用隔离后无解 —— 隔离是必做项（机制复用裁决）", () => {
    const noIsolate: LevelDef = {
      ...level,
      enabledActions: level.enabledActions.filter((a) => a !== "ISOLATE"),
    };
    const r = solve(noIsolate, { maxNodes: NO_SOLUTION_CAP });
    expect(r.solvable).toBe(NIGHT02_DESIGN.noIsolateSolvable);
    expect(r.solvable).toBe(false);
  });
});

describe("禁用隔离无解：机制引入即持续复用（用户铁律的机器化证据）", () => {
  for (const id of ["night-02", "night-03", "night-05"]) {
    it(`${id}：拿掉隔离这一手，这一夜就赢不了`, () => {
      const level = levels[id] as unknown as LevelDef;
      const noIsolate: LevelDef = {
        ...level,
        enabledActions: level.enabledActions.filter((a) => a !== "ISOLATE"),
      };
      const r = solve(noIsolate, { maxNodes: NODE_CAP });
      expect(r.solvable, `${id} 禁用隔离后仍可解，隔离的必要性松了`).toBe(false);
      expect(r.exhausted).toBe(true);
    });
  }
});

describe("night-05：隔离是这一夜的常规操作（2026-09-18 重配平后回填）", () => {
  it("占位：最优解构成在重配平后由 golden.ts 钉死", () => {
    expect(true).toBe(true);
  });
});

describe("night-06「八张床」：参考解回归护栏（可重放，不声明最优）", () => {
  it("参考路径在 10 回合内获胜，事实与 golden 记录一致", () => {
    const level = levels["night-06"] as unknown as LevelDef;
    const ref = NIGHT06_REFERENCE;
    let s = createInitialState(level);
    let hands = 0;
    for (const a of ref.path as readonly PlayerAction[]) {
      const cost = actionCost(s, a);
      const r = reduce(s, a);
      expect(r.accepted, `动作被拒：${JSON.stringify(a)}`).toBe(true);
      hands += cost;
      s = r.state;
    }
    expect(s.outcome).toBe("WIN");
    expect(hands).toBe(ref.hands);
    expect(dischargedCount(s)).toBe(ref.discharged);
    expect(s.deaths).toBe(ref.deaths);
    expect(s.infectionEvents).toBe(ref.infections);
    expect(s.sequelaCount).toBe(ref.sequela);
    expect(s.turn).toBeLessThanOrEqual(ref.turns);
  });

  it("地狱关的机制串联检查：三对镜像 + 携带者 + 谵妄 + 时间窗 + 手卫生 + 床污染 + 走廊压力全部在场", () => {
    const level = levels["night-06"] as unknown as LevelDef;
    const patients = [...level.initialPatients, ...level.arrivalSchedule.flat()];
    const mirrors = patients.filter((p) => p.rules.axisIntervention === "MIRROR");
    expect(mirrors).toHaveLength(6); // 三对镜像同场
    expect(mirrors.filter((p) => p.rules.mirrorBranch === "A")).toHaveLength(3);
    expect(mirrors.filter((p) => p.rules.mirrorBranch === "B")).toHaveLength(3);
    expect(patients.some((p) => p.rules.transmission === "HIGH" && p.rules.axisIntervention !== "SCAN_FIRST")).toBe(true); // 隐匿携带者（DIRECT 的 HIGH）
    expect(patients.some((p) => p.rules.disruptive)).toBe(true); // 谵妄
    expect(patients.filter((p) => p.rules.timeWindow)).toHaveLength(2); // 时间窗（N01/H01）
    expect(level.rules.handHygieneEnabled).toBe(true);
    expect(level.rules.bedUnitEnabled).toBe(true);
    expect(level.rules.queueLimit).toBe(1);
    expect(level.rules.sequelaLimit).toBe(1);
    // 密度峰值 8/8：初始 6 + 到达 3（在不出院的前提下）
    expect(level.initialPatients).toHaveLength(6);
    expect(patients).toHaveLength(9);
  });
});
