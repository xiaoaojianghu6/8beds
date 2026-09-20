/**
 * 死亡贴士 —— 失败结算页上的「真实病例 + 专业结论」。
 *
 * ── 它是什么 ──────────────────────────────────────────────────
 * 玩家打输一夜，看到的不能只是「你做错了第几步」。这个文件把玩家踩的那个坑
 * 接回现实世界里**真实发生过的事**：一个真实病名、一条真实的病理机制、
 * 一组真实发表过的数字。目标是让「我输了一局桌游」变成「我刚才推错了
 * 一种会死人的病」。
 *
 * ── 文案纪律在这里的边界（2026-09-17 用户拍板 + 追问）────────────
 * 用户原话一：「你的贴士不能说空话，这里唯一需要极度专业的地方，
 * 用真实疾病，专业知识术语，真实医疗事故，不要解释性话语」。
 * 用户原话二（看到「谵妄」这个标题之后）：「谵妄啥意思，这是医学专业术语？
 * 医学术语可以用，其他一律不准看不懂」。
 *
 * 这两句话合起来，边界并不在「专不专业」，而在**这个词出现在哪**：
 *
 *   ① **真实疾病名 / 诊断名 / 真实处置原则** —— 随便用（主动脉夹层、静脉溶栓、
 *      抗凝禁忌、脓毒性休克、张力性气胸、MRSA、军团菌…）。玩家不认识没关系，
 *      他读完这段就认识了，而且学到的是真东西。
 *   ② **本作自造的机制名** —— 任何位置都不许出现（帘轨 / 升档 / 档位 / 缺口 /
 *      隐匿 / 缓冲 / 顶过线…）。玩家读完什么也没学到，只多背一句我们的黑话。
 *   ③ **既是真实诊断名、玩家又看不懂，而病房里已经有一个通俗名的词** —— 目前只有
 *      「谵妄」一个（病房里一律叫「神志不清」，见 `Ward.ts` 的床卡与右栏）。
 *      规则：**可以出现在正文里当医学知识，绝不允许出现在标题上**。
 *      标题是索引 —— 玩家扫一眼「这局我错在哪」，那里只能用他在病房里见过的词。
 *
 * 落地：`tests/copy.test.ts` 把上面第 ③ 条做成机器判据 —— `TIP_MEDICAL_TERMS`
 * 只收真实诊断名（当前恰好 1 个），且**标题一律不许含任何术语**（含这个白名单）。
 * 其余三条纪律照旧全量适用：不出现内部编号（见 `review.ts → whoIs()`）、
 * 不写缺主语的碎片、数字必须有出处。
 *
 * ── 结构：三段，不是四段 ──────────────────────────────────────
 * 原设计（`docs/level-design/08-DEATH-TIPS.md`）是四段，第四段是
 * 「下一次 —— 一句能落到动作上的建议」。**已删除**：
 *   · 它是纯说教，玩家重开一局不需要被念一遍「下次记得先点检测」；
 *   · 它把每条贴士拉长 30%，右栏放不下第三条；
 *   · 前三段讲的是事实，第四段讲的是我们想让玩家做的事 —— 混在一起，
 *     失败页就从「一份病例」退化成「一个教程弹窗」。
 * 现在剩下：① 你做了什么（归因）② 医学上（病名与机制）③ 现实里（真实事故）。
 *
 * ── 数字纪律（08 §0.2 / §12）──────────────────────────────────
 * 只要四段里出现百分比、例数、时长，就必须写 `source`——**短角标**，
 * 印在标题右边（完整引用写在 `docs/level-design/08-DEATH-TIPS.md`）。
 * 写不出出处的数字，要么删掉，要么改成模糊表述。
 * `tests/tips.test.ts` 机器强制这一条，并会卡住角标长度
 * （完整引用在 10px 下要占两三行，三条贴士叠起来直接把右栏撑爆）。
 *
 * 不引用具名患者个案，只引用已发表的系统性与统计结果。
 * 纯数据 + 纯函数，可单测。
 */
import type { GameState, Patient } from "../core/types";
import { whoIs } from "./review";

