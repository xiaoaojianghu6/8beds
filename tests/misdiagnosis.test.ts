/**
 * 误诊判死（Contract §5.3）专项护栏。
 *
 * ── 这个文件替掉了什么 ────────────────────────────────────────
 * 它以前叫 `remedy.test.ts`，守的是 v2 的「不可逆通道 + 补救」：误治之后进危重、
 * 花 remedyCost 把人拉回来。用户看完那条线之后说得很直接：
 *
 *   「玩家不是白痴，都需要补救了，玩家为啥不重开一把？」
 *
 * 这句话是对的。补救只存在于求解器的动作空间里，不在玩家的决策空间里 ——
 * 一个人误治之后不会算「我还剩几只手能不能补回来」，他会重开。
 * 于是整条通道连同它的三个字段（`reversing` / `reversedThisTurn` / `remedyCost`）
 * 一起删掉，换成一个更简单也更刺眼的规则：**误诊 = 当帧判负。**
 *
 * ── 这个文件现在守什么 ────────────────────────────────────────
 * 一条判死规则只有在「到处都判死」时才是规则。所以这里不测 UI、不测文案，
 * 只测三件事：
 *   1. **七关的每一个镜像患者都真的会判死**（没有哪个关卡偷偷放水）；
 *   2. **求解器不许把误诊当成一条路**（否则「最优解」里会出现一个必输的动作）；
 *   3. **判负之后没有回头路**（任何动作都被拒，连状态都不动）。
 */
import { describe, expect, it } from "vitest";
import { reduce } from "../src/core/reducer";
import { replay } from "../src/core/replay";
import { createInitialState } from "../src/core/state";
import { levels, nightOrder } from "../src/levels";
import { solve } from "../src/solver";
import type { LevelDef } from "../src/core/types";

/**
 * 一个小实验台：一个 acuity 1 的镜像患者，`actionPoints × turns` 给定。
 * 正确解法 = 检测 1 + 治愈档 2 = 3 手，一分不多一分不少。
 */
function bench(opts: { actionPoints: number; turns: number }): LevelDef {
  return {
    id: "bench",
    title: "bench",
    turns: opts.turns,
    actionPoints: opts.actionPoints,
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
          axisIntervention: "MIRROR",
          mirrorBranch: "A",
        },
        hidden: {},
        revealOrder: ["riskProfile"],
        state: { bedId: 1 },
      },
    ],
    arrivalSchedule: [],
  };
}

describe("误诊判死 · 七关没有例外", () => {
  /**
   * 判死规则最容易在数据层漏：某关的某个镜像患者如果带 `revealed: ["riskProfile"]`
   * 或者压根不是 MIRROR，它就悄悄地不判死了 —— 而这条贴士、这个教学点、
   * 这条求解器剪枝的前提就全部失效。
   */
  it("每个在床的 MIRROR 患者，未检测就处置 → 一律当帧判负", () => {
    let checked = 0;
    for (const id of nightOrder) {
      const base = createInitialState(levels[id] as unknown as LevelDef);
      // 手数给足：这里要排除的是「AP 不够所以没扣」，不是「AP 不够所以该拒」
      const rich = { ...base, ap: 20 };
      for (const p of Object.values(base.patients)) {
        if (p.axisIntervention !== "MIRROR" || p.bedId == null) continue;
        const where = `${id}/${p.id}`;
        const r = reduce(rich, { type: "STABILIZE", patientId: p.id });
        expect(r.accepted, `${where} 处置被拒`).toBe(true);
        expect(
          r.events.some((e) => e.startsWith(`MISDIAGNOSIS:${p.id}:`)),
          `${where} 没有误诊事件`,
        ).toBe(true);
        expect(r.state.patients[p.id].alive, `${where} 居然活着`).toBe(false);
        expect(r.state.outcome, `${where} 没有判负`).toBe("LOSE");
        checked++;
      }
    }
    // 防空转：七关合计十来个镜像患者（B01/B02、H01/G01、D01、N01/N02/R01…）
    expect(checked).toBeGreaterThan(5);
  });

  it("night-06（地狱关）的 N01 也不放水：误诊就没有后半局", () => {
    const lv = levels["night-06"] as unknown as LevelDef;
    const s = createInitialState(lv);
    const n01 = s.patients["N01"];
    expect(n01.axisIntervention).toBe("MIRROR");
    expect(n01.bedId).not.toBeNull();

    const r = reduce({ ...s, ap: 20 }, { type: "STABILIZE", patientId: "N01" });
    expect(r.events.some((e) => e.startsWith("MISDIAGNOSIS:N01:"))).toBe(true);
    expect(r.state.outcome).toBe("LOSE");
    // v2 里这里是「误治 N01 之后还有一条 32/33 手的翻盘路」——
    // 那条路随补救通道一起删了。现在唯一的下一步是重开。
    expect(reduce(r.state, { type: "STABILIZE", patientId: "N01" }).events).toEqual(["GAME_OVER"]);
  });
});

describe("误诊判死 · 求解器不许把它当成一条路", () => {
  it("误诊是必败分支：2 手打不通，而且这个「无解」是穷尽出来的", () => {
    // 正确解法要 3 手（检测 1 + 治愈档 2）。给 2 手时唯一的「便宜」走法就是
    // 不检测直接治 —— 而那是当帧判负。若剪枝把它当成一次推进，求解器会
    // 假报 solvable；若剪枝过度（把合法路一起剪掉），exhausted 会是 false。
    const solved = solve(bench({ actionPoints: 2, turns: 1 }), { maxNodes: 20_000 });
    expect(solved.solvable).toBe(false);
    expect(solved.exhausted).toBe(true);
  });

  it("给够 3 手时最优解只有一条路：先检测，再处置", () => {
    const lv = bench({ actionPoints: 3, turns: 1 });
    const solved = solve(lv, { maxNodes: 20_000 });
    expect(solved.solvable).toBe(true);
    expect(solved.minAP).toBe(3);

    const { state, log } = replay(lv, solved.path!);
    expect(log.every((r) => r.accepted)).toBe(true);
    expect(state.outcome).toBe("WIN");
    // 解里不许出现任何一次误诊 —— 出现就说明剪枝没生效
    expect(log.some((r) => r.events.some((e) => e.startsWith("MISDIAGNOSIS")))).toBe(false);
    expect(solved.path!.map((a) => a.type)).toContain("SCAN");
  });
});

describe("误诊判死 · 判负之后没有回头路", () => {
  it("判负是终态：任何动作都被拒，状态一个字都不动", () => {
    const lv = bench({ actionPoints: 6, turns: 3 });
    const dead = reduce(createInitialState(lv), { type: "STABILIZE", patientId: "M" }).state;
    expect(dead.outcome).toBe("LOSE");

    const before = JSON.stringify(dead);
    for (const type of ["SCAN", "STABILIZE"] as const) {
      const after = reduce(dead, { type, patientId: "M" });
      expect(after.accepted, type).toBe(false);
      expect(after.events, type).toEqual(["GAME_OVER"]);
    }
    expect(JSON.stringify(dead)).toBe(before); // 连被 clone 出去的改动都没有
  });

  it("同一帧只打一次 LOSE（不会既算误诊、又算死亡超限）", () => {
    const lv = bench({ actionPoints: 6, turns: 3 });
    const r = reduce(createInitialState(lv), { type: "STABILIZE", patientId: "M" });
    expect(r.events.filter((e) => e === "LOSE")).toHaveLength(1);
    // 误诊已经把 deaths 顶到 1（maxDeaths = 0）—— 但那是同一件事，不能报两次
    expect(r.state.deaths).toBe(1);
  });
});
