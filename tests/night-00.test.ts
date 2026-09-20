import { describe, expect, it } from "vitest";
import night00 from "../levels/night-00.json";
import { replay } from "../src/core/replay";
import { dischargedCount } from "../src/core/rules";
import { solve } from "../src/solver";
import type { LevelDef } from "../src/core/types";
import { GOLDEN } from "./golden";

const level = night00 as unknown as LevelDef;
const gold = GOLDEN["night-00"];

/** 求解一次并缓存：多组断言共用同一份结果，避免重复搜索拖慢套件 */
const solved = solve(level, { maxNodes: 100_000 });

describe("night-00「交班」", () => {
  it("最优解把 4 个人全部送走，零死亡", () => {
    const { state, log } = replay(level, solved.path!);
    expect(log.every((r) => r.accepted)).toBe(true);
    expect(dischargedCount(state)).toBe(gold.discharged);
    expect(dischargedCount(state)).toBe(state.totalPatients);
    expect(state.deaths).toBe(0);
    expect(state.outcome).toBe("WIN");
  });

  it("零余量：最小解打满全部 AP，没有第九步", () => {
    expect(solved.minAP).toBe(level.turns * level.actionPoints);
    expect(solved.minAP).toBe(gold.minAP);
    expect(solved.slack).toBe(0);
    // 少走一步就走不完
    const oneShort = replay(level, solved.path!.slice(0, -1));
    expect(oneShort.state.outcome).not.toBe("WIN");
    expect(dischargedCount(oneShort.state)).toBe(gold.discharged - 1);
  });

  it("这一关不涉及传播，最小 AP 里没有隔离", () => {
    expect(solved.path!.some((a) => a.type === "ISOLATE")).toBe(false);
    expect(gold.isolates).toBe(0);
    expect(solved.exhausted).toBe(true);
  });
});

describe("自动出院（W3）", () => {
  it("患者一进绿灯当帧离床", () => {
    const { state } = replay(level, [
      { type: "STABILIZE", patientId: "A01" },
      { type: "STABILIZE", patientId: "A01" },
    ]);
    expect(state.patients.A01.discharged).toBe(true);
    expect(state.patients.A01.acuity).toBe(0);
    expect(state.beds[1]).toBeNull();
  });

  it("出院本身不收费：收治 + 处置各 1 AP 就够，患者已经走了", () => {
    const { state } = replay(level, [
      { type: "STABILIZE", patientId: "A01" },
      { type: "STABILIZE", patientId: "A01" },
      { type: "ADMIT", bedId: 2 },
      { type: "STABILIZE", patientId: "A02" },
    ]);
    // 第 3、4 步一个回合只有 2 AP；若出院还收 1 AP，A02 走不成
    expect(state.patients.A02.discharged).toBe(true);
    expect(state.beds[2]).toBeNull();
  });

  it("没到绿灯绝不离床", () => {
    const { state } = replay(level, [{ type: "STABILIZE", patientId: "A01" }]);
    expect(state.patients.A01.acuity).toBe(1);
    expect(state.patients.A01.discharged).toBe(false);
    expect(state.beds[1]).toBe("A01");
  });

  it("动作列表里永远没有 DISCHARGE", () => {
    const { state } = replay(level, []);
    expect(state.enabledActions).not.toContain("DISCHARGE");
  });
});

describe("病理时钟", () => {
  it("不处理的 A01 会自然后果 —— 他 rate 2，一回合不动就到 4", () => {
    // rate 2 意味着「按住不放」这条策略在这一关是死的
    const { state } = replay(level, [
      { type: "ADMIT", bedId: 2 },
      { type: "STABILIZE", patientId: "A02" },
    ]);
    expect(state.patients.A01.alive).toBe(false); // 2 → 4 → ≥3 死亡
    expect(state.outcome).toBe("LOSE");
  });
});
