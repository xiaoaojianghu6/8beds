/**
 * 死亡贴士（失败结算页的「历史案例 + 专业知识」）的护栏。
 *
 * 这套贴士来自 `docs/level-design/08-DEATH-TIPS.md`：一局最多三条、
 * 按触发条件从 `history` 归因。它此前**完全没有进游戏**
 * （`docs/SOLUTIONS.md §4.1` 把「19 条贴士已定稿，但 src/ui 无任何引用」列为阻塞项），
 * 所以这份测试的第一职责不是「测新代码」，而是**保证它不会再次掉线**：
 *
 *   1. 每条贴士都必须能被某种真实局面选中（可达性）—— 否则就是装饰品；
 *   2. 触发条件只认 `history[].events` 里真实存在的字符串 —— 否则永远不触发；
 *   3. 贴士是玩家可见文字，三张黑名单（术语 / 碎片 / 内部编号）全量适用；
 *   4. 指人只能用「4 号床 · 主诉」，绝不回退到内部编号。
 */
import { describe, expect, it } from "vitest";
import { createInitialState } from "../src/core/state";
import type { GameState, LevelDef, Patient, PlayerAction } from "../src/core/types";
import { levels } from "../src/levels";
import { resolveTips, TIP_DISCLAIMER, TIP_SEGMENT_ORDER, TIPS, type DeathTip } from "../src/ui/tips";

/**
 * 每个 `trigger` 对应的真实事件 —— 这张表就是「不会掉线」的证明：
 * 左边是贴士的分类，右边是 `src/core/` 真的会写进 `history` 的字符串。
 * 改 reducer 的事件名必须同步改这里，否则测试立刻红。
 */
const TRIGGER_EVENT: Record<DeathTip["trigger"], string> = {
  // 未揭示的镜像患者被治 = 误诊 = **当帧判负**（2026-09-17 起，无补救通道）
  UNSCANNED_MIRROR: "MISDIAGNOSIS:$PID$:A",
  SCAN_FIRST_SKIPPED: "STABILIZE_INEFFECTIVE:$PID$:UNSCANNED:cost2",
  DELAYED_DIRECT: "SCANNED:$PID$:riskProfile",
  DIRTY_HANDS: "HAND_CONTAMINATED:$PID$:+1:1",
  BED_UNIT: "BED_UNIT_EXPOSURE:$PID$:bed2:+1:1",
  SPREAD: "EXPOSURE_ESCALATE:$PID$:acuity2",
  WINDOW_CLOSED: "WINDOW_CLOSED:$PID$",
  DELIRIUM: "DELIRIUM_TAX:$OTHER$:$PID$",
  TRIAGE: "DIED:$PID$:BED2",
  TIMEOUT: "TIMEOUT",
};

/**
 * 候选局面 = 早期关 / 后期关 × 围过 / 没围过。
 *
 * 刻意**不去复述 `tips.ts` 里那张取舍表**：测试要验证的是「存在一种局面能选出它」，
 * 那就把可能的相关维度都枚举出来，让它自己撞上。抄一份条件过来只会得到
 * 「测试和实现一起错」。
 */
function scene(nightId: string, isolated: boolean): GameState {
  const base = createInitialState(levels[nightId] as unknown as LevelDef);
  const pid = Object.keys(base.patients)[0];
  const s: GameState = { ...base, nightId, history: [] };
  if (isolated) {
    s.history.push({
      turn: 1,
      action: { type: "ISOLATE", patientId: pid } as PlayerAction,
      accepted: true,
      events: [`ISOLATED:${pid}:cost1`],
    });
  }
  return s;
}

const SCENES: GameState[] = [
  scene("night-04", false),
  scene("night-04", true),
  scene("night-06", false),
  scene("night-06", true),
];

/** 往一个局面里注入「这条贴士的触发条件」。 */
function inject(base: GameState, tip: DeathTip): GameState {
  const pid = Object.keys(base.patients)[0];
  const otherPid = Object.keys(base.patients)[1] ?? pid;
  const s: GameState = { ...base, patients: { ...base.patients }, history: [...base.history] };

  const p: Patient = { ...s.patients[pid] };
  // 让关键词分诊有东西可命中：把候选词塞进主诉与原话（分诊只看这两个字段）。
  if (tip.match?.length) {
    p.chiefComplaint = `${p.chiefComplaint}${tip.match[0]}`;
    p.utterance = `${p.utterance}${tip.match.join("")}`;
  }
  // `DELAYED_DIRECT` 只在「该立刻动手的患者被查了」时才成立。
  if (tip.trigger === "DELAYED_DIRECT") p.axisIntervention = "DIRECT";
  if (tip.trigger === "UNSCANNED_MIRROR") p.axisIntervention = "MIRROR";
  s.patients[pid] = p;

  const events: string[] = [];
  if (tip.trigger === "TRIAGE") {
    // 「没撑住」= 先自然恶化、再死。只写 DIED 归不到这一类。
    events.push(`DETERIORATED:${pid}:3:BED2`, `DIED:${pid}:BED2`);
  } else {
    events.push(
      TRIGGER_EVENT[tip.trigger].replace("$PID$", pid).replace("$OTHER$", otherPid),
    );
  }
  s.history.push({
    turn: 2,
    action: { type: "SCAN", patientId: pid } as PlayerAction,
    accepted: true,
    events,
  });
  return s;
}

