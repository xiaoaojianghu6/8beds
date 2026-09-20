/**
 * 全项目「面向玩家的文字必须说人话」的机器护栏。
 *
 * 这条纪律来自用户三次连续的反馈：
 *   ① 「那些说明，状态显示，极度不友好，文字完全不说人话……搞得玩的人看不懂」
 *   ② 「什么缝开，什么谵妄，这说什么呢？去除所有文艺化表达，
 *      让小学生、老人家能听明白，直白，像新闻联播那样所有人能听懂的话」
 *   ③ 「什么叫还有一个缺口？什么叫不会自己变差？什么叫把他顶过线？
 *      你要把意思表达清楚！」「那一堆 N01、s01、t01，这什么鬼？
 *      不要有表意不明的东西出现」「玩家能自己通过变化／动画看见，你还提示个啥？」
 *
 * 于是黑名单有**三**张，缺一张都不算守住：
 *   1. `JARGON`     —— 内部术语与文艺化表达（缝、谵妄、定植、暴露…）
 *   2. `FRAGMENTS`  —— 缺主语的碎片（不会自己变差、顶过线、还有 N 个缺口…）
 *   3. `PATIENT_ID` —— 内部编号（N01 / S01 / T01）。屏幕上指人只能用「4 号床」。
 *
 * 覆盖面刻意做得比 `coach.test.ts` 宽：那里只查教练文案，这里查**所有会出现在屏幕上的字**：
 *   - `levels/*.json` 的**全部字符串**（递归遍历，不假设字段路径）
 *   - `src/` 全部字符串字面量（`Ward.ts` / `Menu.ts` 依赖 Phaser，不能 import，所以扫源码）
 *   - `forecast.ts` / `review.ts` 的运行时输出（七关都真的打到失败再检查）
 *
 * 往表里加词之前，先确认它在界面上的替代说法已经在用。
 */
import { describe, expect, it } from "vitest";
import { reduce } from "../src/core/reducer";
import { createInitialState } from "../src/core/state";
import type { LevelDef } from "../src/core/types";
import { levels, nightOrder } from "../src/levels";
import { countdownText } from "../src/ui/forecast";
import { buildReview } from "../src/ui/review";
import { TIP_DISCLAIMER, TIP_SEGMENT_ORDER, TIPS, type DeathTip } from "../src/ui/tips";

/**
 * `src/` 全部源码的原文。用 Vite 的 raw glob 而不是 `node:fs` ——
 * 这个项目没有装 `@types/node`，而 vitest 本来就跑在 Vite 里。
 */
const SOURCES = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 禁词。用正则是因为「缝」要放过「缝合」这种正当用法。 */
const JARGON: Array<[string, RegExp]> = [
  ["缝（缺口）", /缝(?!合)/],
  ["帘轨", /帘轨/],
  ["谵妄", /谵妄/],
  ["暴露", /暴露/],
  ["升档", /升档/],
  ["档位", /档位/],
  ["阈值", /阈值/],
  ["定植", /定植/],
  ["隐匿", /隐匿/],
  ["体征", /体征/],
  ["处置", /处置/],
  ["剂量", /剂量/],
  ["缓冲", /缓冲/],
  ["不可逆", /不可逆/],
];

