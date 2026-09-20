import { describe, expect, it } from "vitest";
import night02 from "../levels/night-02.json";
import { reduce } from "../src/core/reducer";
import { replay } from "../src/core/replay";
import { canDischarge, dischargedCount, isBedIsolated } from "../src/core/rules";
import { createInitialState } from "../src/core/state";
import { solve } from "../src/solver";
import type { LevelDef } from "../src/core/types";
import { GOLDEN, NIGHT02_DESIGN as D } from "./golden";

const level = night02 as unknown as LevelDef;
const gold = GOLDEN["night-02"];

/**
 * 求解缓存 + 节点上限：这一关搜索量最大。
 * 上限压在 15 万是**内存护栏**（曾因并行跑大堆进程把 swap 吃到 20G+）。
 * A* 启发式可采纳，找到的第一个解即最优，故不影响 minAP 的正确性。
 */
const cache = new Map<string, ReturnType<typeof solve>>();
function solved(lv: LevelDef) {
  const key = `${lv.id}|${lv.enabledActions.join(",")}|${lv.turns}`;
  let r = cache.get(key);
  if (!r) {
    r = solve(lv, { maxNodes: 150_000 });
    cache.set(key, r);
  }
  return r;
}

const withoutIsolate: LevelDef = {
  ...level,
  enabledActions: level.enabledActions.filter((a) => a !== "ISOLATE"),
};

describe("night-02「邻床」—— 基本成立", () => {
  it("最优解把 7 个人全部送走，零死亡", () => {
    const r = solved(level);
    expect(r.solvable).toBe(true);

    const { state, log } = replay(level, r.path!);
    expect(log.every((e) => e.accepted)).toBe(true);
    expect(dischargedCount(state)).toBe(gold.discharged);
    expect(dischargedCount(state)).toBe(state.totalPatients);
    expect(state.deaths).toBe(0);
    expect(state.infectionEvents).toBe(gold.infections);
    expect(state.outcome).toBe("WIN");
  });

  it("治愈档要两只手，所以 minAP 大于动作数", () => {
    const r = solved(level);
    // 每个动作基础 1 手，只有**治愈档**多收 1 手（Contract §4.1）。
    // 每个病人恰好要被治愈一次才出院 ⇒ minAP − 动作数 = 出院人数。
    expect(r.minAP! - r.path!.length).toBeGreaterThan(0);
    expect(r.minAP! - r.path!.length).toBe(gold.discharged);
  });
});

describe("设计闸门：隔离是最优解的第一反应（2026-09-18 新命题）", () => {
  it("G1 允许隔离时 27 AP 可解，且最优解真的用了隔离", () => {
    const r = solved(level);
    expect(r.solvable).toBe(true);
    expect(r.minAP).toBe(D.withIsolateMinAP);
    expect(r.slack).toBe(D.withIsolateSlack);
    const isolates = r.path?.filter((a) => a.type === "ISOLATE").length ?? 0;
    expect(isolates).toBe(D.withIsolateCount);
  });

  /**
   * G2 —— 禁用隔离后无解：这是「机制引入即持续复用」的机器化证据
   * （2026-09-18 用户裁决：隔离自 02 起必用；感染预算判负同步废除）。
   *
   * 旧命题「隔离不是必做项」建立在 LOW 源两回合传染的宽限上；
   * 剂量统一为 2 后硬扛线被击穿，隔离成为管住源的第一反应。
   */
  it("G2 物理禁用隔离按钮后无解", () => {
    const hard = solved(withoutIsolate);
    expect(hard.solvable, "禁用隔离后仍可解 = 复用命题被击穿").toBe(false);
  });

  it("源是 LOW —— 剂量统一后它同样一回合传染", () => {
    expect(D.sourceTransmission).toBe("LOW");
  });
});

describe("没有必做项（§2.1 / §4）", () => {
  it("出院只看 acuity，不看床四周挂没挂帘", () => {
    const s = createInitialState(level);
    expect(isBedIsolated(s, 3)).toBe(false);
    s.patients.D01.acuity = 0;
    expect(canDischarge(s.patients.D01)).toBe(true);
  });

  it("隔离是纯支出：它不降 acuity，只把缝挂上帘", () => {
    const s = createInitialState(level);
    const before = s.patients.D01.acuity;
    const r = reduce(s, { type: "ISOLATE", patientId: "D01" });
    expect(r.state.patients.D01.acuity).toBe(before);
    expect(isBedIsolated(r.state, 3)).toBe(true);
  });
});

describe("传播的可追溯性", () => {
  /** 花光一整回合（3 手）但不碰源与邻床 —— 让暴露自然结算。 */
  function idleTurn() {
    let s = createInitialState(level);
    s = reduce(s, { type: "ADMIT", bedId: 1 }).state; // 收治 K01
    s = reduce(s, { type: "SCAN", patientId: "D01" }).state;
    s = reduce(s, { type: "SCAN", patientId: "G01" }).state; // 花光第三只手 → 结算
    return s;
  }

  it("不作为一回合末：射程内的邻床全部被暴露，没人豁免 —— H01 当场被推死", () => {
    const s = idleTurn();
    // G01@4 与 E01@7 在 D01 的射程内
    for (const id of ["G01", "E01"]) {
      expect(s.patients[id].exposure, `${id} 应被暴露`).toBeGreaterThan(0);
      expect(s.patients[id].alive).toBe(true);
    }
    // H01@2（镜像，acuity 2）同样在射程内：+2 暴露 = 当场加重到 3 级死亡。
    // 布景帘废除后开局无人受保护 —— 这正是「第一反应必须是围源」的代价面。
    expect(s.patients.H01.exposure).toBe(2);
    expect(s.patients.H01.alive).toBe(false);
    expect(s.outcome).toBe("LOSE");
  });

  it("隔离源之后，射程内的邻床一回合末零暴露", () => {
    let s = createInitialState(level);
    s = reduce(s, { type: "ISOLATE", patientId: "D01" }).state;
    s = reduce(s, { type: "SCAN", patientId: "G01" }).state;
    s = reduce(s, { type: "SCAN", patientId: "E01" }).state; // 花光 → 结算
    expect(s.patients.G01.exposure).toBe(0);
    expect(s.patients.E01.exposure).toBe(0);
    expect(s.infectionEvents).toBe(0);
  });
});
