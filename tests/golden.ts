/**
 * 七关的「黄金指标」—— 由 `tools/gold.ts` / `tools/curtain-gates.ts` 实测，充当回归护栏。
 *
 * 为什么存指标而不是直接存动作序列：动作序列在求解器换一种等价的 tie-break 时
 * 会毫无意义地爆红；而真正需要钉死的是**设计意图**（最小 AP、余量、隔离的必要程度、
 * 感染预算）。动作序列本身的正确性由 solver.test.ts 的
 * 「重放求解器路径必须真的获胜」保证 —— 那条测试同时覆盖指纹碰撞与剪枝错误。
 *
 * 数字一旦要改，先问：是设计改了，还是求解器改了？
 *   - 设计改了 → 先改 spec/SIMULATION_CONTRACT.md，再改这里
 *   - 求解器改了 → 这里不该动，说明求解器有 bug
 *
 * ── 现行定价（Contract §4.1）──────────────────────────────
 *   急救 1 手 · 治愈 2 手 · 隔离 1 手 · 收治/检测 1 手
 *   每回合 3 手（全局）。详见 docs/level-design/12-HAND-ECONOMY.md。
 *   只有两档：v2 的第三档「补救」随误诊改判死一并删除（见下）。
 *
 * ── 误诊即刻判死（2026-09-17 用户拍板）───────────────────────
 *   MIRROR 患者不检测就处置 = **当帧判负**（`MISDIAGNOSIS` → 死亡 → `LOSE`），
 *   不依赖回合末结算；检测后处置 = 自动执行正确方案。
 *   旧模型的「读体征赌方向」被否决：玩家没有医学知识，「赌方向」是出题不是技能。
 *   代价：每关 3 个镜像患者各 +1 手检测费，minAP 全面上抬，回合数用 turns 旋钮重新配平。
 *
 * ── 余量纪律（用户拍板 + 镜像反转修订）──────────────────────
 *   T = turns × actionPoints，目标余量 0，容忍 ≤2，≥3 不合规。
 *   旧纪律的「minAP 必须是偶数」建立在「镜像可赌赢、无需检测」上；
 *   反转后每关 +3 手使 minAP 变为奇数（15/27），偶数 T 只能配出奇余量，
 *   故 night-01/02/04 直接取 T = minAP（奇数 T、余量 0），night-03 余量 1。
 */
export type LevelGolden = {
  /** 最小 AP 消耗（不是动作数：病危档 3 手、治愈档 2 手、隔离 1 手） */
  minAP: number;
  /** 余量 = turns × actionPoints − minAP */
  slack: number;
  /** 最优解里 ISOLATE 出现的次数 */
  isolates: number;
  /** 重放最优解后的终局事实 */
  infections: number;
  deaths: number;
  discharged: number;
  totalPatients: number;
  /** 搜索是否穷尽（false = 结论不可信） */
  exhausted: boolean;
};