function findJargon(text: string): string[] {
  return JARGON.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/**
 * 允许在**贴士正文**里出现的术语白名单 —— 只收**真实疾病名 / 诊断名**。
 *
 * 起因：这里原本是一条「`ui/tips.ts` 整个文件豁免 JARGON」的规则。它解决了一个
 * 真问题（贴士必须能写「主动脉夹层」「静脉溶栓」），但**开得太宽**，于是
 * 「谵妄」这个标题活了下来 —— 而病房里对这个病人一律叫「神志不清、又喊又闹」
 * （`Ward.ts` 床卡与右栏），患者主诉是「躁动」。玩家在病房里没见过「谵妄」，
 * 到结算页突然看到，会以为是另一件事。用户当场追问：「谵妄啥意思，
 * 这是医学专业术语？医学术语可以用，其他一律不准看不懂」。
 *
 * 收窄的办法不是「再多禁几个词」，而是先问：**贴士真的需要豁免吗？**
 * 实测（`tools/tip-jargon-probe.ts`）当时全库只命中 3 个词：
 *   · 谵妄 ×4 —— 病房里有通俗名，改掉
 *   · 处置 ×1、不可逆 ×1 —— 有等价的通俗说法，改掉
 * 而贴士真正要用的专业词汇（主动脉夹层 / 静脉溶栓 / 抗凝 / 脓毒性休克 /
 * 张力性气胸 / MRSA / 军团菌 …）**本来就不在 JARGON 表里**，从来不需要豁免。
 *
 * ⇒ 所以豁免从「整个文件」缩成「一个词」，且这个集合本身被下面的测试断言。
 *   JARGON 表里另外 13 个词（帘轨 / 升档 / 档位 / 缺口 / 隐匿 / 缓冲 …）是本作
 *   自造的机制名，**任何位置、包括贴士，都不许出现**。
 */
const TIP_MEDICAL_TERMS = new Set<string>(["谵妄"]);

/**
 * 只有这一个文件可以用上面的白名单。多一个文件就是多一个缺口。
 */
const TIP_FILE = "ui/tips.ts";

/**
 * 一条贴士的术语违规清单。**标题与正文的判据不同**：
 *   · 标题：任何术语都算违规，白名单也不行（标题是索引，只能用病房里的词）
 *   · 正文：白名单里的真实诊断名放行，其余术语算违规
 *
 * 抽成独立函数是为了能喂**造假数据**做「扫描器自检」——
 * 不这么做的话，判据哪天退回「豁免整个文件」，测试仍然全绿（空转）。
 */
function tipViolations(tip: DeathTip): { label: string[]; body: string[] } {
  const body: string[] = [];
  const allow = (words: string[]) => words.filter((w) => !TIP_MEDICAL_TERMS.has(w));
  for (const seg of Object.values(tip.segments)) {
    if (typeof seg === "string") body.push(...allow(findJargon(seg)));
  }
  if (tip.source) body.push(...allow(findJargon(tip.source)));
  return { label: findJargon(tip.label), body };
}

/**
 * **内部编号**。`N01` / `S01` / `T01` 是数据结构，不是人。
 *
 * 用户原话：「那一堆 N01、s01、t01，这什么鬼？不要有表意不明的东西出现」。
 * 屏幕上指代一个病人只能用玩家看得见的东西：「4 号床」「走廊里排第一的那个」。
 */
const PATIENT_ID = /(?<![A-Za-z0-9])[A-Z]\d{2}(?![A-Za-z0-9])/;

/**
 * 缺主语的碎片（2026-09-16 二审）。用户原话：
 * 「什么叫还有一个缺口？什么叫不会自己变差？什么叫把他顶过线？你要把意思表达清楚！」
 * 每一条都有对应的完整句式，写进黑名单防止回退。
 */
const FRAGMENTS: Array<[string, RegExp]> = [
  ["不会自己变差", /不会自己变差/],
  ["撑不过这一回合", /撑不过这一回合/],
  ["最多再撑", /最多再撑/],
  ["顶过线 / 顶上去", /顶过线|顶上去/],
  ["缺口", /缺口/],
  ["口子", /口子/],
  // 用户点名删掉的机制复述：「隔离他会从其他地方抽走帘子这样的废话你就不要说了」。
  // 规则本身只在床位图例里说一次；**动作的后果**只在右栏按床列具体（哪两张床之间、那两人是谁）。
  // 提示 / 关卡文案里再出现「抽走」，就是又跑去念动画了。
  ["复述:抽走帘子", /抽走/],
];

function findFragments(text: string): string[] {
  return FRAGMENTS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** 关卡数据里「字段本身就是编号」的合法位置（患者 id），不算泄漏。 */
function isBareId(text: string): boolean {
  return /^[A-Z]\d{2}$/.test(text.trim());
}

/**
 * 死亡贴士的内部编号（`T1-1` … `T10-1`）。
 *
 * `T10-1` 恰好落在 `PATIENT_ID` 的形状里（`T` + 两位数字），会被误判成患者编号。
 * 豁免范围刻意收得极窄：**必须带那根连字符**，而真实的患者 id（`N01` / `S01`）
 * 是不带连字符的 —— 所以这条豁免藏不住任何一个真编号。
 * 贴士 id 只用于测试与文档对照，从不渲染到屏幕上。
 */
function isTipId(text: string): boolean {
  return /^T\d{1,2}-\d$/.test(text.trim());
}

/** 抠出一行里的字符串字面量。用于只对「会出现在屏幕上的字」做编号检查。 */
function literalsOf(line: string): string[] {
  return [...line.matchAll(/(["'`])((?:[^"'`\\]|\\.)*)\1/g)].map((m) => m[2]);
}

/** 去掉注释 —— 说明为什么这样写文案的注释里，本来就要引用这些术语。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 递归收集一个值里所有的字符串（带访问路径），用于全量扫描关卡文件。 */
function collectStrings(v: unknown, path = ""): Array<[string, string]> {
  if (typeof v === "string") return [[path, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => collectStrings(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
      collectStrings(x, path ? `${path}.${k}` : k),
    );
  }
  return [];
}

describe("文案纪律：关卡里的每一个字都说人话", () => {
  /**
   * 刻意**递归扫整个关卡文件**，而不是逐字段列举。
   * 原因：早先的版本写死了 `p.hidden.scanResult`，可实际数据在 `p.rules.scanResult` ——
   * 取到的永远是 undefined，`continue` 一走了之，护栏整个空转。
   * 「护栏空转」比「没有护栏」更危险，所以这里改成不假设任何路径。
   */
  it("关卡 JSON 里任何一处文字都不含术语，也不含内部编号", () => {
    let scanned = 0;
    const offenders: string[] = [];
    for (const id of nightOrder) {
      for (const [path, text] of collectStrings(levels[id])) {
        scanned++;
        const hits = findJargon(text);
        if (hits.length) offenders.push(`${id} → ${path} → ${hits.join("、")}：「${text}」`);
        // 编号只允许以「整串就是编号」的形式存在（那就是患者 id 字段本身）；
        // 一旦出现在任何成句的文字里，就是漏到玩家脸上了。
        if (!isBareId(text) && PATIENT_ID.test(text)) {
          offenders.push(`${id} → ${path} → 内部编号：「${text}」`);
        }
        const frag = findFragments(text);
        if (frag.length) offenders.push(`${id} → ${path} → ${frag.join("、")}：「${text}」`);
      }
    }
    // 防空转：确认真的扫到了东西（关卡文件里应该有成百上千个字符串）
    expect(scanned).toBeGreaterThan(200);
    expect(offenders).toEqual([]);
  });

  /** 护栏自检：往扫描器里塞一个含术语的假关卡，它必须报出来。 */
  it("扫描器自检：的确能抓到术语（防再次空转）", () => {
    const planted = { a: { b: [{ c: "把帘子拉上，开了个缝" }] } };
    const found = collectStrings(planted)
      .flatMap(([, t]) => findJargon(t));
    expect(found).toContain("缝（缺口）");
  });

  /** 护栏自检：编号与碎片也必须抓得到，否则黑名单只是摆设。 */
  it("扫描器自检：编号与缺主语的碎片都抓得到", () => {
    expect(isBareId("N01")).toBe(true); // 患者 id 字段本身合法
    expect(isBareId("4 号床的 N01")).toBe(false);
    expect(PATIENT_ID.test("开局 S01 就在红灯")).toBe(true);
    expect(PATIENT_ID.test("第 4 回合")).toBe(false);
    // 贴士 id 的豁免必须窄到藏不住真编号：带连字符才算贴士 id。
    expect(isTipId("T10-1")).toBe(true);
    expect(isTipId("T10")).toBe(false);
    expect(isTipId("N01")).toBe(false);
    expect(isTipId("T01")).toBe(false); // 形状像患者 id 的，仍然要走编号检查
    expect(findFragments("他的病情不会自己变差")).toContain("不会自己变差");
    expect(findFragments("还有 2 个缺口")).toContain("缺口");
    expect(findFragments("把自己治好，病会传出去")).toEqual([]);
    // 用户点名删掉的机制复述：提示里不该再跑去念「帘子被抽走」
    expect(findFragments("要围别人，就得从他这儿抽走")).toContain("复述:抽走帘子");
    // 而保留下来的**图例规则**（只陈述系统规则、不叙述某一次动作）必须不被误伤
    expect(findFragments("帘子一共只有 4 幅 —— 拉上一幅，同一条轨道上的另一幅就会被挤开")).toEqual([]);
  });

  it("关卡标题不含术语、碎片与内部编号", () => {
    for (const id of nightOrder) {
      const title = (levels[id] as unknown as LevelDef).title;
      expect(findJargon(title), `${id} 标题「${title}」`).toEqual([]);
      expect(findFragments(title), `${id} 标题「${title}」`).toEqual([]);
      expect(PATIENT_ID.test(title), `${id} 标题「${title}」`).toBe(false);
    }
  });
});

describe("文案纪律：src/ 里所有字符串字面量都说人话", () => {
  it("剥掉注释后，源码里不残留术语、碎片与内部编号（贴士只放行真实诊断名）", () => {
    const offenders: string[] = [];
    for (const [file, raw] of Object.entries(SOURCES)) {
      const short = file.replace("../src/", "");
      const body = stripComments(raw);
      for (const line of body.split("\n")) {
        // 只有贴士这一个文件能放行白名单里的**真实诊断名**；
        // JARGON 表里另外 13 个自造机制名，谁都不许用。
        const hits = findJargon(line).filter(
          (w) => !(short === TIP_FILE && TIP_MEDICAL_TERMS.has(w)),
        );
        if (hits.length) offenders.push(`${short} → ${hits.join("、")}：${line.trim()}`);
        const frag = findFragments(line);
        if (frag.length) offenders.push(`${short} → ${frag.join("、")}：${line.trim()}`);
        // 编号只对**字符串字面量**检查：颜色值（#1B2A41）这类十六进制不算编号。
        for (const lit of literalsOf(line)) {
          if (isBareId(lit)) continue;
          if (/^#?[0-9a-fA-F]{3,8}$/.test(lit)) continue;
          if (isTipId(lit)) continue; // 见 isTipId：豁免窄到藏不住真编号
          if (PATIENT_ID.test(lit)) offenders.push(`${short} → 内部编号：「${lit}」`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("文案纪律：运行时产出的文案也说人话", () => {
  /** 一段文字必须同时躲过三张黑名单：术语、缺主语的碎片、内部编号。 */
  function assertClean(text: string, where: string): void {
    expect(findJargon(text), `${where} 含术语：「${text}」`).toEqual([]);
    expect(findFragments(text), `${where} 含碎片：「${text}」`).toEqual([]);
    expect(PATIENT_ID.test(text), `${where} 含内部编号：「${text}」`).toBe(false);
  }

  it("倒计时文案：整句、有主语、不带碎片与编号", () => {
    const cases: Array<Partial<Parameters<typeof countdownText>[0]>> = [
      { acuity: 2, deteriorationRate: 0 },
      { acuity: 2, deteriorationRate: 1, deteriorationClock: 0 },
      { acuity: 2, deteriorationRate: 1, deteriorationClock: 1 },
      { acuity: 1, deteriorationRate: 1, deteriorationClock: 0 },
      { acuity: 0, deteriorationRate: 1, deteriorationClock: 0 },
    ];
    const base = Object.values(createInitialState(levels["night-00"] as unknown as LevelDef).patients)[0];
    for (const o of cases) {
      const { text, detail } = countdownText({ ...base, ...o } as typeof base);
      assertClean(text, `倒计时（acuity ${o.acuity}）`);
      if (detail) assertClean(detail, "倒计时 detail");
      // 必须有主语，否则就是「不会自己变差」那类碎片
      expect(text.startsWith("他") || text.startsWith("他的"), `缺主语：「${text}」`).toBe(true);
    }
  });

  it("失败复盘的每一行：不含术语、碎片与内部编号", () => {
    // 走几步真实动作，让复盘里出现「死亡 / 还没送走 / 下一把 / 做对了」各类行，
    // 而不是只检查一个空复盘。
    const lv = levels["night-00"] as unknown as LevelDef;
    let s = createInitialState(lv);
    for (const pid of ["A01", "A01", "A01", "A01", "A01", "A01"]) {
      if (s.outcome !== "ONGOING") break;
      s = reduce(s, { type: "STABILIZE", patientId: pid }).state;
    }

    const r = buildReview(s);
    assertClean(r.headline, "headline");
    for (const line of r.lines) assertClean(`${line.label}${line.body}`, line.label);
  });

  it("七关都真的打到失败，复盘里也找不到编号", () => {
    // 只测 night-00 会漏掉「有传染 / 有抢救期限 / 有残疾」那几类归因分支。
    // 这里每关都故意乱走，直到判负，然后逐行检查。
    let reviewed = 0;
    for (const id of nightOrder) {
      const lv = levels[id] as unknown as LevelDef;
      let s = createInitialState(lv);
      const order = Object.keys(s.patients);
      for (let i = 0; i < 60 && s.outcome === "ONGOING"; i++) {
        const pid = order[i % order.length];
        if (!s.patients[pid]?.alive) continue;
        // 交替做「检测」和「治疗」—— 最容易撞出误治与恶化的组合
        s = reduce(s, { type: i % 2 ? "STABILIZE" : "SCAN", patientId: pid }).state;
      }
      const r = buildReview(s);
      assertClean(r.headline, `${id} headline`);
      for (const line of r.lines) assertClean(`${line.label}${line.body}`, `${id} / ${line.label}`);
      reviewed++;
    }
    expect(reviewed).toBe(nightOrder.length);
  });

  /**
   * 贴士的术语边界（见 `TIP_MEDICAL_TERMS`）。四条一起锁：
   *
   *   1. **标题一律不许含术语**，白名单里的也不行 —— 标题是索引，
   *      必须用玩家在病房里见过的词（「神志不清」而不是「谵妄」）。
   *   2. **正文只许含白名单里的真实诊断名**，其余禁词一律命中即红。
   *   3. **白名单必须真的被用上** —— 一个永远不生效的白名单等于没有白名单，
   *      还会把「术语表保护了贴士」这层假象留在仓库里（术语「定植」当年
   *      就是靠空转活下来的）。
   *   4. 碎片与内部编号照旧全量适用，免责声明是普通 UI 文字、不给任何放行。
   *
   * 扫的是「段名：正文」这个**渲染后的组合**，而不是数据字段 —— 这样
   * 护栏和玩家看到的东西是同一份字符串（写死字段路径会空转，见文件头）。
   */
  it("死亡贴士：只放行真实诊断名，且标题一律不许含术语", () => {
    let scanned = 0;
    const jargoned: string[] = [];
    const labelOffenders: string[] = [];
    for (const tip of TIPS) {
      // 1. 标题必须通俗：任何术语（含白名单）都不许出现
      const v = tipViolations(tip);
      if (v.label.length) labelOffenders.push(`${tip.id} 标题「${tip.label}」→ ${v.label.join("、")}`);
      // 2/3. 正文：只放行白名单，别的命中就红
      if (v.body.length) jargoned.push(`${tip.id}：${v.body.join("、")}`);

      // 4. 碎片与内部编号：一条都不能有
      expect(findFragments(tip.label), `${tip.id} 标题含碎片`).toEqual([]);
      expect(PATIENT_ID.test(tip.label), `${tip.id} 标题含内部编号`).toBe(false);
      for (const [key, name] of TIP_SEGMENT_ORDER) {
        const body = tip.segments[key];
        if (!body) continue;
        scanned++;
        const rendered = `${name}：${body}`;
        expect(findFragments(rendered), `${tip.id}/${key} 含碎片：「${rendered}」`).toEqual([]);
        expect(PATIENT_ID.test(rendered), `${tip.id}/${key} 含内部编号：「${rendered}」`).toBe(false);
      }
      if (tip.source) {
        scanned++;
        expect(PATIENT_ID.test(tip.source), `${tip.id}/source 含内部编号`).toBe(false);
      }
    }

    // ── 扫描器自检：判据必须真的会咬 ────────────────────────────────
    // 这三条假数据分别对应三类真实发生过/差点发生的失败：
    //   ① 标题用临床名（「谵妄」当年就是这样活到线上的）
    //   ② 正文混进本作自造的机制名
    //   ③ 标题混进自造机制名
    // 判据一旦退化（例如又改回「整个文件豁免」），这里必须红。
    const fake = (label: string, medicine: string): DeathTip => ({
      id: "T99-9",
      trigger: "TIMEOUT",
      label,
      segments: { you: "他没能等到这一手。", medicine },
      confidence: "A",
    });
    const selfChecks: Array<[string, DeathTip, "label" | "body"]> = [
      ["标题用临床名", fake("谵妄 · 找病因", "急性起病、病程波动。"), "label"],
      ["正文混自造机制名", fake("神志不清 · 先找病因", "要把帘轨上每一幅帘子拉齐。"), "body"],
      ["标题混自造机制名", fake("升档 · 病情加重", "真实病程会继续往前走。"), "label"],
      ["正文混进未列名的词", fake("神志不清 · 先找病因", "这是本关的阈值为 4 点。"), "body"],
    ];
    for (const [why, bad, where] of selfChecks) {
      expect(
        tipViolations(bad)[where].length,
        `扫描器自检失败：「${why}」没有被判据抓到 —— 这条护栏是空的`,
      ).toBeGreaterThan(0);
    }
    // 反向自检：白名单里的词在**正文**里必须被放行，否则白名单机制本身是坏的
    expect(tipViolations(fake("神志不清 · 先找病因", "医学上叫「谵妄」。")).body).toEqual([]);
    // 而同一个词放在标题上必须被拦下
    expect(tipViolations(fake("谵妄 · 先找病因", "医学上叫「谵妄」。")).label).toContain("谵妄");

    expect(labelOffenders, "贴士标题出现了术语 —— 标题只能用玩家在病房里见过的词").toEqual([]);
    expect(jargoned, "贴士正文出现了自造机制名 —— 只有白名单里的真实诊断名可以留").toEqual([]);

    // 3. 白名单真的被用上了吗 —— 库里要真的出现白名单里的词
    const usedTerms = new Set<string>();
    for (const tip of TIPS) {
      for (const seg of Object.values(tip.segments)) {
        if (typeof seg !== "string") continue;
        for (const w of TIP_MEDICAL_TERMS) if (seg.includes(w)) usedTerms.add(w);
      }
    }
    expect(
      [...usedTerms].sort(),
      "白名单里的术语一个都没出现在贴士里 —— 这份豁免已经空了，该删掉它或者把专业内容补回来",
    ).toEqual([...TIP_MEDICAL_TERMS].sort());

    // 4. 免责声明是普通 UI 文字，不给任何放行
    assertClean(TIP_DISCLAIMER, "贴士免责声明");
    scanned++;
    // 防空转：库里每条至少两段（you / medicine，reality 可选）
    expect(scanned).toBeGreaterThan(40);
  });

  it("术语放行的范围写死且窄：一个词、一个文件", () => {
    // 白名单必须**恰好**是这些词 —— 多一个就是多一个缺口，必须由人来改这一行。
    expect([...TIP_MEDICAL_TERMS]).toEqual(["谵妄"]);
    // 放行只对这一个文件生效
    expect(TIP_FILE).toBe("ui/tips.ts");
    // 反证：同一个黑名单在别处仍然生效（白名单不许漏到别的文件）
    expect(findJargon("他谵妄了")).toContain("谵妄");
    expect(findJargon("床与床之间留着一道缝")).toContain("缝（缺口）");
    // 而带「缝合」的正当用法必须被放过（正则的负向前瞻）
    expect(findJargon("给伤口缝合")).toEqual([]);
    // 自造机制名不在白名单里 —— 贴士也不能用
    for (const w of ["帘轨", "升档", "档位", "隐匿", "缓冲", "定植", "体征", "处置", "剂量"]) {
      expect(TIP_MEDICAL_TERMS.has(w), `「${w}」不是真实诊断名，不该进白名单`).toBe(false);
    }
    // 而在贴士里，完整的句子写法不该被碎片表误伤
    expect(findFragments("抗栓治疗的每一步都在让血出得更多")).toEqual([]);
  });
});