function selectedIds(base: GameState, tip: DeathTip): string[] {
  return resolveTips(inject(base, tip), TIPS.length).map((v) => v.id);
}

describe("贴士：数据完整性", () => {
  it("每条都有 you / medicine 两段（reality 可选），id 唯一，可信度只有 A / B", () => {
    const ids = new Set<string>();
    for (const t of TIPS) {
      expect(ids.has(t.id), `重复 id ${t.id}`).toBe(false);
      ids.add(t.id);
      expect(["A", "B"]).toContain(t.confidence);
      expect(t.label.length).toBeGreaterThan(0);
      for (const key of ["you", "medicine"] as const) {
        expect(t.segments[key]?.length ?? 0, `${t.id} 缺 ${key}`).toBeGreaterThan(0);
      }
      // 第四段「下一次」已删除：贴士是病例，不是教程（2026-09-17 用户拍板）。
      expect("next" in t.segments, `${t.id} 又长出了说教段`).toBe(false);
      // 专业感来自「具体」：病名 + 数字。全是空话的贴士过不了这一关。
      expect(
        `${t.segments.you}${t.segments.medicine}${t.segments.reality ?? ""}`.length,
        `${t.id} 太短，写不出病名与机制`,
      ).toBeGreaterThan(60);
    }
    // 设计值：08 的 19 条 − 两条机制未开（T9-1 方案选择、T6-2 观察期）
    // + 三条新补（T1-0 通用、T10-0 通用、T7-3 出血）
    expect(TIPS.length).toBe(20);
  });

  it("凡出现具体数字，必须写出处（08 §12 的纪律升级版）", () => {
    // 这条规则替代了原来的「一律不许出现百分比」。
    //
    // 原规则是 [C]（待医学顾问复核）时期的产物：当时库里漂着三段没人核过的数字，
    // 最省事的办法就是全禁掉。但用户的原话是「案例太不专业了……应该用真实案例……
    // 形成视觉冲击」—— 贴士的专业感恰恰**来自具体的数字**（「死亡从 1.5% 降到 0.8%」
    // 比「明显减少」有力得多）。
    //
    // 所以规则改成：**数字可以有，但必须可追溯**。写不出出处就改成模糊表述。
    // 反例守卫：塞一条带百分比却没有 source 的假贴士，必须报出来。
    const NUMERIC = /[0-9]+(?:\.[0-9]+)?%|百分之|\d+(?:\.\d+)?\s*(?:例|人|小时|分钟|万)/;
    const offenders = TIPS.filter((t) => {
      const all = Object.values(t.segments).filter((v): v is string => typeof v === "string");
      return all.some((v) => NUMERIC.test(v)) && !t.source;
    }).map((t) => t.id);
    expect(offenders).toEqual([]);

    // 自检：这套判据真的能抓到「有数字没出处」
    expect(NUMERIC.test("术后死亡从 1.5% 降到 0.8%")).toBe(true);
    expect(NUMERIC.test("221 人得肺炎")).toBe(true);
    expect(NUMERIC.test("没查出来的人占百分之三点五")).toBe(true);
    expect(NUMERIC.test("他的病情不会自己加重")).toBe(false);

    // 反过来：写了 source 的，出处不能是空字符串充数
    for (const t of TIPS) {
      if (t.source !== undefined) expect(t.source.trim().length, `${t.id} 的出处太短`).toBeGreaterThan(8);
    }
    for (const t of TIPS) expect(["A", "B"]).toContain(t.confidence);
  });

  it("免责声明在（医学科普一旦进游戏，这句是硬要求）", () => {
    expect(TIP_DISCLAIMER.length).toBeGreaterThan(20);
    expect(TIP_DISCLAIMER).toContain("不构成任何医疗建议");
  });
});