export const GOLDEN: Record<string, LevelGolden> = {
  /**
   * 交班：4 人 / 12 AP / 4 回合。无镜像，镜像反转不影响本关。
   * 教「治愈要两只手」—— 旧定价下是 8 手，分档后是 12 手，零余量因此仍然成立。
   */
  "night-00": {
    minAP: 12,
    slack: 0,
    isolates: 0,
    infections: 0,
    deaths: 0,
    discharged: 4,
    totalPatients: 4,
    exhausted: true,
  },
  /**
   * 先分真假：4 人 / 15 AP / 5 回合。教镜像轴（检测 → 处置）。
   *
   * 镜像反转后的配平：B01（床旁镜像）、B02（到场镜像）各需 检测1+治愈2，
   * B03 从镜像改为 DIRECT（三个「收治+检测+治愈」= 4 手的链在 3 手/回合下
   * 无法都塞进窗口期，求解器穷尽证实 T=15 装不下；镜像教学由 B01/B02 承担）。
   * B02/B03 的 deteriorationRate 降为 0：队列患者的走廊宽限在排队时已烧完，
   * rate-1 的两段链会在恶化螺旋里死锁。时间压力集中在 A01（rate 1，急救演示）。
   * 回合数 4 → 5（T 12 → 15）。
   * 2026-09-17 D1 修复（处置当回合不结算自然恶化，Contract §4）后
   * minAP 15 → 14、余量 0 → 1（T 单数，合规）。
   */
  "night-01": {
    minAP: 14,
    slack: 1,
    isolates: 0,
    infections: 0,
    deaths: 0,
    discharged: 4,
    totalPatients: 4,
    exhausted: true,
  },
  /**
   * 邻床：7 人 / 27 AP / 9 回合。教传播与隔离。
   *
   * 源 D01 是 **LOW**（不是 HIGH）：HIGH 源 + 两个 ac1 邻床会让两人在 T2 末必死，
   * 除了隔离别无解 —— 那会把隔离变成**必做项**，违反「没有必做项」。
  /**
   * 邻床：7 人 / 27 AP / 9 回合。教传播与隔离。
   *
   * 2026-09-18 剂量统一为 2（LOW 也一回合传染）后，硬扛线被击穿：
   * 最优解 27 AP / 余量 0 / **隔离 ×1** —— 隔离成为管住源的第一反应，
   * 禁用隔离无解。旧命题「隔离不是必做项」被用户裁决取代
   * （机制引入即持续复用；感染预算判负同步废除）。
   */
  "night-02": {
    minAP: 27,
    slack: 0,
    isolates: 1,
    infections: 0,
    deaths: 0,
    discharged: 7,
    totalPatients: 7,
    exhausted: true,
  },
  /**
   * 帘后：8 人 / 26 AP / 9 回合。教「两个传染源 + 一张唯一的隔离帘」。
   *
   * 与 night-02 的差别不是数值，是**场上有两个源**：
   * 明显的 P01@3 和隐形的 M01@6。两个源都是 SCAN_FIRST ——
   * 典型肺炎（P01）要培养确认，无症状定植（M01）更是非培养不可。
   * 2026-09-18 最终裁定（帘 = 隔离本身，全场唯一）后：开局没有帘，
   * M01 从第一回合就漏风 —— 玩家必须在「围谁」上做真正的选择，
   * 而且围了新人，旧人的帘就撤走。禁用隔离无解（实测穷尽）。
   */
  "night-03": {
    minAP: 26,
    slack: 1,
    isolates: 1,
    infections: 0,
    deaths: 0,
    discharged: 8,
    totalPatients: 8,
    exhausted: true,
  },
  /**
   * 看不见的手：6 人 / 23 AP / 8 回合。教学包：手卫生、隐匿携带者、谵妄、床单元污染。
   *
   * 2026-09-18 最终裁定后重构：
   *   ① 布景帘废除 —— P01@2（HIGH）与 H01@1 相邻、M01 与 D01 的交叉火力全部裸露，
   *      7 回合被实测证伪（需求 23 > 供给 21），回合数 7 → 8。
   *   ② M01 挪到 8 号床（先试 7 号：与谵妄的 D01@6 相邻，仍是死锁），
   *      P01 的邻居只剩 H01/D01，「看不见的手」回归洗手与污染主题。
   *   ③ S01 到达改回**走廊**（预分配床位的「到达即入床」被用户判定为异常行为）。
   *   ④ 精确求解超节点护栏 —— 加入 night-06 的参考解模式（加权 A*，23 手可重放）。
   * 最优打法隔离 ×2（P01、S01），但禁用隔离线同为 23 AP（差一次感染）——
   * 本关隔离是「干净线」的选择，洗手/污染才是教学主体。
   */
  "night-04": {
    minAP: 23,
    slack: 1,
    isolates: 2,
    infections: 0,
    deaths: 0,
    discharged: 6,
    totalPatients: 6,
    exhausted: false,
  },
  /**
   * 长夜：8 人 / 24 AP / 8 回合 · 密度 6/8（第一个高密度关，原 night-04 顺延）。
   *
   * 新增机制教学：时间窗（S01 脓毒症窗 3 回合，sequelaLimit 0 —— 慢了就留后遗症，
   * 「故意放任错过窗口省 2 手」的反向激励被零后遗症约束堵死）、
   * 走廊压力（queueLimit 2，超员全体恶化）、手卫生与床单元污染延续（R2 只增不减）。
   * 2026-09-18 最终裁定后：布景帘废除，N02 必吃一次感染（最优解 24 AP / 感染 1），
   * 隔离 P01 仍是正收益手 —— 禁用隔离无解（实测穷尽）。
   */
  "night-05": {
    minAP: 24,
    slack: 0,
    isolates: 1,
    infections: 1,
    deaths: 0,
    discharged: 8,
    totalPatients: 8,
    exhausted: true,
  },
};

