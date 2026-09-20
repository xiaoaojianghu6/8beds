import { describe, expect, it } from "vitest";
import night00 from "../levels/night-00.json";
import night01 from "../levels/night-01.json";
import night02 from "../levels/night-02.json";
import { reduce } from "../src/core/reducer";
import { createInitialState } from "../src/core/state";
import type { LevelDef } from "../src/core/types";
import { levels, nightOrder } from "../src/levels";
import {
  ACTION_CAPTION,
  ACTION_LABEL,
  coachHint,
  disabledReason,
  NIGHT_INTROS,
} from "../src/ui/coach";

const n00 = night00 as unknown as LevelDef;
const n01 = night01 as unknown as LevelDef;
const n02 = night02 as unknown as LevelDef;

describe("night-00 引导", () => {
  it("四张开场卡：目标 / 怎么点 / 治疗是什么 / 手用完才前进", () => {
    const cards = NIGHT_INTROS["night-00"];
    expect(cards).toHaveLength(4);
    // 第一张必须交代「什么算赢、什么算输」—— 新手最需要的一句话
    expect(cards[0].title + cards[0].body).toMatch(/送出院/);
    expect(cards[0].body).toMatch(/失败/);
    expect(cards[1].body).toMatch(/先点一张床/);
    expect(cards[2].title + cards[2].body).toMatch(/治疗/);
    expect(cards[2].body).toMatch(/自己出院|自己会走/); // 出院是自动的，引导必须说清楚
    // 第四张说清手感：手用光回合才前进
    expect(cards[3].body).toMatch(/3 只手/);
    expect(cards[3].body).toMatch(/回合/);
  });

  it("开局先让玩家点那张有人的床", () => {
    const s = createInitialState(n00);
    const hint = coachHint(s, null);
    expect(hint.highlight).toBe("bed");
    expect(hint.highlightBed).toBe(1);
    expect(hint.body).toMatch(/点/);
  });

  it("选中 1 号床后提示「治疗」，而不是「出院」", () => {
    const s = createInitialState(n00);
    expect(coachHint(s, 1).highlight).toBe("stabilize");
    expect(coachHint(s, 1).body).toMatch(/治疗/);
  });

  it("acuity 没归零就一直提示处置（A01 从 2 起）", () => {
    const s = createInitialState(n00);
    const r = reduce(s, { type: "STABILIZE", patientId: "A01" });
    expect(r.state.patients.A01.acuity).toBe(1);
    expect(coachHint(r.state, 1).highlight).toBe("stabilize");
  });

  it("A01 自动出院后，提示挑一张空床收治", () => {
    let s = createInitialState(n00);
    s = reduce(s, { type: "STABILIZE", patientId: "A01" }).state;
    s = reduce(s, { type: "STABILIZE", patientId: "A01" }).state;
    expect(s.patients.A01.discharged).toBe(true); // 自动出院，没有 DISCHARGE 动作
    expect(coachHint(s, null).highlight).toBe("queue");
    expect(coachHint(s, 1).highlight).toBe("admit");
  });
});

describe("禁用原因", () => {
  it("没点床就说明要先点床", () => {
    const s = createInitialState(n00);
    expect(disabledReason("STABILIZE", s, null)).toMatch(/先点一张床/);
  });

  it("根本不存在出院动作 —— 患者自己走", () => {
    const s = createInitialState(n00);
    expect(s.enabledActions).not.toContain("DISCHARGE");
    expect(disabledReason("DISCHARGE" as never, s, 1)).toMatch(/没有这个动作/);
  });

  it("这张床已经围严时给出明确原因", () => {
    const s = reduce(createInitialState(n02), { type: "ISOLATE", patientId: "D01" }).state;
    expect(disabledReason("ISOLATE", s, 3)).toMatch(/围上帘子/);
  });

  it("隔离只要 1 AP —— 开局满手时不会给出任何禁用理由", () => {
    const s = createInitialState(n02);
    expect(disabledReason("ISOLATE", s, 3)).toBe("");
  });
});

