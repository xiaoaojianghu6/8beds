/**
 * 抢救期限（时间窗）可达性探针 —— 「这条后遗症路径真的能走到吗」。
 *
 * 起因：`tools/tips-audit.ts` 跑了 1918 局判负，`T3-1`（脓毒性休克）**一次都没出现**。
 * 它的触发条件是 `WINDOW_CLOSED`，而全项目只有 `night-05/S01` 一个人同时满足
 * 「窗内」+「症状词命中铁锈色痰那组」。所以问题收敛成一句：
 *
 *   **`night-05/S01` 的窗，能不能在它死之前走完？**
 *
 * 手算：S01 初始 acuity 1、`deteriorationRate` 1、`timeWindow` 3。
 * 回合末结算顺序是 `transmit → deteriorate → reapDead → tickWindows`。
 * 于是「不治疗」时 acuity 每回合 +1，第 2 个回合末就到 3 —— 在窗（第 3 回合末）关闭**之前**死掉。
 * 要让它活到窗关，玩家必须每回合花 1 手做急救档把它从 2 拉回 1，连拉两回合 ——
 * 也就是**花 3 手换一个必然判负的后遗症**。
 *
 * 本工具不靠推理，直接跑：用只含 S01 的最小关卡，按「只保命、不治愈」的策略走到底，
 * 打印每个回合末的 `acuity / windowClock` 与最终结局。
 *
 * 用法：`npx vite-node tools/window-reach.ts`
 */
import night05 from "../levels/night-05.json";
import { reduce } from "../src/core/reducer";
import { legalActions } from "../src/core/rules";
import { createInitialState } from "../src/core/state";
import { buildReview } from "../src/ui/review";
import { resolveTips } from "../src/ui/tips";
import type { GameState, LevelDef, PatientDef, PlayerAction } from "../src/core/types";

/**
 * `night-05/S01` —— **从关卡文件里取真身，不手抄**。
 *
 * 第一版探针手抄了一份精简定义，把 `hidden` / `revealOrder` 剥掉了，
 * 于是这个 `SCAN_FIRST` 患者没有任何可揭示的东西 ⇒ `legalActions` 里**没有 SCAN**
 * ⇒ 处置永远走「未检测无效」分支，acuity 纹丝不动。探针得出的结论全是假的。
 * 教训：不要把被测对象抄一遍 —— 抄的那一刻它就已经不是被测对象了。
 */
const ALL05 = [
  ...night05.initialPatients,
  ...night05.arrivalSchedule.flat(),
] as unknown as PatientDef[];
const S01: PatientDef = {
  ...ALL05.find((p) => p.id === "S01")!,
  // 唯一改动：直接放进 2 号床，让 windowClock 从 3 起算，省掉排期与收治的噪音。
  state: { bedId: 2 },
};

function makeLevel(): LevelDef {
  return {
    id: "probe",
    title: "抢救期限探针",
    turns: 10,
    actionPoints: 3,
    enabledActions: ["ADMIT", "SCAN", "STABILIZE", "HAND_HYGIENE"],
    rules: {
      infectionEnabled: false,
      maxDeaths: 0,
      maxInfectionEvents: 0,
      requiredDischarges: "ALL",
      sequelaLimit: 0,
      // 必须开：本作**没有「过回合」动作**，回合只在 ap 归零时结算。
      // 关了手卫生就没有任何「合法但纯浪费」的动作，探针会卡在第 1 回合。
      handHygieneEnabled: true,
      bedUnitEnabled: false,
    },
    initialPatients: [S01],
    arrivalSchedule: [],
  };
}

/** 每个回合末的一行观测。 */
function snap(st: GameState, note: string): string {
  const p = st.patients["S01"];
  return (
    `turn ${String(st.turn).padStart(2)}  ap=${st.ap}  ` +
    `acuity=${p.acuity}  windowClock=${p.windowClock}  sequela=${p.sequela ? "是" : "否"}  ` +
    `outcome=${st.outcome.padEnd(7)}  ${note}`
  );
}