describe("贴士：触发条件必须真实存在", () => {
  it("每条贴士都能被某一种真实局面选中（没有装饰品，没有死代码）", () => {
    const unreachable: string[] = [];
    for (const tip of TIPS) {
      const ok = SCENES.some((s) => selectedIds(s, tip).includes(tip.id));
      if (!ok) unreachable.push(`${tip.id}（${tip.trigger}）`);
    }
    expect(unreachable).toEqual([]);
  });

  it("同一 trigger 的两种取舍（围过 / 没围过）互斥，各得其所", () => {
    const isolation = TIPS.find((t) => t.id === "T4-1")!;
    const noIsolation = TIPS.find((t) => t.id === "T4-2")!;
    const withIso = selectedIds(scene("night-04", true), isolation);
    const withoutIso = selectedIds(scene("night-04", false), isolation);
    expect(withIso).toContain(isolation.id);
    expect(withIso).not.toContain(noIsolation.id);
    expect(withoutIso).toContain(noIsolation.id);
    expect(withoutIso).not.toContain(isolation.id);
  });

  it("关键词分诊按患者的主诉走，不会分到另一个病上", () => {
    // night-02 的 4 号床是「胸口像被压住」（心梗 A 面），不该拿到讲撕裂的那条。
    const lv = levels["night-02"] as unknown as LevelDef;
    const base = createInitialState(lv);
    const g01 = Object.values(base.patients).find((p) => p.chiefComplaint.includes("压住"))!;
    const s: GameState = {
      ...base,
      history: [
        {
          turn: 1,
          action: { type: "STABILIZE", patientId: g01.id } as PlayerAction,
          accepted: true,
          events: [`MISDIAGNOSIS:${g01.id}:A`],
        },
      ],
    };
    const got = resolveTips(s, TIPS.length);
    const onThisBed = got.find((v) => v.subject?.includes("压住"));
    expect(onThisBed, "4 号床该有一条贴士").toBeTruthy();
    expect(onThisBed!.id).not.toBe("T1-2");
  });

  it("一局最多三条，且同一个 trigger 只出一条", () => {
    const ids = Object.keys(SCENES[0].patients);
    const s: GameState = {
      ...SCENES[0],
      history: [
        {
          turn: 1,
          action: { type: "SCAN", patientId: ids[0] } as PlayerAction,
          accepted: true,
          events: [
            `SCANNED:${ids[0]}:riskProfile`,
            `HAND_CONTAMINATED:${ids[0]}:+1:1`,
            `BED_UNIT_EXPOSURE:${ids[0]}:bed2:+1:1`,
            `EXPOSURE_ESCALATE:${ids[0]}:acuity2`,
            `WINDOW_CLOSED:${ids[0]}`,
            "TIMEOUT",
          ],
        },
      ],
    };
    const got = resolveTips(s);
    expect(got.length).toBeLessThanOrEqual(3);
    expect(new Set(got.map((v) => v.id)).size).toBe(got.length);
  });

  it("被拒绝的动作不产生归因（点了没反应 ≠ 做错了）", () => {
    const lv = levels["night-01"] as unknown as LevelDef;
    const base = createInitialState(lv);
    const pid = Object.keys(base.patients)[0];
    const s: GameState = {
      ...base,
      history: [
        {
          turn: 1,
          action: { type: "STABILIZE", patientId: pid } as PlayerAction,
          accepted: false,
          events: ["REJECTED_ILLEGAL"],
        },
      ],
    };
    expect(resolveTips(s)).toEqual([]);
  });

  it("没打输就不出贴士（胜局页保持干净）", () => {
    const lv = levels["night-00"] as unknown as LevelDef;
    const s = { ...createInitialState(lv), outcome: "WIN" as const };
    // 归因靠 history，胜局没有这些事件 —— 但即使有，也不该在胜利页出现。
    // 这里断言的是 resolveTips 不依赖 outcome，UI 负责只在失败页调用它。
    expect(resolveTips(s)).toEqual([]);
  });
});

describe("贴士：指人只用玩家看得见的东西", () => {
  it("subject 永远写成「N 号床 · 主诉」或「走廊里 · 主诉」，绝无内部编号", () => {
    for (const tip of TIPS) {
      for (const base of SCENES) {
        for (const v of resolveTips(inject(base, tip), TIPS.length)) {
          if (v.subject == null) continue;
          expect(v.subject, `${tip.id} 的指代`).toMatch(/^(?:\d 号床|走廊里) · .+/);
          expect(
            /(?<![A-Za-z0-9])[A-Z]\d{2}(?![A-Za-z0-9])/.test(v.subject),
            `${tip.id} 漏了内部编号：${v.subject}`,
          ).toBe(false);
        }
      }
    }
  });

  it("三段的标题固定：你做了什么 / 医学上 / 现实里", () => {
    expect(TIP_SEGMENT_ORDER.map(([, name]) => name)).toEqual([
      "你做了什么",
      "医学上",
      "现实里",
    ]);
  });
});