/** 触发来源。每一个都能在 `history[].events` 里找到确切的字符串。 */
export type TipTrigger =
  /** 没检测就治「两种方向相反的病」→ 误诊即刻判负 → `MISDIAGNOSIS:<id>:<branch>` */
  | "UNSCANNED_MIRROR"
  /** 该先查的病没查就治 → `STABILIZE_INEFFECTIVE:<id>:UNSCANNED` */
  | "SCAN_FIRST_SKIPPED"
  /** 该立刻动手的病却先去查 → `SCANNED:<id>` 且该患者是 DIRECT */
  | "DELAYED_DIRECT"
  /** 脏手碰下一个人 → `HAND_CONTAMINATED:<id>` */
  | "DIRTY_HANDS"
  /** 住进上一轮留下病菌的床 → `BED_UNIT_EXPOSURE:<id>:bed<n>` */
  | "BED_UNIT"
  /** 被旁边床传染、病情被抬起来 → `EXPOSURE_ESCALATE:<id>` */
  | "SPREAD"
  /** 错过抢救期限 → `WINDOW_CLOSED:<id>` */
  | "WINDOW_CLOSED"
  /** 旁边床坐着神志不清的人，多花了一只手 → `DELIRIUM_TAX:<id>` */
  | "DELIRIUM"
  /** 有人没撑住（自然恶化）→ `DETERIORATED:<id>` 且 `DIED:<id>` */
  | "TRIAGE"
  /** 回合用完还有人在病房 → `TIMEOUT` */
  | "TIMEOUT";

/**
 * 三段结构。`reality` 可缺 —— 没把握就不写（08 §0.3 第一条）。
 *
 * 没有第四段「下一次」：那是教程，不是病例。见文件头。
 */
export type TipSegments = {
  /** ① 你做了什么 —— 绑定游戏内的具体动作，可归因。 */
  you: string;
  /** ② 医学上 —— 真实病名、真实机制、真实处置原则。 */
  medicine: string;
  /** ③ 现实里 —— 真实发表过的病例与数字。 */
  reality?: string;
};

export type DeathTip = {
  id: string;
  trigger: TipTrigger;
  /**
   * 结算页上给这条贴士的短标题。写病名，不写「教训」。
   *
   * **标题一律不许含术语**（含 `TIP_MEDICAL_TERMS` 里那些真实诊断名）：
   * 它是索引，玩家扫一眼「这局我错在哪」用的，只能用他在病房里见过的词。
   * 临床名放到「医学上」那一段去讲，那里才是学东西的地方。
   * 机器判据：`tests/copy.test.ts → 贴士标题必须是没有术语的通俗句`。
   */
  label: string;
  /**
   * 只有患者的**主诉或原话**里出现这些词时，这条才优先命中。
   * 用途：把同一类错误（例如「没查方向就治」）分诊到具体的病上 ——
   * M1/M2/M3 三对镜像的病理完全不同。
   *
   * 刻意**不看 `keyClue`**：那条线索的写法经常是「压榨样，不是撕裂样」，
   * 两个病的关键词同时出现，分诊会分反（实测 night-02 的 4 号床就被分错了）。
   */
  match?: string[];
  segments: TipSegments;
  confidence: "A" | "B";
  /**
   * 这一条里**具体数字**的出处 —— 短角标，印在标题右边（例如「NEJM 1994」）。
   * 出现百分比、例数、人数、时长这类可被证伪的数字就必须有出处。
   * 完整引用写在 `docs/level-design/08-DEATH-TIPS.md`。
   */
  source?: string;
};

/** 段的显示顺序与标题。 */
export const TIP_SEGMENT_ORDER: Array<[keyof TipSegments, string]> = [
  ["you", "你做了什么"],
  ["medicine", "医学上"],
  ["reality", "现实里"],
];

/**
 * 结局页底部的免责声明。
 * 它是**必须**的：贴士讲的是真实医学内容，不加这句就越界成医疗建议。
 */
export const TIP_DISCLAIMER =
  "贴士里的疾病、数字和事故都出自公开文献，游戏里的病人是我们编的。本文不构成任何医疗建议，也不能当成看病的依据。";

