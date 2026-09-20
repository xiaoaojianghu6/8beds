/**
 * `src/ui/review.ts` —— 失败复盘。
 *
 * 这层守两条体验底线：
 *   ① **玩家输的时候必须知道自己输在哪一步** —— 断言不检查「有没有鼓励的话」，
 *      只检查归因是否精确到人、回合与类型；
 *   ② **屏幕上绝不出现内部编号** —— 夹具刻意用真实形状（id = N01，主诉 = 一句人话），
 *      这样「复盘里没有 `Nxx`」才是真的被检到了。用户原话：
 *      「那一堆 N01、s01、t01，这什么鬼？不要有表意不明的东西出现」。
 */
import { describe, expect, it } from "vitest";
import { reduce } from "../src/core/reducer";
import { createInitialState } from "../src/core/state";
import type { LevelDef, PatientDef } from "../src/core/types";
import { bedOf, buildReview } from "../src/ui/review";

/** 内部编号：故意用真实形状，好让「不许出现编号」这条断言真的能抓到东西。 */
const ID_LIKE = /(?<![A-Za-z0-9])[A-Z]\d{2}(?![A-Za-z0-9])/;

function pdef(
  id: string,
  o: {
    bedId?: number;
    acuity?: number;
    rate?: number;
    transmission?: "NONE" | "LOW" | "HIGH";
    complaint?: string;
  } = {},
): PatientDef {
  return {
    id,
    archetype: "T",
    visible: { chiefComplaint: o.complaint ?? `主诉${id.slice(-2)}`, acuity: o.acuity ?? 1 },
    rules: {
      deteriorationRate: o.rate ?? 0,
      transmission: o.transmission ?? "NONE",
      axisIntervention: "DIRECT",
    },
    hidden: {},
    revealOrder: ["riskProfile", "transmission", "disposition"],
    state: o.bedId == null ? {} : { bedId: o.bedId },
  };
}

function mk(o: {
  patients: PatientDef[];
  turns?: number;
  ap?: number;
  rules?: Partial<LevelDef["rules"]>;
}): LevelDef {
  return {
    id: "fixture",
    title: "fixture",
    turns: o.turns ?? 3,
    actionPoints: o.ap ?? 1,
    enabledActions: ["ADMIT", "SCAN", "STABILIZE", "ISOLATE"],
    rules: {
      infectionEnabled: false,
      corridorGraceTurns: 1,
      maxDeaths: 0,
      requiredDischarges: "ALL",
      ...o.rules,
    },
    initialPatients: o.patients,
    arrivalSchedule: [],
  };
}

/** 复盘的任何一行都不许出现内部编号。 */
function expectNoIds(r: ReturnType<typeof buildReview>) {
  expect(r.headline, r.headline).not.toMatch(ID_LIKE);
  for (const l of r.lines) {
    expect(l.label, `标签「${l.label}」`).not.toMatch(ID_LIKE);
    expect(l.body, `正文「${l.body}」`).not.toMatch(ID_LIKE);
  }
}