/**
 * 跑一个策略。
 *
 * `scanFirst` 必须为真的那一种：S01 的轴是 `SCAN_FIRST` —— 不先检测就处置
 * 是**无效动作**（`STABILIZE_INEFFECTIVE`，白花 1 手、acuity 不动）。
 * 第一版探针忘了这条，于是「每回合花 1 手保命」连做三次而 acuity 纹丝不动。
 */
function run(
  label: string,
  keepAlive: (acuity: number) => boolean,
  scanFirst = false,
): void {
  let st: GameState = createInitialState(makeLevel());
  console.log(`\n── ${label} ────────────────────────────`);
  console.log(snap(st, "开局（S01 已在 2 号床，窗 3）"));
  let guard = 0;
  let scanned = !scanFirst;
  const trail: string[] = [];
  while (st.outcome === "ONGOING" && guard++ < 200) {
    const p = st.patients["S01"];
    let acted = false;
    if (!scanned && p.alive && !p.discharged) {
      const acts = legalActions(st) as PlayerAction[];
      const sc = acts.find((a) => a.type === "SCAN" && a.patientId === "S01");
      if (sc) {
        trail.push(`第 ${st.turn} 回合：先检测 S01`);
        st = reduce(st, sc).state;
        scanned = true;
        acted = true;
      }
    }
    if (!acted && p.alive && !p.discharged && keepAlive(p.acuity)) {
      const acts = legalActions(st) as PlayerAction[];
      const stab = acts.find((a) => a.type === "STABILIZE" && a.patientId === "S01");
      if (stab) {
        trail.push(`第 ${st.turn} 回合：给 S01 处置（acuity ${p.acuity} → ${p.acuity - 1}）`);
        st = reduce(st, stab).state;
        acted = true;
      }
    }
    if (!acted) {
      // 烧掉剩余手数，逼回合结算 —— 本作没有「过回合」动作。
      const acts = legalActions(st) as PlayerAction[];
      const burn = acts.find((a) => a.type === "SCAN" || a.type === "HAND_HYGIENE");
      if (burn) {
        const r = reduce(st, burn);
        st = r.accepted ? r.state : st;
        if (!r.accepted) break;
      } else if (acts.length) {
        const r = reduce(st, acts[0]);
        if (!r.accepted) break;
        st = r.state;
      } else break;
    }
    const lastEvents = st.history[st.history.length - 1]?.events ?? [];
    if (lastEvents.some((e) => /WINDOW|DIED|LOSE|TIMEOUT|DISCHARGED/.test(e))) {
      console.log(snap(st, lastEvents.filter((e) => /WINDOW|DIED|DISCHARGED|TIMEOUT/.test(e)).join(" ")));
    }
  }
  if (trail.length) console.log("   策略动作：" + trail.join("；"));
  const r = buildReview(st);
  const tips = resolveTips(st);
  console.log(`   终局：${st.outcome} · 归因 ${r.kind} · ${r.headline}`);
  console.log(`   贴士：${tips.map((t) => t.id).join(", ") || "（无）"}`);
}

const BLANK = " ".repeat(7);

console.log("抢救期限可达性探针 —— night-05/S01（acuity 1 · 窗 3 · 2026-09-17 起 rate 0，威胁全在窗上）");
run("策略 A：完全不救（玩家正常会做的）", () => false);
run("策略 B：先检测，之后只做急救档、从不治愈（分诊式半治）", (ac) => ac >= 2, true);
console.log(`\n${BLANK}结论：`);
console.log("  · 策略 A —— 不动手，窗照关：T3 末 WINDOW_CLOSED，S01 带着后遗症离开，判负归因 sequela。");
console.log("     → 贴士 T3-1（脓毒性休克）可达 —— 曾经 rate 1 时他死在关窗前，这条线是死的。");
console.log("  · 策略 B —— 同样关窗：只压不治买不来时间，抢救期限看的是「有没有在期限内完成治疗」。");