describe("开场卡不许剧透（信息方向纪律）", () => {
  /**
   * 这条守卫来自用户的直接反馈：
   * 「需要玩家思考的地方，故意透露答案……有几对患者，这种明显需要玩家自己学习」。
   *
   * 判据只看两类**只有检测才能揭示**的信息，其余（谵妄、时间窗）本来就画在床卡上、
   * 不算剧透，所以不能一刀切禁止床号。
   */
  it("不在讲「传播」的句子里点名哪张床是源", () => {
    for (const [id, cards] of Object.entries(NIGHT_INTROS)) {
      for (const c of cards) {
        const s = `${c.title}。${c.body}`;
        const namesBed = /\d\s*号床/.test(s);
        const aboutTransmission = /传染|往外传|在传|传病|送暴露/.test(s);
        expect(namesBed && aboutTransmission, `${id} / ${c.title}`).toBe(false);
      }
    }
  });

  it("不报分不清病种的患者的人数或对数 —— 这是玩家自己看出来的", () => {
    for (const [id, cards] of Object.entries(NIGHT_INTROS)) {
      const all = cards.map((c) => `${c.title}。${c.body}`).join("\n");
      expect(all, id).not.toMatch(/\d+\s*[个对][^。]*镜像/);
      expect(all, id).not.toMatch(/\d+\s*[个对][^。]*分不清/);
    }
  });
});

describe("文案纪律：说人话（小学生、老人能听懂）", () => {
  /**
   * 这条守卫来自用户的直接反馈：
   * 「什么缝开，什么谵妄，这说什么呢？去除所有文艺化表达，让小学生、老人家能听明白」。
   *
   * 禁词表是**内部术语与文艺化表达**的黑名单 —— 它们都能一一对上一句大白话：
   *   缝→缺口 · 谵妄→神志不清 · 暴露→传染风险 · 升档→加重一级
   *   帘轨→帘子的轨道 · 阈值→线 · 定植→身上带菌 · 处置→治疗
   * 加进这个表之前，先确认它在界面上的替代说法已经在用。
   */
  const JARGON = [
    "缝",
    "帘轨",
    "谵妄",
    "暴露",
    "升档",
    "档位",
    "阈值",
    "定植",
    "隐匿",
    "体征",
    "处置",
    "剂量",
    "缓冲",
    "不可逆通道",
  ];

  /**
   * 缺主语的碎片 + 内部编号（2026-09-16 二审新增）。
   *
   * 用户原话：「什么叫还有一个缺口？什么叫不会自己变差？什么叫把他顶过线？
   * 你要把意思表达清楚！」「那一堆 N01、s01、t01，这什么鬼？
   * 不要有表意不明的东西出现」。所以碎片和编号都进黑名单。
   */
  const FRAGMENTS = [
    "不会自己变差",
    "撑不过这一回合",
    "最多再撑",
    "顶过线",
    "顶上去",
    "缺口",
    "口子",
  ];
  const PATIENT_ID = /(?<![A-Za-z0-9])[A-Z]\d{2}(?![A-Za-z0-9])/;

  function assertPlain(text: string, where: string): void {
    for (const w of JARGON) {
      expect(text.includes(w), `${where} 里出现了术语「${w}」：${text}`).toBe(false);
    }
    for (const w of FRAGMENTS) {
      expect(text.includes(w), `${where} 里出现了缺主语的碎片「${w}」：${text}`).toBe(false);
    }
    expect(PATIENT_ID.test(text), `${where} 里出现了内部编号：${text}`).toBe(false);
  }

  it("开场卡全部说人话", () => {
    for (const [id, cards] of Object.entries(NIGHT_INTROS)) {
      for (const c of cards) assertPlain(`${c.title}。${c.body}`, `${id} 开场卡`);
    }
  });

  it("动作按钮的名字与说明全部说人话", () => {
    for (const [type, label] of Object.entries(ACTION_LABEL)) {
      assertPlain(label, `ACTION_LABEL.${type}`);
      assertPlain(ACTION_CAPTION[type as keyof typeof ACTION_CAPTION], `ACTION_CAPTION.${type}`);
    }
  });

  it("禁用原因全部说人话", () => {
    const s = createInitialState(n00);
    for (const t of ["ADMIT", "SCAN", "STABILIZE", "ISOLATE"] as const) {
      assertPlain(disabledReason(t, s, null), `disabledReason(${t}, 未选床)`);
      assertPlain(disabledReason(t, s, 1), `disabledReason(${t}, 1 号床)`);
    }
  });

  /**
   * 全量扫：七关 × (未选床 + 八张床) × (开局 + 走一步之后)。
   *
   * 只检查已写过的那几条文案是不够的 —— 教练的措辞是按状态分支出来的，
   * 不把状态空间推开，就永远扫不到真正上屏的那一支。
   */
  it("所有关卡 × 每张床 × 两个时点，教练提示都说人话", () => {
    let checked = 0;
    for (const id of nightOrder) {
      const lv = levels[id] as unknown as LevelDef;
      const opening = createInitialState(lv);

      // 再推一步，让「手脏了 / 有人悬着 / 病历缺项」这些分支真的被走到
      let after = createInitialState(lv);
      const first = Object.keys(after.patients)[0];
      if (first) {
        const r = reduce(after, { type: "SCAN", patientId: first });
        if (r.accepted) after = r.state;
      }

      for (const st of [opening, after]) {
        for (const bed of [null, 1, 2, 3, 4, 5, 6, 7, 8]) {
          const h = coachHint(st, bed);
          assertPlain(`${h.title}。${h.body}`, `${id} / 选中 ${bed} / 第 ${st.turn} 回合`);
          checked++;
        }
      }
    }
    // 防空转：确认真的把每一种组合都过了一遍
    expect(checked).toBe(nightOrder.length * 2 * 9);
  });
});

