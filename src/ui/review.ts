/**
 * 失败复盘 —— 「我到底输在哪一步」。
 *
 * 设计立场：失败界面**不复述规则，不喊口号，只回答三个问题**：
 *   ① 谁没了 / 谁没送走；
 *   ② 是哪一个回合、因为什么没的；
 *   ③ 下一把改哪一件事。
 *
 * 数据全部来自 `GameState`（`history` 每条都带 events 与回合号，判负也写在 events 里），
 * 所以复盘能精确到「第几回合、哪个事件」，不是泛泛的安慰话。
 *
 * ── 措辞纪律（2026-09-16 二审，两道红线）──────────────────────
 * ① **屏幕上绝不出现内部编号**。`N01` / `S01` 是数据结构，不是人。用户原话：
 *    「那一堆 N01、s01、t01，这什么鬼？」—— 这里一律改成「4 号床 · 受了外伤」，
 *    床位被清空的患者（已死亡 / 已出院）从 history 里把床位捞回来，永远不回退到编号。
 * ② **每句话必须是完整、有主语的句子**。「缺口」「顶过线」「传染风险 x/y」这类
 *    缺主语、要玩家自己脑补的碎片，一律不许上屏。
 *
 * 纯函数，可单测。
 */
import type { GameState, Patient } from "../core/types";

export type ReviewKind = "fatal" | "cause" | "gap" | "advice" | "good";

export type ReviewLine = {
  kind: ReviewKind;
  /** 短标签，如「死亡」。 */
  label: string;
  /** 一句话说清。 */
  body: string;
};

export type Review = {
  /** 顶部一句话结论。 */
  headline: string;
  /** 失败类型，供 UI 选措辞。 */
  kind: "deaths" | "sequela" | "timeout" | "unknown";
  lines: ReviewLine[];
};

/** 从 `A:pid:xxx` 形式的事件里抽患者 id（事件格式见 reducer）。 */
function pidOf(event: string): string | null {
  const parts = event.split(":");
  return parts.length >= 2 ? parts[1] : null;
}

/**
 * 这个病人当时在哪张床。
 *
 * 优先级：`bedId`（现在就在床上）→ `homeBed`（曾经待过的床，出床也不清空）→
 * 从 `history` 里把他最后出现过的床位捞回来（存档畸形 / 旧存档的兜底）。
 *
 * 为什么层层兜底也要拿到它：复盘必须说得出「4 号床 · 受了外伤」，
 * **绝对不允许**回退到内部编号 —— 用户原话：「那一堆 N01、s01、t01，这什么鬼？」
 */
export function bedOf(state: GameState, p: Patient): number | null {
  if (p.bedId != null) return p.bedId;
  if (p.homeBed != null) return p.homeBed;
  for (let i = state.history.length - 1; i >= 0; i--) {
    for (const e of state.history[i].events) {
      if (pidOf(e) !== p.id) continue;
      const m = /^(?:BED|bed)(\d+)$/.exec(e.split(":")[2] ?? "");
      if (m) return Number(m[1]);
    }
  }
  return null;
}

/** 指代一个病人 —— 只用玩家看得见的东西：在哪张床（或走廊里）+ 他的主诉。 */
export function whoIs(state: GameState, p: Patient): string {
  const bed = bedOf(state, p);
  const where = bed != null ? `${bed} 号床` : "走廊里";
  return `${where} · ${p.chiefComplaint}`;
}

/** 患者 id → 第一次发生某类事件的回合。 */
function firstTurnOf(state: GameState, prefix: string, pid: string): number | null {
  for (const h of state.history) {
    if (h.events.some((e) => e.startsWith(prefix) && pidOf(e) === pid)) return h.turn;
  }
  return null;
}

function hasEvent(state: GameState, prefix: string, pid: string): boolean {
  return firstTurnOf(state, prefix, pid) != null;
}

/**
 * 这个患者被**真正治疗**过几次。
 *
 * 只数 `STABILIZE` —— 检测（SCAN）不算「治疗过」。
 * 曾经这里把任何带 patientId 的动作都算进去，于是「查过但没治」的人
 * 会得到「中间被处理过 1 次，但不够」，把「一次都没治」这个真正的原因盖掉。
 */
function treatCount(state: GameState, pid: string): number {
  return state.history.filter(
    (h) => h.accepted && h.action.type === "STABILIZE" && h.action.patientId === pid,
  ).length;
}

function pendingPatients(state: GameState): Patient[] {
  return Object.values(state.patients)
    .filter((p) => p.alive && !p.discharged)
    .sort((a, b) => b.acuity - a.acuity);
}

