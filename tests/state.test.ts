import { describe, expect, it } from "vitest";
import night00 from "../levels/night-00.json";
import night02 from "../levels/night-02.json";
import night04 from "../levels/night-04.json";
import { applyArrival, cloneState, createInitialState, countTotalPatients } from "../src/core/state";
import { allEdges, isBedIsolated, legalActions, neighbors, nextAdmittable } from "../src/core/rules";
import { reduce } from "../src/core/reducer";
import type { LevelDef } from "../src/core/types";
import { GOLDEN } from "./golden";

const level = night00 as unknown as LevelDef;

describe("拓扑", () => {
  it("8 床病房图与契约 §1 一致（2×4 满邻接）", () => {
    expect(neighbors(1)).toEqual([2, 5]);
    expect(neighbors(2)).toEqual([1, 3, 6]);
    expect(neighbors(3)).toEqual([2, 4, 7]);
    expect(neighbors(4)).toEqual([3, 8]);
    expect(neighbors(5)).toEqual([1, 6]);
    expect(neighbors(6)).toEqual([2, 5, 7]);
    expect(neighbors(7)).toEqual([3, 6, 8]);
    expect(neighbors(8)).toEqual([4, 7]);
  });

  it("边集共 10 条且无向对称", () => {
    expect(allEdges()).toHaveLength(10);
    for (const [a, b] of allEdges()) {
      expect(neighbors(a)).toContain(b);
      expect(neighbors(b)).toContain(a);
    }
  });
});

describe("createInitialState night-00", () => {
  it("把 A01 放在 1 号床（红灯 acuity 2），A02 在走廊", () => {
    const s = createInitialState(level);
    expect(s.patients.A01.bedId).toBe(1);
    expect(s.patients.A01.acuity).toBe(2);
    // 契约 §2：A01 是「血一直在流」—— 进行性措辞，所以 deteriorationRate 必须 > 0
    expect(s.patients.A01.deteriorationRate).toBe(2);
    expect(s.patients.A01.transmission).toBe("NONE");
    expect(s.patients.A01.axisIntervention).toBe("DIRECT");
    expect(s.queue).toEqual(["A02"]);
    expect(s.turn).toBe(1);
    expect(s.ap).toBe(3); // 每回合 3 手（分档定价后的全局改动，见 12-HAND-ECONOMY.md）
    expect(s.outcome).toBe("ONGOING");
  });

  it("病例卡字段齐备：患者原话 / 体征 / 关键线索，且原话不含病名", () => {
    const s = createInitialState(level);
    const a01 = s.patients.A01;
    expect(a01.utterance.length).toBeGreaterThan(0);
    expect(a01.utterance).not.toBe(a01.chiefComplaint); // 有专属原话
    expect(a01.vitals.length).toBeGreaterThanOrEqual(3);
    expect(a01.keyClue.length).toBeGreaterThan(0);
    // 原话是第一人称口语，不是诊断名（教学关的设计约束）
    expect(a01.utterance).toMatch(/我|一直|止不住|忽然|起来/);
  });

  it("totalPatients 计入尚未到达的患者", () => {
    const s = createInitialState(level);
    expect(s.totalPatients).toBe(4); // A01 + A02/A03/A04
    expect(Object.keys(s.patients)).toHaveLength(2); // 此刻 A01 在床、A02 在走廊
    expect(countTotalPatients(level)).toBe(GOLDEN["night-00"].totalPatients);
  });

  it("隔离参数：night-00 不开启感染，也没有隔离动作", () => {
    const s = createInitialState(level);
    expect(s.infectionEnabled).toBe(false);
    expect(s.enabledActions).not.toContain("ISOLATE");
  });
});

describe("night-02 初始盘面", () => {
  const s = createInitialState(night02 as unknown as LevelDef);

  it("传染源在 3 号床，三个邻床 2 / 4 / 7 各有一位患者", () => {
    expect(s.beds[3]).toBe("D01");
    expect(s.beds[2]).toBe("H01");
    expect(s.beds[4]).toBe("G01");
    expect(s.beds[7]).toBe("E01");
    // 源是 **LOW**（重配平后）：这是 G2「禁用隔离仍可解」能成立的前提 ——
    // HIGH 源会在 T2 末把两个 ac1 邻床同时顶到 acuity 3，那时除了隔离别无解，
    // 隔离就变成必做项了。夜班二的慢性威胁感来自「每回合都欠着」，不是来自剂量。
    expect(s.patients.D01.transmission).toBe("LOW");
  });

  it("邻床恰好是 3 号床的传播对象（拓扑与传播同源）", () => {
    expect(neighbors(3)).toEqual([2, 4, 7]);
    for (const bed of [2, 4, 7]) {
      expect(s.patients[s.beds[bed]!].transmission).toBe("NONE");
    }
  });

  it("感染预算是 3，隔离只要一只手", () => {
    expect(s.isolateCost).toBe(1);
  });

  it("开局没有任何帘 —— 帘就是隔离本身（2026-09-18 最终裁定）", () => {
    expect(s.curtains).toEqual([]);
    expect(s.isolatedBedId).toBeNull();
    expect(isBedIsolated(s, 3)).toBe(false);
  });
});