describe("night-01 引导：镜像病例", () => {
  it("只说明「病历没写是哪一种、检测能拿到数据」，不预告不检测的后果", () => {
    const s = createInitialState(n01);
    const hint = coachHint(s, 1);
    expect(hint.highlight).toBe("scan");
    // 功能可提：检测是干什么的
    expect(hint.body).toMatch(/检测/);
    // 决策留给玩家：不能用「必然是错的 / 一定出错」这类机制答案去替他判断
    expect(hint.body).not.toMatch(/必然|一定错/);
    expect(hint.body).toMatch(/你自己判断/);
    expect(coachHint(s, null).highlightBed).toBe(1);
  });
});

describe("night-02 引导：邻床悬着时先顾邻床，而不是先忙传染源", () => {
  /**
   * 关键回归：教练绝不能劝玩家先去**处置 / 隔离**传染源。
   *
   * 信息纪律：谁在传是检测后才揭示的隐藏信息。检测 D01 之前（exposure = 0、
   * 源未揭示），教练预告「要被传了」＝免费剧透传染源 —— 必须闭嘴。
   * 检测之后（transmission 已揭示），教练立刻有资格指向邻床 —— 这个时点在**回合内**：
   * 布景帘废除后 night-02 开局谁都不受保护，H01（acuity 2）撑不过任何一个
   * 不隔离 D01 的回合末，所以不存在「空转一回合再看提示」的合法线。
   */
  function afterScan() {
    let s = createInitialState(n02);
    s = reduce(s, { type: "SCAN", patientId: "D01" }).state; // 第一次检测：风险画像
    s = reduce(s, { type: "SCAN", patientId: "D01" }).state; // 第二次检测：揭示「会传病」
    return s; // 不结束回合 —— 回合内提示
  }

  it("检测源之后（回合内），未选床时指向 3 号床的邻床（不是 3 号床本人）", () => {
    const s = afterScan();
    const hint = coachHint(s, null);
    expect(hint.highlight).toBe("bed");
    expect(hint.highlightBed).not.toBe(3);
    expect([2, 4, 7]).toContain(hint.highlightBed);
  });

  it("选中那位邻床后，提示把它治走（且明确给出「隔离」这个选项）", () => {
    const s = afterScan();
    const bed = coachHint(s, null).highlightBed!;
    expect(coachHint(s, bed).highlight).toBe("stabilize");
    expect(coachHint(s, bed).body).toMatch(/隔离/); // 明确给出两个选项
  });

  it("开局（源未揭示、无人被撞）教练只催检测，不预告传染也不催处置传染源", () => {
    const s = createInitialState(n02);
    const hint = coachHint(s, 3);
    // dose = 2 后邻床第一回合末就会升级，但教练必须在「检测」之后才有资格预告
    expect(hint.highlight).toBe("scan");
    expect(hint.highlight).not.toBe("stabilize");
    expect(hint.highlight).not.toBe("isolate");
    expect(hint.highlight).not.toBe("bed"); // 也不指邻床 —— 那是剧透
  });

  it("传染源被围严之后，教练不再把玩家拉到 2/4/7 号床", () => {
    const s = reduce(createInitialState(n02), { type: "ISOLATE", patientId: "D01" }).state;
    // 源的三条缝全挂上帘后，教练不该再把玩家往邻床带
    expect([2, 4, 7]).not.toContain(coachHint(s, null).highlightBed);
  });
});