export const TIPS: DeathTip[] = [
  // ── 方向反了 ────────────────────────────────────────────────
  {
    id: "T1-0",
    trigger: "UNSCANNED_MIRROR",
    label: "主动脉夹层 / 急性心肌梗死 · 治疗方向相反",
    segments: {
      you: "没做检查，你就把药推了进去。",
      medicine:
        "急性主动脉夹层与急性心肌梗死的首发症状可以完全一样，处理方向却相反：夹层要降压、镇痛，抗血小板与抗凝是禁忌；心梗则必须尽快抗血小板、抗凝、开通血管。决定方向的是影像，不是疼痛的性质。",
      reality:
        "国际急性主动脉夹层登记（IRAD）的 2538 例确诊患者里，4% 连一个经典表现（突发、剧痛、撕裂样痛）都没有 —— 只靠问诊和查体，无法把他们从心梗里挑出来。",
    },
    confidence: "A",
    source: "IRAD · 2538 例",
  },
  {
    id: "T1-1",
    trigger: "UNSCANNED_MIRROR",
    label: "高血压性脑出血误按急性脑梗死溶栓",
    match: ["炸", "呕吐", "最疼", "头痛"],
    segments: {
      you: "他喊头痛、呕吐，你按急性脑梗死给了溶栓药。",
      medicine:
        "高血压性脑出血与急性脑梗死在床旁无法区分，能分开它们的只有头颅 CT。已确诊的脑出血接受静脉溶栓（rt-PA）是绝对禁忌：已经凝住的血块被溶开，颅内血肿会在数小时内扩大，压向脑干。",
      reality:
        "一项汇总 3894 例接受静脉溶栓患者的研究中，128 例（3.3%）发生症状性颅内出血；这 128 人里有 52.3% 在医院内死亡。",
    },
    confidence: "A",
    source: "Yaghi · JAMA Neurol 2015",
  },
  {
    id: "T1-2",
    trigger: "UNSCANNED_MIRROR",
    label: "主动脉夹层误按急性冠脉综合征抗栓",
    match: ["撕", "后背"],
    segments: {
      you: "他说胸口像被撕开，你按急性冠脉综合征给了抗血小板药。",
      medicine:
        "急性主动脉夹层撕开的是主动脉内膜，血在血管壁里冲出一条假腔。阿司匹林、氯吡格雷、肝素、溶栓药 —— 抗栓治疗的每一步都在让血出得更多。",
      reality:
        "Hansen 等回顾该院连续 66 例急性主动脉综合征：39% 首诊判错，最常被当成急性冠脉综合征。这批被抗栓治疗的病人里，100% 用了阿司匹林、85% 用了肝素、12% 用了溶栓药；用抗栓药者大出血 38%（未用者 13%），院内死亡 27%（未用者 13%）。",
    },
    confidence: "A",
    source: "Hansen · Am J Cardiol 2007",
  },
  {
    id: "T1-3",
    trigger: "UNSCANNED_MIRROR",
    label: "低血糖脑病误按急性卒中",
    match: ["血糖", "糖尿病", "胰岛素", "冷汗", "没醒", "叫不醒"],
    segments: {
      you: "他怎么叫都不醒，你按急性脑梗死走流程。他的指尖血糖是 1.9 mmol/L。",
      medicine:
        "低血糖脑病是最经典的一类卒中模拟症。葡萄糖是脑组织唯一能快速利用的能源，持续低血糖会把神经元饿死，救不回来；静脉推注葡萄糖后，多数患者在几分钟内清醒。",
      reality:
        "一项 1557 例按卒中流程收治的队列里，137 例（8.8%）最终排除卒中；其中低血糖 15 例，占全部模拟症的 10.9%。",
    },
    confidence: "B",
    source: "Okano 等 · 队列 1557 例",
  },

  // ── 没查清就动手 ────────────────────────────────────────────
  {
    id: "T2-1",
    trigger: "SCAN_FIRST_SKIPPED",
    label: "诊断未确立即给药",
    segments: {
      you: "没做检查就给药。药没起作用，还白花了一只手。",
      medicine:
        "同一种表现背后可以是完全不同的疾病。诊断确立之前给药，等于把病人当成药物试验的受试者 —— 而且是没有知情同意的那种。",
      reality:
        "WHO 在八个国家的八家医院试行手术安全核对表，试点前后各纳入三千余名患者：术后死亡从 1.5% 降到 0.8%，并发症从 11% 降到 7%。这张表不治疗任何疾病，它只做了一件事 —— 强制在动手之前确认一次。",
    },
    confidence: "A",
    source: "WHO · NEJM 2009",
  },

  // ── 来不及了 ────────────────────────────────────────────────
  {
    id: "T3-1",
    trigger: "WINDOW_CLOSED",
    label: "脓毒性休克 · 抗生素时机",
    match: ["铁锈色痰", "发抖", "冷", "没力气"],
    segments: {
      you: "他在你眼里只是「有点发烧」。等你回过头，抢救期限已经关上。",
      medicine:
        "诊断是脓毒性休克，不是「烧得厉害」。判断它看的是器官灌注：收缩压下降、少尿、意识改变、乳酸升高 —— 不是体温。",
      reality:
        "一项纳入 2731 例脓毒性休克患者的研究：确诊后 1 小时内用上抗生素的存活率 79.9%；此后每延迟 1 小时，存活率下降 7.6%。",
    },
    confidence: "A",
    source: "Kumar · Crit Care Med 2006",
  },
  {
    id: "T3-2",
    trigger: "WINDOW_CLOSED",
    label: "急性缺血性卒中 · 再灌注时间窗",
    match: ["偏瘫", "嘴歪", "说不出", "叫不醒", "手动不了"],
    segments: {
      you: "你把他排在后面。等轮到他，灌注时间窗已经关上。",
      medicine:
        "急性缺血性卒中。脑组织每分钟约有 190 万个神经元死亡，静脉溶栓与机械取栓的获益随时间快速衰减。",
      reality:
        "静脉溶栓的时间窗从 3 小时放宽到 4.5 小时，机械取栓从 6 小时推到 24 小时 —— 每一次放宽靠的都是更严格的影像筛选，从来不是更慢的处理。",
    },
    confidence: "A",
    source: "Saver 2006 · ECASS III 2008",
  },
  {
    id: "T3-3",
    trigger: "WINDOW_CLOSED",
    label: "STEMI · 门-球时间与院内病死率",
    match: ["胸口", "胸痛", "压", "酸"],
    segments: {
      you: "他胸痛已经 40 分钟，你先去处理了别人。",
      medicine:
        "急性 ST 段抬高型心肌梗死（STEMI）。救治核心只有一件事：尽早开通梗死相关血管。坏死心肌的范围与缺血时间成正比。",
      reality:
        "美国国家心血管数据登记 43801 例直接 PCI 的 STEMI 患者：门-球时间 30 分钟时院内病死率 3.0%，60 分钟 3.5%，90 分钟 4.3%，120 分钟 5.6%，180 分钟 8.4%。90 分钟以内这条曲线仍在往上走 —— 90 分钟是管理指标，不是风险的起点。",
    },
    confidence: "A",
    source: "Rathore · BMJ 2009 · 43801 例",
  },

  // ── 传染没拦住 ──────────────────────────────────────────────
  {
    id: "T4-1",
    trigger: "SPREAD",
    label: "军团病 · 传染源控制",
    segments: {
      you: "你把看起来最重的人围了起来。真正在往外传的那个，还留在原地。",
      medicine:
        "传染源控制与重症救治是两个目标。传播链不断，救治只能追着新增病例跑，永远慢一步。",
      reality:
        "1976 年 7 月，费城美国退伍军人协会年会期间暴发军团病：221 例发病、34 例死亡，最终从酒店空调冷却塔分离出嗜肺军团菌。221 例里有 72 例从未进入过会场 —— 有人只是从酒店门口走过。",
    },
    confidence: "B",
    source: "CDC · 费城 1976",
  },
  {
    id: "T4-2",
    trigger: "SPREAD",
    label: "聚集性发病本身即证据",
    segments: {
      you: "几个人先后出现同一种症状，你当成互不相关处理。",
      medicine:
        "短时间内同一种疾病聚集出现，这件事本身就是流行病学证据。散发病例看个体，聚集病例看环境。",
      reality:
        "军团病就是这样被定义出来的：同一栋楼里先后病倒这件事构成了全部证据 —— 在此之前，它甚至不算一种已知的疾病，它只是一种「聚集」。",
    },
    confidence: "A",
  },

  // ── 手卫生 ──────────────────────────────────────────────────
  {
    id: "T5-1",
    trigger: "DIRTY_HANDS",
    label: "接触传播 · 手卫生",
    segments: {
      you: "你刚处理完一个会排菌的病人，手没洗就去碰下一个。",
      medicine:
        "接触传播。手是 MRSA、VRE、艰难梭菌、碳青霉烯类耐药肠杆菌在病房里最主要的载体。世界卫生组织把它归纳成手卫生五个时刻。",
      reality:
        "1847 年维也纳总医院，Semmelweis 发现由尸检室直接进入产房的第一病区，产褥热死亡率 18.3%；改用氯化石灰溶液洗手后降到 2.2%。他生前被同行排斥，死于精神病院。",
    },
    confidence: "B",
    source: "Semmelweis · 维也纳 1847",
  },
  {
    id: "T5-2",
    trigger: "DIRTY_HANDS",
    label: "手卫生依从性与 MRSA 感染率",
    segments: {
      you: "你一次次没洗手。手上带的病原体，够整间病房转一圈。",
      medicine:
        "手卫生依从性由流程、洗手设施的可达性与监督决定，不由自觉决定。三个环节缺一个，依从率就回到原点。",
      reality:
        "Pittet 等在一家教学医院推行多模式干预：手卫生依从率从 48% 升到 66%，同期 MRSA 感染率从 2.16 降到 0.93 例／万患者日。",
    },
    confidence: "B",
    source: "Pittet · Lancet 2000",
  },

  // ── 床没洗干净 ──────────────────────────────────────────────
  {
    id: "T6-1",
    trigger: "BED_UNIT",
    label: "床单元终末清洁消毒",
    segments: {
      you: "人还没到该走的时候，你把他送走了，床当场空出来。下一个人住了进去。",
      medicine:
        "床单元终末清洁消毒。MRSA、VRE、艰难梭菌能在床栏、床垫、床头柜这些无生命表面上存活数日至数月。人走了，病原体不一定走。",
      reality:
        "Datta 等的研究：前一位住户是 MRSA 或 VRE 携带者时，后继病人获得同种病原体的风险升高约 40%；强化终末清洁后，MRSA 获得率从 3.0% 降到 1.5%。",
    },
    confidence: "A",
    source: "Datta · Arch Intern Med 2011",
  },

  // ── 只能救一个 ──────────────────────────────────────────────
  {
    id: "T7-1",
    trigger: "TRIAGE",
    label: "检伤分类 · 资源不足时的排序规则",
    segments: {
      you: "这一夜你的手只有这么多。你把手给了另一个人，他没能等到。",
      medicine:
        "检伤分类。在资源绝对不足时，按「存活概率与所需资源」排序分配救治力量，是标准做法，不是放弃。",
      reality:
        "1983 年，美国加州 Hoag 医院与纽波特海滩消防局制定 START 检伤法：只凭呼吸频率、脉搏、能否听从指令三项，在几十秒内给每个伤员贴一张颜色标签。这套规则存在的意义，就是承认你会救不完 —— 并让「先救谁」不再取决于现场谁的声音更大。",
    },
    confidence: "A",
    source: "START 检伤法 · 1983",
  },
  {
    id: "T7-2",
    trigger: "TIMEOUT",
    label: "人力配置是结局的独立因素",
    segments: {
      you: "回合用完了，还有人留在病房里。",
      medicine:
        "人力配置与工作负荷是患者结局的独立影响因素。少做一件事往往不是懒，是手不够 —— 这是配置问题，不是道德问题。",
      reality:
        "美国医学研究所 1999 年的报告《To Err Is Human》估计，每年有 4.4 万至 9.8 万例住院患者死于可以预防的医疗差错。这份报告把「医疗差错」从个人失职，重新定义成了系统缺陷。",
    },
    confidence: "A",
    source: "IOM 报告 · 1999",
  },

  // ── 突然变糊涂 ──────────────────────────────────────────────
  {
    id: "T8-1",
    trigger: "DELIRIUM",
    label: "神志不清 · 先找病因，别按住他",
    segments: {
      you: "他把病房闹得不得安宁，你当成捣乱的人，没去找原因。",
      medicine:
        "病房里那个神志不清、又喊又闹的人，医学上叫「谵妄」：急性起病、病程波动、注意力障碍。它通常不是脑本身出了毛病，而是全身疾病的脑表现 —— 感染、缺氧、尿潴留、疼痛、药物、电解质紊乱都是常见诱因。首选做法是找病因，不要按住他，也不要先让他睡着：身体约束和过度镇静本身会加重它、拖长住院。",
      reality:
        "Inouye 等纳入 852 例住院老年患者：以早期活动、减少镇静、定向提示等非药物措施组成的干预方案，把神志不清的发生率从 15.0% 降到 9.9%。",
    },
    confidence: "A",
    source: "Inouye · NEJM 1999",
  },
  {
    id: "T8-2",
    trigger: "DELIRIUM",
    label: "护理负荷与 30 天死亡风险",
    segments: {
      you: "他闹了一整夜，你没有处理。旁边两张床的治疗都被拖慢了。",
      medicine:
        "神志不清（医学上叫「谵妄」）的患者，照护工时消耗显著高于同龄人。一个失控的人会吃掉不成比例的照护力气 —— 这是护理负荷问题，不是病人的品行问题。",
      reality:
        "Aiken 等对 168 家医院、232342 名住院患者的研究：护士每多负责一名病人，患者在 30 天内死亡的风险上升 7%。",
    },
    confidence: "A",
    source: "Aiken · JAMA 2002",
  },

  // ── 该动手时先去查了 ────────────────────────────────────────
  // T10-0 是 DELAYED_DIRECT 的**无关键词兜底**：凡是给「直接处置有效」的病人
  // 先做了检测、且主诉对不上 T10-1 的，都落到这里 —— 所以它必须写成立场通用、
  // 不点名任何病种的文案（曾写成张力性气胸第二篇，698/698 局全部错配）。
  {
    id: "T10-0",
    trigger: "DELAYED_DIRECT",
    label: "看得出来的病 · 检查等得起，人等不起",
    segments: {
      you: "他的病看一眼就能定下来，你却先把手花在了检查上。",
      medicine:
        "急诊的判断分两类：一类不查不知道，得靠化验和影像说话；另一类靠眼睛和手就能定下来 —— 血压、呼吸、神志、脉搏，这些查体发现本身就是诊断。对后一类病人，检查不是治疗的前置步骤，而是插在治疗前面的耽误。",
      reality:
        "耽误的代价被精确算过：脓毒性休克确诊后，正确抗生素每晚 1 小时启用，存活率下降约 7.6%。等一张不影响决策的化验单，付的就是这个价。",
    },
    confidence: "A",
    source: "Kumar · Crit Care Med 2006",
  },
  {
    id: "T10-1",
    trigger: "DELAYED_DIRECT",
    label: "张力性气胸 · 吸不上气先减压",
    match: ["喘不上气", "吸不进来", "吸不到底", "胸口疼", "刀扎"],
    segments: {
      you: "他已经吸不上气了，你先去给他约了检查。",
      medicine:
        "张力性气胸靠查体就能确诊：患侧呼吸音消失、气管向对侧偏移、颈静脉怒张、血压下降。此时血压低不是血容量不足，是腔静脉回流被胸膜腔内高压挡住，心脏装不进血 —— 补液没用，立即穿刺减压是唯一管用的办法。",
      reality:
        "针刺减压失败与穿刺点胸壁厚度直接相关：一项 680 例的 CT 复核显示，第二肋间胸壁厚度平均 46 mm，一半病人超过 50 mm，标准 5 cm 穿刺针扎不到胸膜腔。文献争的是穿刺点与针长，没有一篇把它变成「等影像确认」。",
    },
    confidence: "A",
    source: "Inaba · Arch Surg 2012",
  },

  // ── T7-3（补齐 night-00 的空白，SOLUTIONS §4.2）───────────────
  //
  // 这个 id 曾经叫 `G1`，改名的原因：`G1` 在同一套文档里已经有两个别的意思 ——
  //   ① 求解器闸门「G1 零感染线可解」（`tools/curtain-gates.ts`、`SOLVER.md`）
  //   ② 内容缺口编号「G1 活动性出血」（`SOLUTIONS.md §4.2`）
  // 于是「§3 的 E12 该挂 G1」这句话，读者无法判断它指的是贴士还是缺口。
  // 归入 `T7` 家族（`TRIAGE` 触发），与 T7-1 / T7-2 同组。
  {
    id: "T7-3",
    trigger: "TRIAGE",
    label: "活动性出血 · 先止血，后修补",
    match: ["血"],
    segments: {
      you: "他一直在出血，你先去做了别的，没先给他止血。",
      medicine:
        "活动性出血的抢救原则是先止血、再修补。血压低不等于「血不够」：大量补液把血压硬拉回来，反而冲掉已经凝住的血块，让血出得更多。",
      reality:
        "1994 年一项研究把 598 名躯干中弹、血压已经掉下来的伤员分成两组：一组在送到医院之前就大量输液，另一组只扎上针、等进手术室再输。结果等到手术室才补液的那组活下来 70%，一上来就猛补液的只有 62%。",
    },
    confidence: "A",
    source: "Bickell · NEJM 1994",
  },
];

