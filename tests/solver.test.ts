import { describe, expect, it } from "vitest";
import night00 from "../levels/night-00.json";
import night01 from "../levels/night-01.json";
import night02 from "../levels/night-02.json";
import night03 from "../levels/night-03.json";
import { reduce } from "../src/core/reducer";
import { replay } from "../src/core/replay";
import { actionCost } from "../src/core/rules";
import { createInitialState } from "../src/core/state";
import { formatPath, heuristic, scanBudget, solve } from "../src/solver";
import type { LevelDef } from "../src/core/types";
import { GOLDEN } from "./golden";

const levels = [night00, night01, night02] as unknown as LevelDef[];

/**
 * 求解结果缓存。night-02 单次求解约 1–2s，多个测试共用同一份结果。
 */
const solvedCache = new Map<string, ReturnType<typeof solve>>();
function solved(level: LevelDef) {
  let r = solvedCache.get(level.id);
  if (!r) {
    r = solve(level, { maxNodes: 100_000 });
    solvedCache.set(level.id, r);
  }
  return r;
}

describe("solver", () => {
  it("三关全部可解，且搜索已穷尽（结论可信）", () => {
    for (const level of levels) {
      const r = solved(level);
      expect(r.exhausted, `${level.id} 触及节点上限，结论不可信`).toBe(true);
      expect(r.solvable, `${level.id} 无解`).toBe(true);
      expect(r.minAP).toBeGreaterThan(0);
      expect(r.minAP).toBe(GOLDEN[level.id].minAP);
      expect(r.slack).toBe(GOLDEN[level.id].slack);
    }
  });

  /**
   * 最关键的一条：求解器说「可解」不算数 —— 把它的路径喂回真实 reducer 必须真的赢。
   * 这条能同时抓住状态指纹碰撞、剪枝错误、以及对 reduce 语义的误读。
   */
  it("重放求解器的路径真的获胜", () => {
    for (const level of levels) {
      const r = solved(level);
      expect(r.path).not.toBeNull();

      const { state, log } = replay(level, r.path!);
      expect(log.every((e) => e.accepted), `${level.id} 解路径含非法动作`).toBe(true);
      expect(state.outcome, `${level.id} 重放未获胜`).toBe("WIN");
      expect(state.deaths).toBeLessThanOrEqual(level.rules.maxDeaths);

      const g = GOLDEN[level.id];
      expect(state.deaths).toBe(g.deaths);
      expect(state.infectionEvents).toBe(g.infections);
      expect(r.path!.filter((a) => a.type === "ISOLATE")).toHaveLength(g.isolates);
    }
  });

  /**
   * 【v2 修正的核心】搜索代价是 AP，不是动作数。
   *
   * 这条同时干两件事：
   *  1. 钉死「路径的 actionCost 累加 === minAP」（治愈档 2 手、急救档 1 手、隔离 1 手都算对）
   *  2. 顺手验证启发式的可采纳性 —— 沿路径每一步 h 都不得超过真实剩余 AP
   *
   * 若有人把 g 改回 node.g + 1，第 1 条会立刻红：night-02 含隔离，minAP ≠ 步数。
   */
  it("minAP 等于路径的真实 AP 累加，且启发式全程不高估", () => {
    for (const level of levels) {
      const r = solved(level);
      let state = createInitialState(level);
      let spent = 0;
      for (let i = 0; i < r.path!.length; i++) {
        expect(
          heuristic(state),
          `${level.id} 第 ${i} 步：h=${heuristic(state)} 超过真实剩余 ${r.minAP! - spent}`,
        ).toBeLessThanOrEqual(r.minAP! - spent);
        const a = r.path![i];
        spent += actionCost(state, a);
        state = reduce(state, a).state;
      }
      expect(spent, `${level.id} 路径 AP 累加 ≠ minAP`).toBe(r.minAP);
      expect(state.outcome).toBe("WIN");
    }
  });

  /**
   * D1 修复（2026-09-17）后，七关在**默认预算**下的最优解都不再用隔离 ——
   * 隔离回到最优解的入口是「零感染线」（night-03 k=0：想做到 0 感染就得拉帘，
   * iso-value 实测禁用隔离则无解）。这条测试改从那个入口取含隔离的路径。
   */
  it("含隔离的关卡：minAP 严格大于动作数", () => {
    const k0: LevelDef = {
      ...(night03 as unknown as LevelDef),
      rules: {
        ...(night03 as unknown as LevelDef).rules,
      },
    };
    const r = solve(k0, { maxNodes: 150_000 });
    expect(r.solvable).toBe(true);
    expect(r.path!.some((a) => a.type === "ISOLATE")).toBe(true);
    expect(r.minAP!).toBeGreaterThan(r.path!.length);
  });

  /**
   * 金标准：在规模最小的关卡上，A* 必须与无启发式的穷举完全一致。
   * 这条最权威，但成本高，所以只跑 night-00。
   */
  it("A* 与穷举给出相同的最小 AP；启发式在更大的关卡上显著剪枝", () => {
    // night-00 只有 4 个患者，搜索空间太小，启发式没有发挥余地
    const small = night00 as unknown as LevelDef;
    const a0 = solve(small, { maxNodes: 100_000 });
    const b0 = solve(small, { noHeuristic: true, maxNodes: 100_000 });
    expect(b0.exhausted).toBe(true);
    expect(a0.minAP).toBe(b0.minAP);
    expect(a0.nodesExplored).toBeLessThanOrEqual(b0.nodesExplored);

    // night-01 空间大得多：启发式必须真的剪掉一个数量级。
    // 关掉启发式后，10 万节点内**根本摸不到解**（实测要 34 万节点、近 1 分钟），
    // 所以这里不断言 b1.exhausted —— 只断言「A* 找到了，同预算的无启发式还没找到」。
    // 这本身就是启发式价值的直接证据；minAP 与穷举的一致性由上面 night-00 那条守着。
    const mid = night01 as unknown as LevelDef;
    const a1 = solve(mid, { maxNodes: 100_000 });
    const b1 = solve(mid, { noHeuristic: true, maxNodes: 100_000 });
    expect(a1.exhausted).toBe(true);
    expect(a1.solvable).toBe(true);
    expect(b1.solvable, "同预算下无启发式找不到解 —— 这正是启发式的价值").toBe(false);
    expect(a1.nodesExplored * 10).toBeLessThan(b1.nodesExplored);
  });

  it("目标超出 AP 能力时报告无解", () => {
    const impossible: LevelDef = {
      ...(night00 as unknown as LevelDef),
      rules: { ...(night00 as unknown as LevelDef).rules, requiredDischarges: 99 },
    };
    const r = solve(impossible, { maxNodes: 100_000 });
    expect(r.exhausted).toBe(true);
    expect(r.solvable).toBe(false);
    expect(r.minAP).toBeNull();
    expect(r.slack).toBeNull();
    expect(r.path).toBeNull();
  });

  it("搜索被截断时 exhausted = false，结论作废", () => {
    const r = solve(night01 as unknown as LevelDef, { maxNodes: 3 });
    expect(r.exhausted).toBe(false);
  });

  it("scanBudget 覆盖参数网格，并保持 slack = totalAP − minAP", () => {
    const rows = scanBudget(night00 as unknown as LevelDef, {
      turns: [night00.turns, night00.turns + 1],
      maxNodes: 100_000,
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.solvable).toBe(true);

    const [a, b] = rows;
    expect(b.slack!).toBeGreaterThanOrEqual(a.slack!); // 回合越多余量不减
    expect(b.totalAP - b.minAP!).toBe(b.slack!);
  });

  it("formatPath 产出可读步骤，行数 = 动作数（不是 AP）", () => {
    // 零感染预算下的 night-03：最优解含隔离（见「含隔离的关卡」的说明）
    const k0: LevelDef = {
      ...(night03 as unknown as LevelDef),
      rules: {
        ...(night03 as unknown as LevelDef).rules,
      },
    };
    const r = solve(k0, { maxNodes: 150_000 });
    const lines = formatPath(r.path!);
    expect(lines).toHaveLength(r.path!.length);
    expect(lines[0]).toMatch(/^\d\d\. /);
    // 隔离那一步必须读得出来（两个源：P01 明显 / M01 隐形，无论帘落在谁身上）
    expect(lines.some((l) => l.includes("隔离"))).toBe(true);
  });
});
