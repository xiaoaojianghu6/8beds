/**
 * 倒计时审计：`forecast.ts` 报的「还有几个回合会死」和 `reducer.ts` 实际走出来的
 * 回合数，是不是同一个数。
 *
 * 为什么值得一个工具：`forecast.ts` 是本作唯一**直给结论数字**的模块
 * （「算得出但看不见的（几回合死）必须直给」是设计原则）。直给的前提是它对 ——
 * 它一旦和 reducer 分家，玩家就是拿着一个错的倒计时去做决策，而且完全无从察觉。
 * 两边的静态单测各自都是绿的：它们测的是各自的假设，测不到「对同一个人给出两个答案」。
 *
 * 做法（全程走真实 `reduce()`，不直接改被测字段）：
 *   1. 把患者收上床（已在床上的直接用）
 *   2. 反复「只花 1 手、且不碰被观测者」把 AP 逼到 0，触发回合结算
 *      —— 这样「这一个回合末到底涨了几点」是可观测的
 *   3. 逐回合对照：界面的预测 vs 实际涨的档数
 *
 * v2 时期这个工具是围绕「未检测就治 → 不可逆通道」写的（观测那个通道的 +1）。
 * 2026-09-17 误诊改成当帧判死后，那段观测对象不复存在，于是改造为对**所有患者**
 * 做自然病程审计，另加一段误诊判负的实况。审计的仍然是同一件事：直给的数字对不对。
 */
import { levels } from "../src/levels";
import { createInitialState } from "../src/core/state";
import { reduce } from "../src/core/reducer";
import { actionCost, legalActions, nextAdmittable } from "../src/core/rules";
import { countdown, countdownText, DEATH_ACUITY } from "../src/ui/forecast";
import type { GameState, Patient, PlayerAction } from "../src/core/types";

const lvArg = process.argv[2] ?? "night-01";
const level = levels[lvArg];
if (!level) {
  console.error(`没有这一关：${lvArg}`);
  process.exit(1);
}

/**
 * 把目标送上床。**必须走真实的 `legalActions()`** ——
 * `ADMIT` 的动作只带床位号，收谁由 `queue[0]` 决定（`rules.nextAdmittable`），
 * 不能指定患者。所以「能不能观测这个人」的前提是他刚好排在队首、且有床。
 */
function admitTarget(s: GameState, pid: string): GameState | null {
  if (s.patients[pid].bedId != null) return s;
  if (nextAdmittable(s) !== pid) return null;
  const action = legalActions(s).find((a) => a.type === "ADMIT");
  if (!action) return null;
  const r = reduce(s, action);
  return r.accepted ? r.state : null;
}

/**
 * 把这一回合的手花光，逼出一次回合结算 —— 用的动作**绝不碰被观测的人**。
 *
 * 三条挑选规则：
 *   1. 目标不是被观测者；
 *   2. 成本 1 手（这里审计的是回合末的病程规则，不是 AP 经济 —— 人为压预算不影响结论）；
 *   3. **不碰未检测的 MIRROR 患者**。他现在的处置是当帧判负（Contract §5.3），
 *      拿他当烧 AP 的靶子会让探针自己把这一局打死，观测直接中断。
 *
 * 用 `legalActions()` 而不是手工拼候选：它就是要被信任的那份「什么能做」的权威，
 * 手工拼会让探针变成第二个真相来源。
 */
function burnToTurnEnd(s: GameState, pid: string): GameState | null {
  s.ap = 1;
  const spare = legalActions(s).filter((a: PlayerAction) => {
    if ("patientId" in a && a.patientId === pid) return false;
    if (actionCost(s, a) !== 1) return false;
    if (a.type === "STABILIZE") {
      const t = s.patients[a.patientId];
      if (t.axisIntervention === "MIRROR" && !t.revealed.includes("riskProfile")) return false;
    }
    return true;
  });
  for (const a of spare) {
    const r = reduce(s, a);
    // 「这一回合结算过了」的判据不能只看 turn 有没有涨：`resolvePhase` 一旦判负
    // 就在 `state.turn += 1` **之前** return（reducer.ts 的 LOSE 早返回），
    // 所以致命的那一次结算 `turn` 是不动的。漏掉这一条，探针会在病人刚死的
    // 那一刻假装「推不动回合」，把最关键的观测吞掉。
    const resolved = r.state.turn !== s.turn || r.state.outcome !== "ONGOING";
    if (r.accepted && resolved) return r.state;
    if (process.env.TRACE_BURN) {
      console.log(
        `      [TRACE] ${JSON.stringify(a)} accepted=${r.accepted} ` +
          `turn ${s.turn}→${r.state.turn} outcome=${r.state.outcome} events=${r.events.join("|")}`,
      );
    }
  }
  return null;
}