/**
 * 一条贴士在某一局里的实例：贴士本体 + 「说的是谁」。
 *
 * `subject` 用玩家看得见的东西指人（「4 号床 · 偏头痛」），
 * 绝不用内部编号 —— 这是 `review.ts` 那条纪律的同一个来源。
 */
export type TipView = {
  id: string;
  label: string;
  subject: string | null;
  segments: TipSegments;
  confidence: "A" | "B";
  /** 数字出处的短角标，印在标题右边（完整引用见 08-DEATH-TIPS.md）。 */
  source?: string;
};

/** 触发的重要程度。数字越小越先讲 —— 先讲「人是怎么没的」，再讲「哪一步埋了雷」。 */
const TRIGGER_ORDER: Record<TipTrigger, number> = {
  UNSCANNED_MIRROR: 0,
  SCAN_FIRST_SKIPPED: 1,
  TRIAGE: 2,
  // WINDOW_CLOSED 排在 SPREAD 之前（2026-09-18）：LOW 同速（dose = 2）之后传染升级
  // 几乎局局发生，SPREAD finding 泛滥 —— 若「错过抢救期限（人留了残疾）」排在它后面，
  // 真实对局里窗过期贴士几乎永远挤不进「一局最多 3 条」。
  WINDOW_CLOSED: 3,
  SPREAD: 4,
  DELIRIUM: 5,
  DIRTY_HANDS: 6,
  BED_UNIT: 7,
  DELAYED_DIRECT: 8,
  TIMEOUT: 9,
};