describe("review：死在谁身上、第几回合、为什么", () => {
  it("自然恶化致死 → kind=deaths，用「几号床 + 症状」指人，不用内部编号", () => {
    // acuity 2 + rate 3：一回合末直接越过死亡线
    const lv = mk({ patients: [pdef("N01", { bedId: 1, acuity: 2, rate: 3, complaint: "受了外伤" })] });
    let s = createInitialState(lv);
    s = reduce(s, { type: "SCAN", patientId: "N01" }).state; // 烧掉唯一一只手 → 回合末结算
    expect(s.outcome).toBe("LOSE");
    expect(s.patients.N01.alive).toBe(false);

    const r = buildReview(s);
    expect(r.kind).toBe("deaths");
    expect(r.headline).toMatch(/没能撑过/);
    const fatal = r.lines.filter((l) => l.kind === "fatal");
    expect(fatal).toHaveLength(1);
    expect(fatal[0].body).toMatch(/1 号床 · 受了外伤/);
    expect(fatal[0].body).toMatch(/第 1 回合/);
    expectNoIds(r);
  });

  it("回合耗尽 → kind=timeout，点出还剩几个人", () => {
    const lv = mk({ patients: [pdef("N01", { bedId: 1, acuity: 1, rate: 0 })], turns: 1 });
    let s = createInitialState(lv);
    s = reduce(s, { type: "SCAN", patientId: "N01" }).state;
    expect(s.outcome).toBe("LOSE");

    const r = buildReview(s);
    expect(r.kind).toBe("timeout");
    expect(r.headline).toMatch(/回合用完/);
    const gap = r.lines.find((l) => l.kind === "gap");
    expect(gap).toBeDefined();
    expect(gap!.body).toMatch(/1 号床/);
    // 每关必须给出「下一把改什么」，不能只有安慰
    expect(r.lines.some((l) => l.kind === "advice")).toBe(true);
    expectNoIds(r);
  });

  it("感染不判负，但死亡结算里必须点出「传染在偷手」并标出回合", () => {
    const lv = mk({
      patients: [
        pdef("N01", { bedId: 1, transmission: "HIGH" }),
        pdef("N02", { bedId: 2, acuity: 1 }),
      ],
      turns: 4,
      rules: { infectionEnabled: true },
    });
    let s = createInitialState(lv);
    // 一次 reduce 只结算一回合：N02 要吃到两次传染升级（1→2→3）才会死
    for (let i = 0; i < 8 && s.outcome === "ONGOING"; i++) {
      s = reduce(s, { type: "SCAN", patientId: "N01" }).state;
    }
    // 感染只计数：N02 被传染升到 3 级死亡，判负原因是「死人」不是「超限」
    expect(s.outcome).toBe("LOSE");
    expect(s.deaths).toBe(1);
    expect(s.infectionEvents).toBeGreaterThan(0);

    const r = buildReview(s);
    expect(r.kind).toBe("deaths");
    const cause = r.lines.find((l) => l.label === "传染在偷手");
    expect(cause).toBeDefined();
    expect(cause!.body).toMatch(/传染/);
    expectNoIds(r);
  });

  it("死因是旁边床传染时，「下一把」不能建议「这个病人不会自己加重」", () => {
    // 患者 N02 的 deteriorationRate = 0（它确实不会自己恶化），但它被 HIGH 源传染死了。
    // 曾经的实现取 dead[0] 的 rate 出建议 → 玩家刚因为他死掉，系统却说他不用管。
    const lv = mk({
      patients: [
        pdef("N01", { bedId: 1, transmission: "HIGH" }),
        pdef("N02", { bedId: 2, acuity: 1, rate: 0 }),
      ],
      turns: 4,
      rules: { infectionEnabled: true, maxDeaths: 0 },
    });
    let s = createInitialState(lv);
    s = reduce(s, { type: "SCAN", patientId: "N01" }).state;
    s = reduce(s, { type: "SCAN", patientId: "N01" }).state;
    expect(s.patients.N02.alive).toBe(false);

    const r = buildReview(s);
    expect(r.kind).toBe("deaths");
    const advice = r.lines.find((l) => l.kind === "advice");
    expect(advice).toBeDefined();
    expect(advice!.body).toMatch(/传染/);
    expect(advice!.body).not.toMatch(/不会自己加重/);
    expectNoIds(r);
  });

  it("全程没人碰过的患者死掉时，建议必须指向「先排红灯」", () => {
    const lv = mk({ patients: [pdef("N01", { bedId: 1, acuity: 2, rate: 3 })] });
    let s = createInitialState(lv);
    s = reduce(s, { type: "SCAN", patientId: "N01" }).state;
    expect(s.outcome).toBe("LOSE");

    const r = buildReview(s);
    const advice = r.lines.find((l) => l.kind === "advice");
    expect(advice).toBeDefined();
    expect(advice!.body).toMatch(/红灯/);
    // 第 1 回合就死 → 不能说「从头到尾没有人给他治过」（这是废话）
    const fatal = r.lines.find((l) => l.kind === "fatal");
    expect(fatal!.body).not.toMatch(/从头到尾/);
    expect(fatal!.body).toMatch(/开局他就是红灯/);
    expectNoIds(r);
  });

  it("复盘里绝不出现「?」占位符 —— 兜底文案也必须是完整的人话", () => {
    // 最坏情况：患者已经不在，但历史里没有对应的 DIED 事件（存档畸形、事件被裁）。
    // 曾经这里会印出「在第 ? 回合末没撑住」，等于把内部状态漏到玩家脸上。
    const lv = mk({ patients: [pdef("N01", { bedId: 1, acuity: 1, rate: 0 })], turns: 2 });
    const s = createInitialState(lv);
    s.patients.N01.alive = false;
    s.deaths = 1;

    const r = buildReview(s);
    expect(r.kind).toBe("deaths");
    expect(r.headline).not.toMatch(/\?/);
    for (const l of r.lines) expect(l.body).not.toMatch(/\?/);
    expectNoIds(r);
  });

  it("没送走的人写「几号床 + 症状 + 灯」，送走的人也在「做对了」里点出床位", () => {
    // ap 必须 ≥ 2：治愈档（acuity 1 → 0）收 2 手，ap 1 时这个动作会被 legalActions 直接过滤掉
    const lv = mk({
      patients: [
        pdef("N01", { bedId: 1, acuity: 1, complaint: "受了外伤" }),
        pdef("N02", { bedId: 2, acuity: 1, complaint: "铁锈色痰" }),
      ],
      turns: 1,
      ap: 2,
    });
    let s = createInitialState(lv);
    s = reduce(s, { type: "STABILIZE", patientId: "N01" }).state; // 2 手花完 → 回合末 → 超时
    expect(s.patients.N01.discharged).toBe(true);
    expect(s.outcome).toBe("LOSE");

    const r = buildReview(s);
    const gap = r.lines.find((l) => l.kind === "gap");
    expect(gap).toBeDefined();
    expect(gap!.body).toMatch(/2 号床 · 铁锈色痰/);
    expect(gap!.body).not.toMatch(/1 号床/);

    // 已经出院的人 bedId 被清空，但 homeBed 还在 —— 所以「做对了」照样能点出「1 号床」。
    const good = r.lines.find((l) => l.kind === "good");
    expect(good).toBeDefined();
    expect(good!.body).toMatch(/1 号床 · 受了外伤/);
    expectNoIds(r);
  });
});

describe("review.bedOf —— 点名一个人只能用玩家看得见的位置", () => {
  it("已出院的人 bedId 清空了，仍然报得出他待过的床位", () => {
    const lv = mk({
      patients: [pdef("N01", { bedId: 3, acuity: 1 })],
      turns: 1,
      ap: 2,
    });
    const s = reduce(createInitialState(lv), { type: "STABILIZE", patientId: "N01" }).state;
    expect(s.patients.N01.bedId).toBeNull(); // 出院即清床
    expect(bedOf(s, s.patients.N01)).toBe(3); // 但历史床位还在
  });

  it("死在床上的人，也报得出是哪张床（DIED 事件带 location）", () => {
    const lv = mk({ patients: [pdef("N01", { bedId: 5, acuity: 2, rate: 3 })] });
    const s = reduce(createInitialState(lv), { type: "SCAN", patientId: "N01" }).state;
    expect(s.patients.N01.alive).toBe(false);
    expect(bedOf(s, s.patients.N01)).toBe(5);
  });
});