/** 自然病程审计：界面报几个回合死，实际就是几个回合末死吗。 */
function auditNaturalCourse(pid: string): void {
  let s = createInitialState(level);
  const p0 = s.patients[pid];
  if (!p0) {
    console.log(`  ${pid}: 这一关没有这个患者`);
    return;
  }
  if (p0.bedId == null) {
    const admitted = admitTarget(s, pid);
    if (!admitted) {
      console.log(`  ${pid}: 收不进来（不在队首 / 没有空床），跳过`);
      return;
    }
    s = admitted;
  }

  const start = s.patients[pid];
  console.log(
    `  ${pid}  初始 acu=${start.acuity}  rate=${start.deteriorationRate}  clock=${start.deteriorationClock}`,
  );
  const pred = countdown(start);
  console.log(
    `    界面说：「${countdownText(start).text}」  （预测 ${pred.turnsToDeath ?? "永不"} 个回合末到死线 ${DEATH_ACUITY}）`,
  );

  let ends = 0;
  let stalled = false;
  let perturbed = false;
  for (let step = 0; step < 8; step++) {
    const before = s.patients[pid];
    if (!before.alive) break;
    if (before.acuity >= DEATH_ACUITY) break;

    const beforeAcu = before.acuity;
    const beforeTurn = s.turn;
    const advanced = burnToTurnEnd(s, pid);
    if (!advanced) {
      console.log(
        `    ⚠ 第 ${beforeTurn} 回合推不动（没有可烧的 1 手动作）。ap=${s.ap} queue=${JSON.stringify(s.queue)}`,
      );
      stalled = true;
      break;
    }
    s = advanced;
    ends += 1;
    const after = s.patients[pid];
    // 被旁边床传染抬升过 ⇒ 这一次观测**不是**纯自然病程，不能拿它当倒计时的反例。
    // 探针自己烧 AP 时会碰别的病人（脏手 → 暴露），所以这是常见干扰，必须显式排除，
    // 否则工具天天误报 —— 一个会喊狼来了的审计比没有审计更糟。
    // ⚠ 必须用 `startsWith`：事件是 `EXPOSURE_ESCALATE:<id>:<...>`，带后缀。
    if (
      s.history.some((h) =>
        h.events.some((e) => e.startsWith(`EXPOSURE_ESCALATE:${pid}`)),
      )
    ) {
      perturbed = true;
    }
    console.log(
      `    第 ${beforeTurn} 回合末：acu ${beforeAcu} → ${after.acuity}（+${after.acuity - beforeAcu}）` +
        (perturbed ? "  ← 被传染抬升过，本次观测作废" : ""),
    );
    if (perturbed) break;
  }

  const end = s.patients[pid];
  let verdict: string;
  if (perturbed) {
    verdict = "— 观测受污染（他被旁边床传染抬升过），本次不判定自然病程";
  } else if (pred.turnsToDeath == null) {
    verdict = end.alive
      ? `✓ 界面说「不会自己加重」，观测到的 ${ends} 个回合末确实没加重${
          stalled ? "（没有更多可烧的手，观测提前结束）" : ""
        }`
      : "✗ 界面说不会加重，实测死了";
  } else if (stalled && end.alive) {
    verdict = `— 观测不完整（推不动回合），只走了 ${ends} 个回合末，不下结论`;
  } else if (end.alive) {
    verdict = "✗ 界面给了死期，实测没死";
  } else {
    verdict =
      ends === pred.turnsToDeath
        ? `✓ 预测 ${pred.turnsToDeath} 个回合末 = 实测 ${ends} 个回合末`
        : `✗ 预测 ${pred.turnsToDeath} 个回合末，实测 ${ends} 个回合末`;
  }
  // 结算次数自己数 —— 不能拿 `s.turn - 1` 推：致命的那次结算判负早返回，turn 不涨。
  console.log(`    结局：acu=${end.acuity} alive=${end.alive}，观测到 ${ends} 次回合末结算`);
  console.log(`    ${verdict}\n`);
}

/** 误诊判负实况（Contract §5.3）：不检测就治 MIRROR 患者，当帧就结束。 */
function auditMisdiagnosis(pid: string): void {
  let s = createInitialState(level);
  const p0 = s.patients[pid];
  if (!p0) return;
  if (p0.bedId == null) {
    const admitted = admitTarget(s, pid);
    if (!admitted) {
      console.log(`  ${pid}: 不在床上也收不进来，无法演示误诊判负\n`);
      return;
    }
    s = admitted;
  }
  const r = reduce(s, { type: "STABILIZE", patientId: pid });
  const p = r.state.patients[pid];
  console.log(
    `  ${pid}  未检测就治 → accepted=${r.accepted} outcome=${r.state.outcome}` +
      ` alive=${p.alive} deaths=${r.state.deaths}`,
  );
  console.log(`    events: ${r.events.join("  ")}`);
  const next = reduce(r.state, { type: "HAND_HYGIENE" });
  console.log(`    判负之后还能再动吗：accepted=${next.accepted} events=${next.events.join("|")}\n`);
}

const init = createInitialState(level);
const all = Object.values(init.patients) as Patient[];
const mirrors = all.filter((p) => p.axisIntervention === "MIRROR");

console.log(`=== ${lvArg}：${all.length} 名患者（MIRROR ${mirrors.length} 人）===\n`);
console.log("── 自然病程倒计时（所有患者）──");
for (const p of all) auditNaturalCourse(p.id);

if (mirrors.length) {
  console.log("── 误诊判负（MIRROR 患者：不检测就动手）──");
  for (const p of mirrors) auditMisdiagnosis(p.id);
} else {
  console.log("（这一关没有 MIRROR 患者，误诊判负不适用）");
}