/**
 * night-04（看不见的手）的设计不变量 —— 2026-09-18 最终裁定后实测（加权 A*）。
 *
 * 布景帘废除后两个 HIGH 源裸露，本关靠「挪人」重配平：
 * M01（8 床）远离 D01 的谵妄邻域；S01 回归走廊到达。
 * 允许/禁用隔离两线同为 23 AP —— 差别只在感染（0 vs 1）：
 * 隔离是本关的「干净线」，洗手/床单元污染才是教学主体。
 */
export const NIGHT04_DESIGN = {
  /** 关卡预算：8 回合 × 3 手 = 24，余量 1（T 双数、余量单数，合规） */
  turns: 8,
  /** G2：禁用隔离仍可解 —— 但要吃一次感染 */
  noIsolateSolvable: true,
  noIsolateMinAP: 23,
  noIsolateInfections: 1,
  withIsolateMinAP: 23,
  withIsolateInfections: 0,
  /** Δ = 0：同价，隔离买的是「零感染」 */
  delta: 0,
  /** S01 的到达方式：走廊（2026-09-18 用户裁定：到达即入床是异常行为） */
  arrivalViaCorridor: { patient: "S01", turn: 2 },
  /** H02 的干预轴：出血源看不见 → 先检测 */
  h02AxisIntervention: "SCAN_FIRST",
  /** 两个 HIGH 源的落位：P01@2 照着 H01@1；M01 挪到 8 床躲开谵妄的 D01@6 */
  sourceBeds: { P01: 2, M01: 8 },
  h01DeteriorationRate: 0,
} as const;

/**
 * night-02 的设计不变量 —— 由 `npx vite-node tools/iso-value.ts night-02` 实测。
 *
 * 这一关的教学点是「隔离不是必做项，但它买余量」：
 *   允许隔离：27 AP，余量 0，1 次隔离，0 次感染
 *   禁用隔离：27 AP，余量 0，0 次感染  ← 仍可解 = 「没有必做项」的机器化证据
 *
 * **为什么源必须是 LOW**：曾把 D01 设成 HIGH，结果 G01@4 与 E01@7 在 T2 末双双
 * 触及 acuity 3 —— 除了隔离别无解，隔离成了必做项。降为 LOW 后升级变慢，
 * 硬扛来得及把人治走，隔离才退回成「可选的一种打法」。
 * 2026-09-17 D1 修复后病人恶化更慢，最优解连隔离都不用了（隔离 ×0、0 感染）。
 */
export const NIGHT02_DESIGN = {
  /**
   * 2026-09-18 重配平：剂量统一为 2（一回合不隔离就传染）后，
   * 隔离从「风格选择」变成「最优解的第一反应」—— 27 AP / 余量 0 / 隔离 ×1。
   * 禁用隔离无解：这不是「没有必做项」的违规，而是用户裁决后的新命题
   * 「机制引入即持续复用」在这关的机器化证据。
   */
  sourceTransmission: "LOW",
  withIsolateMinAP: 27,
  withIsolateSlack: 0,
  withIsolateCount: 1,
  /** 禁用隔离线：无解 = 隔离是必做项（用户裁决：隔离自 02 起必用） */
  noIsolateSolvable: false,
  isolateCost: 1,
  sourceBed: 3,
  exposedBeds: [2, 4, 7],
  shieldedBeds: [],
} as const;

/**
 * night-05（长夜）的设计不变量 —— 2026-09-18 最终裁定后实测。
 *
 * 隔离在本关是**不可替代的一手**：P01（3 床 HIGH）同时照着 N01（2 床）与 N02（4 床），
 * 围住 P01 是唯一同时保住两条命的 1 手。禁用隔离实测**无解**（穷尽）——
 * 两个受害者住在走廊压力与时间窗的夹缝里，谁也扛不住漏风。
 */
export const NIGHT05_DESIGN = {
  minAP: 24,
  slack: 0,
  /** 最优解隔离 ×1 */
  isolates: 1,
  infections: 1,
  /** 禁用隔离线：无解（实测穷尽）—— 隔离在这一夜是承重墙 */
  noIsolateSolvable: false,
  turns: 8,
  density: "6/8",
  initialBeds: [1, 2, 3, 4, 6, 8],
  sourceBeds: [3],
  /** 双受害者：P01 经 2-3、3-4 两条开缝同时照着两个人 */
  doubleVictimBeds: [2, 4],
  /** T01 急救位：rate 2，第一回合必须先给他 2 手 */
  t01Rate: 2,
} as const;