/** 匹配用的文本：主诉 + 原话。**不含 `keyClue`** —— 见 `DeathTip.match` 的说明。 */
function haystack(p: Patient): string {
  return `${p.chiefComplaint}${p.utterance}`;
}

function scoreOf(tip: DeathTip, p: Patient): number {
  if (!tip.match) return 0;
  const hay = haystack(p);
  return tip.match.reduce((n, kw) => (hay.includes(kw) ? n + 1 : n), 0);
}

/**
 * 同一 `trigger` 下多条候选时的取舍条件（08 §11.3「同一 trigger 只出一条」）。
 *
 * 为什么集中成一张表而不是散在每条贴士上：这些条件是**状态判据**，不是内容属性。
 * 集中之后一眼能看出「哪些 trigger 有分岔」，也方便测「两条例外互斥、各能触发」。
 * 这张表是唯一权威 —— 贴士本体上不再重复声明。
 */
const WHEN: Partial<Record<string, "ISOLATED_SOMEONE" | "NEVER_ISOLATED" | "EARLY" | "LATE">> =
  {
    // 「围错了人」vs「压根没围」：靠 history 里有没有一次成功的隔离来分。
    "T4-1": "ISOLATED_SOMEONE",
    "T4-2": "NEVER_ISOLATED",
    // 08 §11.3：同一 trigger 多条时按关卡递增顺序取，教学关给最直白的。
    "T5-1": "EARLY",
    "T5-2": "LATE",
    "T8-1": "EARLY",
    "T8-2": "LATE",
  };