export function buildReview(state: GameState): Review {
  const lines: ReviewLine[] = [];
  const all = Object.values(state.patients);
  const dead = all.filter((p) => !p.alive);
  const pending = pendingPatients(state);
  const discharged = all.filter((p) => p.discharged);

  // 感染不再判负（2026-09-18）：但每次传染都要多花手去补救，是失败的常见推手。
  const infected = state.infectionEvents > 0;
  const overSequela = state.sequelaLimit != null && state.sequelaCount > state.sequelaLimit;
  const overDeath = state.deaths > state.maxDeaths;
  const timedOut = state.history.some((h) => h.events.includes("TIMEOUT"));

  let kind: Review["kind"] = "unknown";
  if (overDeath) kind = "deaths";
  else if (overSequela) kind = "sequela";
  else if (timedOut) kind = "timeout";

  // ── ① 谁死了、什么时候、为什么 ────────────────────────────────
  for (const p of dead) {
    const diedTurn = firstTurnOf(state, "DIED", p.id);
    const misdiagnosed = hasEvent(state, "MISDIAGNOSIS", p.id);
    const escalated = firstTurnOf(state, "EXPOSURE_ESCALATE", p.id);
    const touches = treatCount(state, p.id);

    let why: string;
    if (misdiagnosed) {
      // 误诊（Contract §5.3）：两种病长得一样、治疗方向相反，没做检查就动手。
      // 这一段绝不写「本来可以补救」—— 那个通道 2026-09-17 已删除，
      // 而且它从来没被玩家用过（误治之后玩家的第一选择是重开，不是补救）。
      const t = firstTurnOf(state, "MISDIAGNOSIS", p.id);
      why = `第 ${t} 回合，检查还没做，你就动手了。他得的是一种治疗方向和表面症状相反的病 —— 药一进去，人就没了。`;
    } else if (escalated != null) {
      why = `第 ${escalated} 回合被旁边床传染，病情加重了一级，之后就一路往下掉。旁边那个会把病传出去的人，一直没有被处理。`;
    } else if (touches === 0) {
      why =
        diedTurn != null && diedTurn <= 1
          ? `开局他就是红灯，一个回合都没给他留 —— 第一个回合结束就走了。`
          : `从头到尾没有人给他治过，他的病情一路自己往下走。`;
    } else {
      why = `他的病情一直在自己往下走。中间给他治过 ${touches} 次，但没有跟上 —— 治一次只轻一级，他每个回合都在掉。`;
    }
    lines.push({
      kind: "fatal",
      label: "死亡",
      body:
        diedTurn != null
          ? `${whoIs(state, p)}，在第 ${diedTurn} 回合结束的时候没撑住。${why}`
          : // 兜底：理论上 DIED 事件一定带回合号，但绝不能在界面上印出「第 ? 回合」
            `${whoIs(state, p)}，没能撑过去。${why}`,
    });
  }

  // ── ② 传染 / 落下残疾 / 回合用完 ──────────────────────────────
  if (infected) {
    const escalatedAt = state.history
      .filter((h) => h.events.some((e) => e.startsWith("EXPOSURE_ESCALATE")))
      .map((h) => h.turn);
    lines.push({
      kind: "cause",
      label: "传染在偷手",
      body: `这一夜发生了 ${state.infectionEvents} 次传染${
        escalatedAt.length ? `（第 ${[...new Set(escalatedAt)].join("、")} 回合）` : ""
      }。传染不直接判负，但每一个被传上的人都要多花一只手才能救回来 —— 手就这么多，传染就是在偷时间。把会传病的那个人隔离，或者把旁边那个病人治好，都能堵住。`,
    });
  }
  if (overSequela) {
    lines.push({
      kind: "cause",
      label: "超过了抢救期限",
      body: `有 ${state.sequelaCount} 个人超过了抢救期限，带着残疾离开病房，而这一夜最多允许 ${state.sequelaLimit} 个人这样。抢救期限不等人 —— 那几个人必须在期限之内治好。`,
    });
  }
  if (timedOut && !overDeath && !overSequela) {
    lines.push({
      kind: "cause",
      label: "回合用完",
      body: `${state.maxTurns} 个回合全部用完了，还有 ${pending.length} 个人留在病房里。这一夜总共只有 ${state.maxTurns * state.actionPointsPerTurn} 只手。`,
    });
  }

  // ── ③ 差距：还有谁没送走 ──────────────────────────────────────
  if (pending.length) {
    const who = pending
      .slice(0, 4)
      .map((p) => {
        const bed = bedOf(state, p);
        const where = bed != null ? `${bed} 号床` : "走廊里";
        const tier = p.acuity >= 2 ? "红灯" : p.acuity === 1 ? "黄灯" : "绿灯";
        return `${where} · ${p.chiefComplaint}（${tier}）`;
      })
      .join("、");
    lines.push({
      kind: "gap",
      label: "还没送走",
      body: `还剩 ${pending.length} 个人：${who}${pending.length > 4 ? " 等" : ""}。这一夜要求所有人都出院 —— 把人救活不算过关。`,
    });
  }

  // ── ④ 下一把改什么（针对失败类型的具体建议）────────────────────
  if (kind === "deaths" && dead.length) {
    lines.push({
      kind: "advice",
      label: "下一把",
      body: deathAdvice(state, dead),
    });
  } else if (kind === "timeout") {
    lines.push({
      kind: "advice",
      label: "下一把",
      body: "先看每个人床卡下面那行字：写着「他几个回合后会死」的，数字最小的先治。治好一个人要 2 只手、安排床位要 1 只手 —— 一个回合只有 3 只手，两件事装不下的时候，先做会死人的那件。",
    });
  } else if (kind === "sequela") {
    lines.push({
      kind: "advice",
      label: "下一把",
      body: "有抢救期限的人要排在前面 —— 期限一过就再也补不回来。其他黄灯的病人晚一个回合处理，只是变成红灯，还有机会。",
    });
  }

  if (discharged.length) {
    const who = discharged
      .slice(0, 6)
      .map((p) => whoIs(state, p))
      .join("、");
    lines.push({
      kind: "good",
      label: "做对了",
      body: `你送走了 ${discharged.length} 个人：${who}${discharged.length > 6 ? " 等" : ""}。`,
    });
  }

  const headline =
    kind === "deaths"
      ? `${state.deaths} 个人没能撑过这一夜。`
      : kind === "sequela"
        ? `有人超过了抢救期限，带着残疾离开病房。`
        : kind === "timeout"
          ? `回合用完了，还有 ${pending.length} 个人留在病房里。`
          : "这一夜没能守住。";

  return { headline, kind, lines };
}