/**
 * night-06「八张床」（地狱关）的参考解 —— 2026-09-18 最终裁定（帘 = 隔离本身，全场唯一）后重排。
 *
 * **诚实的限定**：本关 9 患者 × 10 回合的状态空间超出本机穷尽求解器的内存护栏，
 * 这里锁的是**可重放的参考解**而不是被证明最小的 minAP —— 29 手是该搜索纪律下的
 * 最好已知值（加权 A* 实测，重放获胜）。
 *
 * 回归护栏语义（与其他关不同）：`golden.test.ts` 重放这条确定性路径，断言
 * 它在 10 回合内获胜且事实吻合。任何机制改动若破坏这条路径，测试立刻红。
 *
 * 教学事实（重放验证）：
 *   出院 9/9 · 死亡 0 · 感染 0 · 后遗症 1/1 · 隔离 1 · 洗手 1
 *   —— 第一手检测两条链、第二回合隔离 P01（P01@4 对 H01 漏风，不围 T2 末就出事）；
 *   第九回合前必须洗手再碰 K02（脏手直接治疗会把 K02 当场推死）。
 *   —— 最优打法**故意放弃 N01**（脑梗死，窗 3）：他的后遗症名额是全场
 *   最便宜的「出院」。地狱关的题眼：决定谁带着遗憾离开。
 */
export const NIGHT06_REFERENCE = {
  /** 参考解的总手数（上界性质，见上） */
  hands: 29,
  turns: 10,
  infections: 0,
  deaths: 0,
  discharged: 9,
  sequela: 1,
  isolates: 1,
  washes: 1,
  path: [
    { type: "SCAN", patientId: "N02" },
    { type: "SCAN", patientId: "H01" },
    { type: "ISOLATE", patientId: "P01" },
    { type: "STABILIZE", patientId: "D01" },
    { type: "ADMIT", bedId: 6 },
    { type: "STABILIZE", patientId: "H01" },
    { type: "SCAN", patientId: "K01" },
    { type: "STABILIZE", patientId: "K01" },
    { type: "ADMIT", bedId: 1 },
    { type: "STABILIZE", patientId: "N02" },
    { type: "SCAN", patientId: "J01" },
    { type: "STABILIZE", patientId: "J01" },
    { type: "ADMIT", bedId: 1 },
    { type: "SCAN", patientId: "K02" },
    { type: "STABILIZE", patientId: "C01" },
    { type: "SCAN", patientId: "P01" },
    { type: "HAND_HYGIENE" },
    { type: "STABILIZE", patientId: "K02" },
    { type: "STABILIZE", patientId: "K02" },
    { type: "STABILIZE", patientId: "P01" },
    { type: "STABILIZE", patientId: "P01" },
  ],
} as const;

/**
 * night-04「看不见的手」的参考解 —— 与 night-06 同一模式（精确求解超节点护栏，
 * 加权 A* 实测 23 手，重放获胜）。隔离 ×2（P01 → S01），第二枚隔离**同时演示了
 * 全场唯一规则**：围上 S01 的那一刻，P01 的帘自动撤走 —— 那时 P01 周围已经清空，
 * 这正是「帘跟着人走」的正确用法。
 */
export const NIGHT04_REFERENCE = {
  hands: 23,
  turns: 8,
  infections: 0,
  deaths: 0,
  discharged: 6,
  isolates: 2,
  washes: 1,
  path: [
    { type: "STABILIZE", patientId: "D01" },
    { type: "ISOLATE", patientId: "P01" },
    { type: "STABILIZE", patientId: "H01" },
    { type: "STABILIZE", patientId: "H01" },
    { type: "ADMIT", bedId: 7 },
    { type: "SCAN", patientId: "S01" },
    { type: "ISOLATE", patientId: "S01" },
    { type: "STABILIZE", patientId: "S01" },
    { type: "ADMIT", bedId: 5 },
    { type: "SCAN", patientId: "H02" },
    { type: "STABILIZE", patientId: "M01" },
    { type: "SCAN", patientId: "P01" },
    { type: "HAND_HYGIENE" },
    { type: "STABILIZE", patientId: "H02" },
    { type: "STABILIZE", patientId: "H02" },
    { type: "STABILIZE", patientId: "P01" },
    { type: "STABILIZE", patientId: "P01" },
  ],
} as const;