/** 这一夜玩家到底有没有围过人 —— 决定「围错了人」还是「压根没围」。 */
function isolatedSomeone(state: GameState): boolean {
  return state.history.some((h) => h.accepted && h.action.type === "ISOLATE");
}

function whenOk(tip: DeathTip, state: GameState): boolean {
  const when = WHEN[tip.id];
  if (!when) return true;
  const night = Number(state.nightId.slice(-2));
  if (when === "ISOLATED_SOMEONE") return isolatedSomeone(state);
  if (when === "NEVER_ISOLATED") return !isolatedSomeone(state);
  if (when === "EARLY") return night <= 4;
  return night >= 5;
}

/**
 * 在一组候选里挑一条：先按关键词命中数，再按声明顺序。
 *
 * 关键词一条都没命中时，退回到该 trigger 下**不带 match** 的那条通用贴士
 * （例如「主动脉夹层 / 急性心肌梗死 · 治疗方向相反」）。这是必要的：
 * A 面镜像患者误诊时，套一条讲脑出血溶栓的贴士会教错东西。
 */
function pick(candidates: DeathTip[], p: Patient | null, state: GameState): DeathTip | null {
  const usable = candidates.filter((t) => whenOk(t, state));
  if (usable.length === 0) return null;
  const generic = usable.filter((t) => !t.match);
  if (!p) return generic[0] ?? usable[0];
  const scored = usable
    .filter((t) => (t.match?.length ?? 0) > 0)
    .map((t) => ({ t, s: scoreOf(t, p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  if (scored.length) return scored[0].t;
  return generic[0] ?? usable[0];
}

type Finding = { trigger: TipTrigger; pid: string | null };

/** 从 `history` 里把「这一夜做错了哪几件事」挖出来。 */
function findings(state: GameState): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const push = (trigger: TipTrigger, pid: string | null): void => {
    const k = `${trigger}|${pid ?? ""}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ trigger, pid });
  };

  const scannedDirect = new Set<string>();
  const deteriorated = new Set<string>();
  const died = new Set<string>();
  const windowClosed = new Set<string>();

  const pidOf = (e: string): string | null => {
    const parts = e.split(":");
    return parts.length >= 2 ? parts[1] : null;
  };

  for (const h of state.history) {
    if (!h.accepted) continue;
    for (const e of h.events) {
      // 误诊 = 未揭示的镜像患者被治 ⇒ `actions.ts → misdiagnose()` 当帧判负。
      // 它取代了已删除的 `REVERSE_INTERVENTION`（那条通道可补救，2026-09-17 移除）。
      if (e.startsWith("MISDIAGNOSIS")) push("UNSCANNED_MIRROR", pidOf(e));
      else if (e.startsWith("STABILIZE_INEFFECTIVE")) push("SCAN_FIRST_SKIPPED", pidOf(e));
      else if (e.startsWith("HAND_CONTAMINATED")) push("DIRTY_HANDS", pidOf(e));
      else if (e.startsWith("BED_UNIT_EXPOSURE")) push("BED_UNIT", pidOf(e));
      else if (e.startsWith("EXPOSURE_ESCALATE")) push("SPREAD", pidOf(e));
      else if (e.startsWith("DELIRIUM_TAX")) {
        // 格式 `DELIRIUM_TAX:<被治的人>:<闹的人>` —— 贴士要指的是**闹的那个**，
        // 不是无辜被多收一只手的人。
        const parts = e.split(":");
        push("DELIRIUM", parts[2] ?? parts[1] ?? null);
      } else if (e.startsWith("SCANNED")) {
        const id = pidOf(e);
        if (id) scannedDirect.add(id);
      } else if (e.startsWith("DETERIORATED")) {
        const id = pidOf(e);
        if (id) deteriorated.add(id);
      } else if (e.startsWith("DIED")) {
        const id = pidOf(e);
        if (id) died.add(id);
      } else if (e.startsWith("WINDOW_CLOSED")) {
        const id = pidOf(e);
        if (id) windowClosed.add(id);
      }
    }
  }

  for (const id of windowClosed) push("WINDOW_CLOSED", id);
  for (const id of died) {
    // 「该立刻动手的病却先去查了」只算埋雷，不算死因，所以先记；
    // 死因归到「没撑住 / 被传染」上，玩家才不会以为是检查害死的。
    if (deteriorated.has(id)) push("TRIAGE", id);
  }
  for (const id of scannedDirect) {
    const p = state.patients[id];
    if (p && p.axisIntervention === "DIRECT") push("DELAYED_DIRECT", id);
  }
  if (state.history.some((h) => h.events.includes("TIMEOUT"))) push("TIMEOUT", null);

  return out;
}

/**
 * 这一局该给玩家看哪几条贴士。
 *
 * 规则（08 §11 选取逻辑）：
 *   1. 按 `trigger` 的重要程度排序 —— 先讲真正让人没了的那个原因
 *   2. 同一 `trigger` 只出一条（三条贴士不该说同一件事）
 *   3. 同一 `trigger` 多条候选时，按患者原话里的关键词分诊
 *   4. 一局最多 `max` 条（默认 3，超过会稀释情绪）
 */
export function resolveTips(state: GameState, max = 3): TipView[] {
  const found = findings(state);
  const byTrigger = new Map<TipTrigger, Finding[]>();
  for (const f of found) {
    const list = byTrigger.get(f.trigger) ?? [];
    list.push(f);
    byTrigger.delete(f.trigger);
    byTrigger.set(f.trigger, list);
  }

  const ordered = [...byTrigger.keys()].sort(
    (a, b) => (TRIGGER_ORDER[a] ?? 99) - (TRIGGER_ORDER[b] ?? 99),
  );

  const views: TipView[] = [];
  for (const trigger of ordered) {
    if (views.length >= max) break;
    const candidates = TIPS.filter((t) => t.trigger === trigger);
    if (candidates.length === 0) continue;
    const occ = byTrigger.get(trigger)!;
    // 大多数 trigger 一局只出一条（三条贴士不该说同一件事）。
    // 例外：WINDOW_CLOSED —— 关卡里有**两个**带抢救期限的人（如地狱关），
    // 两个人错过的是两种完全不同的病（溶栓窗 vs 门-球时间），各讲各的才说得清。
    // 但**超时局**除外：超时这一局的教学焦点是「时间不够」（T7-2），
    // 两条窗贴士会把它的名额挤掉 —— 超时局窗口仍只讲一条。
    const isTimeout = state.history.some((h) => h.events.includes("TIMEOUT"));
    const cap = trigger === "WINDOW_CLOSED" && !isTimeout ? 2 : 1;
    const usedTips = new Set<string>();
    let chosenCount = 0;
    for (const f of occ) {
      if (chosenCount >= cap || views.length >= max) break;
      // `pid` 为 null 的 finding（TIMEOUT —— 指向整晚，不指向某个人）要放行：
      // 这里的跳过只该管「该有人却找不到人」，曾经写成 `if (!p) continue`
      // 把 T7-2 在所有超时局里全部拦死（死内容 19/20 的根因，2026-09-18）。
      const p = f.pid ? (state.patients[f.pid] ?? null) : null;
      if (f.pid && !p) continue;
      // 两轮：**先找一条关键词命中的** —— 「主动脉夹层误按急性冠脉综合征抗栓」
      // 这种能分诊到具体病的，永远优先于通用那条；一个都没命中时才用通用贴士。
      let chosen: { tip: DeathTip; pid: string | null } | null = null;
      const withMatch = candidates.filter((t) => (t.match?.length ?? 0) > 0 && !usedTips.has(t.id));
      if (withMatch.length > 0) {
        const tip = pick(withMatch, p, state);
        if (tip && p && scoreOf(tip, p) > 0) {
          chosen = { tip, pid: f.pid };
        }
      }
      if (!chosen) {
        const tip = pick(
          candidates.filter((t) => !usedTips.has(t.id)),
          p,
          state,
        );
        if (tip) chosen = { tip, pid: f.pid };
      }
      if (!chosen) continue;
      usedTips.add(chosen.tip.id);
      chosenCount += 1;
      const cp = chosen.pid ? state.patients[chosen.pid] : null;
      views.push({
        id: chosen.tip.id,
        label: chosen.tip.label,
        // 指人一律走 `review.ts → whoIs()`：床位 + 主诉，永不回退到内部编号。
        subject: cp ? whoIs(state, cp) : null,
        segments: chosen.tip.segments,
        confidence: chosen.tip.confidence,
        source: chosen.tip.source,
      });
    }
  }
  return views;
}