/**
 * 「下一把」的建议必须**跟着真实死因走**，不能跟着「死掉的人里第一个」走。
 *
 * 曾经这里取 `dead[0]` 的 `deteriorationRate` 出建议，结果出现
 * 「被旁边床传染顶死的患者」配上「这个人不会自己恶化，可以先腾出手去救别人」——
 * 玩家刚因为他死掉，系统却告诉他这个人不用管。归因错了，建议就是反教学。
 */
function deathAdvice(state: GameState, dead: Patient[]): string {
  const misdiagnosed = dead.filter((p) => hasEvent(state, "MISDIAGNOSIS", p.id));
  const escalated = dead.filter((p) => hasEvent(state, "EXPOSURE_ESCALATE", p.id));

  if (misdiagnosed.length) {
    return "这是唯一一种「做错了就没有下一回合」的操作：两种病长得一模一样，治疗方向正好相反，不看检查就动手等于把药打反。那个人只值 1 只手 —— 检测比他便宜。";
  }
  if (escalated.length) {
    return "死掉的人里，有人是被旁边床传染推上去的。床卡上红色那句「他这一回合末就会被传染」就是提前一回合的预告 —— 看到就赶紧把会传病的那个人隔离，或者把旁边的病人治走。";
  }
  if (dead.every((p) => treatCount(state, p.id) === 0)) {
    return "死掉的这几个人，一次都没有被治过。一个回合只有 3 只手，先把红灯的人排进最前面两手；黄灯的病人晚一个回合只是变成红灯，还有机会。";
  }
  return countdownHint(dead[0]);
}

/** 针对某一个具体的人，给出「下把盯什么数字」。 */
function countdownHint(p: Patient): string {
  if (p.deteriorationRate <= 0) {
    return "这个病人的病情不会自己加重 —— 遇到这种病人，可以先腾出手去救别人。";
  }
  if (p.acuity >= 2) {
    return "红灯的病人每个回合都在往下掉。下一把先看床卡上「他几个回合后会死」那一行，数字最小的先治 —— 治好他只要 2 只手，比失去他便宜。";
  }
  return "黄灯的病人不会立刻死，但会一路变成红灯。如果一只手同时能救黄灯和红灯，先救红灯。";
}