/**
 * 走廊到达的回归 —— 2026-09-18 用户裁定：到达即入床是异常行为（「走廊的病人怎么
 * 变成自动收治了」）。night-04 的 S01 曾在关卡 JSON 里预分配床位（`state.bedId`），
 * 到达时凭空落在 4 号床，玩家没花收治的手。现在 S01 一律进走廊，收不收、收去哪张床
 * 由玩家决定。历史上这里另有一个真 bug：带床位的到达者被 `applyArrival` 同时推进
 * 走廊队列（一个人两张位置），求解器被迫多花一手「收治幽灵」—— 下面的幽灵用例把它钉死。
 */
describe("走廊到达（幽灵床位回归）", () => {
  const lv = night04 as unknown as LevelDef;

  it("S01 到达进走廊，不预分配床位", () => {
    const s = createInitialState(lv);
    applyArrival(s, 1, s.arrivalSchedule); // T2 批次：S01
    expect(s.patients.S01.bedId).toBeNull();
    expect(s.beds[4]).toBeNull();
    expect(s.queue).toEqual(["S01"]);
  });

  it("队列里的幽灵条目不会被 ADMIT 放到床上，也不该出现在合法动作里", () => {
    const s = createInitialState(lv);
    s.queue.push("S01"); // 手工注入幽灵（模拟旧存档 / 未来的清理疏漏）
    expect(nextAdmittable(s)).toBeUndefined();
    expect(legalActions(s).some((a) => a.type === "ADMIT")).toBe(false);

    const res = reduce(s, { type: "ADMIT", bedId: 5 });
    expect(res.accepted).toBe(false);
    expect(res.state.beds[5]).toBeNull();
  });

  it("真的有人在走廊时，ADMIT 依然正常工作", () => {
    const s = createInitialState(lv);
    applyArrival(s, 3, s.arrivalSchedule); // T4 批次：H02，无预设床位 → 走廊
    expect(s.queue).toEqual(["H02"]);
    expect(nextAdmittable(s)).toBe("H02");
    const res = reduce(s, { type: "ADMIT", bedId: 4 });
    expect(res.accepted).toBe(true);
    expect(res.state.beds[4]).toBe("H02");
    expect(res.state.queue).toHaveLength(0);
  });
});

/**
 * `cloneState` 是 `reduce` 的第一步，也是求解器 95% 的时间都花在那里的地方，
 * 所以用**手写快拷**取代了 `structuredClone`（快一个数量级）。
 * 手写拷贝的代价是：**给 Patient 加字段而忘了在这里登记 = 静默丢状态**。
 * 下面两条断言就是那颗地雷的探雷器。
 */
describe("快速克隆 ≡ structuredClone", () => {
  it("对每个状态，手写拷贝与通用深拷贝逐字段相等", () => {
    for (const lv of [level, night02 as unknown as LevelDef]) {
      const s = createInitialState(lv);
      expect(cloneState(s)).toEqual(structuredClone(s));
    }
  });

  it("拷贝出来的东西改了不影响原物（引用类型字段没有漏网）", () => {
    const s = createInitialState(night02 as unknown as LevelDef);
    const c = cloneState(s);

    c.curtains.push("9-9");
    c.queue.push("GHOST");
    c.patients.D01.acuity = 99;
    c.patients.D01.revealed.push("disposition");
    c.patients.D01.hidden.injected = "x";
    c.patients.D01.vitals.push({ label: "L", value: "V" });
    c.beds[1] = "GHOST";

    expect(s.curtains).not.toContain("9-9");
    expect(s.queue).not.toContain("GHOST");
    expect(s.patients.D01.acuity).not.toBe(99);
    expect(s.patients.D01.revealed).not.toContain("disposition");
    expect(s.patients.D01.hidden.injected).toBeUndefined();
    expect(s.patients.D01.vitals.some((v) => v.label === "L")).toBe(false);
    expect(s.beds[1]).not.toBe("GHOST");
    expect(c.history).toEqual(s.history); // history 浅拷贝：内容一致，元素共享不影响正确性
  });
});
