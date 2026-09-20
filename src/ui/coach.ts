import {
  ESCALATION_STEP,
  exposureDose,
  isBedIsolated,
  isTransmitting,
  openEdgesOfBed,
  stabilizeCost,
} from "../core/rules";
import type { ActionType, GameState, Patient } from "../core/types";

/**
 * 文案纪律（2026-09-16 用户拍板，全项目适用于所有面向玩家的文字）：
 *
 * 1. **说人话到「小学生、老人能听懂」**。禁止内部术语与文艺化表达：
 *    没有「缝」（说「缺口」）、没有「谵妄」（说「神志不清、乱喊乱动」）、
 *    没有「暴露」（说「传染风险」）、没有「升档」（说「病情加重一级」）、
 *    没有「时间窗」（说「抢救期限」）、没有「后遗症」（说「留下残疾」）。
 * 2. **该直给的信息直给**：还有几个回合恶化、还差几点出事 —— 玩家算不出来的数字，
 *    界面上必须有。
 * 3. **该玩家判断的绝不剧透**：检测值不值、围哪个源、先救谁 —— 教练只摊开事实与代价，
 *    不给答案。凡「必须具备医学知识才能选」的东西都不是技能，必须改写成经济权衡。
 *
 * 本文件是全部提示文案的唯一出口，改文案改这里。
 */

export type Highlight =
  | "bed"
  | "admit"
  | "stabilize"
  | "scan"
  | "isolate"
  | "hands"
  | "turns"
  | "queue"
  | null;

export type CoachHint = {
  title: string;
  body: string;
  highlight: Highlight;
  highlightBed?: number;
  /**
   * 情况类别 —— 同一种情况的两种措辞（「点 6 号床」/「他这一回合就要加重」）
   * 共享一个 key，这样界面上的弹出贴士对同一件事只弹一次。
   */
  tipKey?: string;
};

export type IntroCard = { title: string; body: string; highlight: Highlight };

export const ACTION_LABEL: Record<ActionType, string> = {
  ADMIT: "安排床位",
  SCAN: "检测",
  STABILIZE: "治疗",
  ISOLATE: "隔离",
  HAND_HYGIENE: "洗手",
};

export const ACTION_CAPTION: Record<ActionType, string> = {
  ADMIT: "让走廊第一个人住进这张床 · 1 只手",
  SCAN: "花钱做化验，拿到结果 · 1 只手",
  STABILIZE: "动手治病，病情变绿他自己出院",
  ISOLATE: "用帘子把这人的床围起来 · 1 只手",
  HAND_HYGIENE: "把手洗干净 · 1 只手",
};

export const ACUITY_ZH = ["绿", "黄", "红"];

export const NIGHT_INTROS: Record<string, IntroCard[]> = {
  "night-00": [
    {
      title: "怎么算赢",
      body: "把 4 个人全部送出院。只要有 1 个人死了，或者回合用完还有人留在病房里，这一夜就算失败。",
      highlight: "turns",
    },
    {
      title: "怎么动手",
      body: "先点一张床，再点下面的按钮。按钮只对选中的那张床起作用。",
      highlight: "bed",
    },
    {
      title: "「治疗」是做什么的",
      body: "点一次治疗，病情就轻一级：红变黄、黄变绿。病情到绿色的人会自己出院，不用你再花手。",
      highlight: "stabilize",
    },
    {
      title: "手用完了，时间才往前走",
      body: "每回合只有 3 只手。点床、点按钮都要花手。手用光，才会进入下一回合 —— 这一夜没有「等一下」这个选项。",
      highlight: "hands",
    },
  ],
  "night-01": [
    {
      title: "有两种病，长得几乎一样",
      body: "但治法是相反的。病历上不会写他是哪一种，光看表面症状也分不出来。",
      highlight: "scan",
    },
    {
      title: "「检测」能看到什么",
      body: "花 1 只手，拿到化验结果。检测过之后，治疗会自动按正确的方向做 —— 不需要你自己选方案。",
      highlight: "scan",
    },
  ],
  "night-02": [
    {
      title: "旁边床的人会被传染",
      body: "病房里有人会把病传给别人。每个回合结束，他旁边床上的人就会沾上「被传染的风险」。风险攒满，那个人当场加重一级。是谁在传，要自己查。",
      highlight: "stabilize",
    },
    {
      title: "「隔离」买到什么",
      body: "花 1 只手，把这个人的床用帘子围起来，他就传不出去了。但隔离不治病 —— 被围住的人还躺在床上，还会继续变差。",
      highlight: "isolate",
    },
    {
      title: "帘子只有一套",
      body: "全场同时只能围住一个人：点「隔离」围上新人，之前围的那位会自动解开，帘子整体搬过去。想换人围，直接点 —— 不用先拆。",
      highlight: "bed",
    },
  ],
  "night-03": [
    {
      title: "今晚不止一个人会传病",
      body: "一个症状很明显 —— 咳得厉害、还发烧；另一个完全没有症状。两个人都正在把病传出去。",
      highlight: "bed",
    },
    {
      title: "先把会传的查出来",
      body: "两个人的病都会传，但只有一个能直接看出来。先把没症状的那个查清楚，再决定帘子围谁 —— 围上一个人，另一个人那边的帘就撤了。",
      highlight: "scan",
    },
  ],
  "night-04": [
    {
      title: "碰过会传病的人，手就脏了",
      body: "治疗或者检测过会传病的人之后，你的手沾上了病菌。脏手再接触不会传病的病人，会把病菌带给对方。洗手要花 1 只手。",
      highlight: "hands",
    },
    {
      title: "今晚有人在传病，其中一个看不出症状",
      body: "有人正在把病传给隔壁床，其中一个几乎看不出毛病，只能靠检测确认。这一夜最多允许 1 次病情加重是传染造成的。",
      highlight: "scan",
    },
    {
      title: "6 号床的病人神志不清",
      body: "他躺在床上的时候，旁边几床的人做治疗都要多花 1 只手 —— 得先分出人手把他按住。",
      highlight: "bed",
    },
  ],
  "night-05": [
    {
      title: "8 个人，9 个回合",
      body: "每回合 3 只手，一共 27 手。这 8 个人必须全部出院 —— 有一个人没送走，这一夜就得重来。",
      highlight: "turns",
    },
    {
      title: "有一个病人必须按时救回来",
      body: "走廊里会送来一个病人，他必须在到病房之后的 3 个回合之内治好。一超过这个期限，他会带着残疾离开病房 —— 而这一夜不允许任何人留下残疾。",
      highlight: "turns",
    },
    {
      title: "走廊最多站 2 个人",
      body: "在走廊等候的人超过 2 个，那个回合结束时，所有还在等的人一起加重一级。把人安排进床，就是在给走廊减负。",
      highlight: "queue",
    },
    {
      title: "手会脏，床也会脏",
      body: "碰过会传病的人要洗手（1 只手），不然接触不会传病的病人，病菌就传给他了。另外，会传病的人离开床位以后，床上还留着病菌，下一个住进去的人立刻沾上。",
      highlight: "hands",
    },
  ],

  "night-06": [
    {
      title: "9 个人，10 个回合",
      body: "前面每一夜教过的东西，今晚一起上场：分不清的病、会传病的人、必须按时救回来的人、神志不清的人、走廊会挤、手会脏、床会脏。",
      highlight: "bed",
    },
    {
      title: "有的病，只看症状分不出来",
      body: "同一种表现可能是两种病，治法正好相反，病历上不会写。检测能看清是哪一种，但每检测一个人都要花掉 1 只手。",
      highlight: "scan",
    },
    {
      title: "帘子只有一套，围谁要想清楚",
      body: "今晚不止一个人在传病，而帘子同时只能围住一个人：围上新人，旧的那位就自动解开。每一手都挤占救人 —— 先围住传得最凶的，剩下的靠治。",
      highlight: "isolate",
    },
    {
      title: "只允许 1 个人留下残疾",
      body: "这一夜允许 1 个人留下残疾，走廊也只站得下 1 个人。谁占掉这两个名额，由你决定。",
      highlight: "turns",
    },
  ],
};

function onBeds(state: GameState): Patient[] {
  return Object.values(state.patients).filter((p) => p.alive && !p.discharged && p.bedId != null);
}

export function coachHint(state: GameState, selectedBed: number | null): CoachHint {
  if (state.outcome === "WIN") {
    return { title: "", body: "", highlight: null };
  }
  if (state.outcome === "LOSE") {
    return {
      title: "这一夜结束了",
      tipKey: "over",
      // 这里**不猜死因**：具体归因由中间那块复盘负责。
      // 曾经这里写「回合用完，或有人没撑住」，在主标题已经写明「2 个人没能撑过这一夜」时，
      // 两块文字互相打架，玩家不知道该信哪一句。
      body: "中间写清了是谁、在第几回合、因为什么。看完再开下一把。",
      highlight: null,
    };
  }

  const occupied = onBeds(state);

  /**
   * 回合末就会被打到加重线的人 —— 优先级最高。
   *
   * 判据不是「旁边有没有会传病的人」，而是「这次传染会不会真的把他推过线」：
   * 传染风险每跨过 ESCALATION_STEP(=2) 加重一级，所以 exposure + dose ≥ 下一级下限 才叫「悬」。
   * 这样提示是精确的（不会为一次不致命的传染报警），也与 reducer.applyExposure 同源。
   */
  const atRisk = state.infectionEnabled
    ? occupied.filter((p) => {
        // 只看**没挂帘的边** —— 挂上帘的缺口不传，这条边就不该进风险计算。
        return openEdgesOfBed(state, p.bedId!).some((e) => {
          const [a, b] = e.split("-").map(Number);
          const other = a === p.bedId ? b : a;
          const id = state.beds[other];
          if (!id) return false;
          const src = state.patients[id];
          if (!isTransmitting(src)) return false;
          // 信息纪律：谁在传是检测后才揭示的。他没被撞过（exposure = 0）、
          // 源也没检测过时，教练不能替玩家喊「要被传了」—— 那是免费剧透传染源。
          if (p.exposure <= 0 && !src.revealed.includes("transmission")) return false;
          const nextThreshold = (p.escalations + 1) * ESCALATION_STEP;
          return p.exposure + exposureDose(src) >= nextThreshold;
        });
      })
    : [];
  if (atRisk.length) {
    const p = atRisk[0];
    if (selectedBed === p.bedId) {
      return {
        title: "他这一回合结束就要加重",
        tipKey: "risk",
        body: `旁边床传过来的病气，加上这一次正好让他「被传染的风险」满格 —— 他会当场加重一级。现在把他治好，或者花 1 只手把旁边那个会传病的人隔离。`,
        highlight: "stabilize",
        highlightBed: p.bedId ?? undefined,
      };
    }
    return {
      title: "这个回合结束就有人要加重",
      tipKey: "risk",
      body: `点 ${p.bedId} 号床。旁边床这个回合传过来的病气，正好让他的「被传染的风险」满格 —— 他会当场加重一级。`,
      highlight: "bed",
      highlightBed: p.bedId ?? undefined,
    };
  }

  const needsScan = occupied.filter(
    (p) => p.axisIntervention === "SCAN_FIRST" && !p.revealed.includes("riskProfile"),
  );
  /**
   * 分不清病种的病人：不检测就动手是**确定性失败**（Contract §5），
   * 所以教练和 SCAN_FIRST 一样直接催检测 —— 这只手就是保险费。
   */
  const needsPlan = occupied.filter(
    (p) => p.axisIntervention === "MIRROR" && p.acuity > 0 && !p.revealed.includes("riskProfile"),
  );
  const needsIsolation = state.infectionEnabled
    ? occupied.filter((p) => p.transmission === "HIGH" && !isBedIsolated(state, p.bedId!))
    : [];
  // 脏手（Contract §6A.1）：脏手动手会传染下一个人 —— 提醒永远比惩罚靠前
  const dirtyHand =
    state.handHygieneEnabled &&
    state.handState === "CONTAMINATED" &&
    occupied.some((p) => p.transmission !== "HIGH");
  const needsStab = occupied.filter((p) => {
    if (p.acuity <= 0) return false;
    if (p.axisIntervention === "SCAN_FIRST" && !p.revealed.includes("riskProfile")) return false;
    return true;
  });
  // 病历缺项的病人：只提示「这个人的信息不全」，**不替玩家决定要不要花那一手**。
  // 检测值不值，是玩家自己撞一次之后学会的判断，教练不该预先替他算完。
  if (needsScan.length) {
    const p = needsScan[0];
    if (selectedBed === p.bedId) {
      return {
        title: "他的病历缺一项",
        tipKey: "scan",
        body: "这个人该怎么治，现在没有依据 —— 病历上缺了关键的一项。",
        highlight: "scan",
        highlightBed: p.bedId ?? undefined,
      };
    }
    return {
      title: "有人病历不全",
      tipKey: "scan",
      body: `点 ${p.bedId} 号床。这个人的病历还缺一项检查结果，现在动手没有把握。`,
      highlight: "bed",
      highlightBed: p.bedId ?? undefined,
    };
  }

  if (needsPlan.length) {
    const p = needsPlan[0];
    if (selectedBed === p.bedId) {
      return {
        title: "还没查清该怎么治",
        tipKey: "plan",
        body: "两种病长得几乎一样，病历上没写是哪一种。「检测」能拿到客观的化验结果 —— 值不值得花这一手，你自己判断。",
        highlight: "scan",
        highlightBed: p.bedId ?? undefined,
      };
    }
    return {
      title: "有人还没查清该怎么治",
      tipKey: "plan",
      body: `点 ${p.bedId} 号床。这个人有两种可能，治法正好相反，现在还不知道是哪种。`,
      highlight: "bed",
      highlightBed: p.bedId ?? undefined,
    };
  }

  if (dirtyHand) {
    const nextCleanTarget = occupied.find((p) => p.transmission !== "HIGH");
    return {
      title: "你的手是脏的",
      tipKey: "dirty",
      body: "你刚碰过会传病的人。这时候接触不会传病的病人，手上的病菌就传给他了。洗手要花 1 只手。",
      highlight: "hands",
      highlightBed: nextCleanTarget?.bedId ?? undefined,
    };
  }

  // 有会传病的人在：把「隔离能买到什么、要付什么」摊开，**不替玩家下命令**。
  if (needsIsolation.length) {
    const p = needsIsolation[0];
    if (selectedBed === p.bedId) {
      return {
        title: "他还在把病传出去",
        tipKey: "isolate",
        body: `「隔离」花 ${state.isolateCost} 只手，把他这张床用帘子围起来，他就传不出去了。帘子只有一套 —— 若已有人被围，围他会把那位解开。但隔离不治病，他还躺在原处，病情照旧。`,
        highlight: "isolate",
        highlightBed: p.bedId ?? undefined,
      };
    }
    return {
      title: "有人在把病传出去",
      tipKey: "isolate",
      body: `点 ${p.bedId} 号床。他旁边床上的人，每个回合都会沾上「被传染的风险」。`,
      highlight: "bed",
      highlightBed: p.bedId ?? undefined,
    };
  }

  if (needsStab.length) {
    const p = needsStab[0];
    if (selectedBed === p.bedId) {
      return {
        title: "可以治疗了",
        tipKey: "stab",
        body: "点下面的「治疗」。这是动手治病 —— 黄灯治一次会变绿灯。",
        highlight: "stabilize",
        highlightBed: p.bedId ?? undefined,
      };
    }
    return {
      title: "先点一张床",
      tipKey: "stab",
      body: `点 ${p.bedId} 号床。选中之后，才能给他做治疗。`,
      highlight: "bed",
      highlightBed: p.bedId ?? undefined,
    };
  }

  // 出院是自动结算：acuity 归零的患者当帧就离床，
  // 因此不存在「该出院还没出院」的稳态，这里不需要出院引导。

  if (state.queue.length > 0) {
    if (selectedBed != null && state.beds[selectedBed] == null) {
      return {
        title: "可以安排床位",
        tipKey: "admit",
        body: "点「安排床位」。走廊里排在最前面的人会住进这张床。",
        highlight: "admit",
        highlightBed: selectedBed,
      };
    }
    return {
      title: "走廊里有人在等",
      tipKey: "queue",
      body: "点一张空床，再点「安排床位」。他们不会自己走进来。",
      highlight: "queue",
    };
  }

  return {
    title: "还有手没花完",
    tipKey: "idle",
    body: "点一张床，再点下面的按钮做事。手用光了，回合才会往前走。",
    highlight: "hands",
  };
}

export function disabledReason(
  type: ActionType,
  state: GameState,
  selectedBed: number | null,
): string {
  if (state.outcome !== "ONGOING") return "这一夜已经结束了";
  if (!state.enabledActions.includes(type)) return "这一夜没有这个动作";
  if (type === "HAND_HYGIENE") {
    // 洗手是全局动作：不选床也能洗，只看手够不够
    if (state.ap < 1) return "这一回合的手已经用完了，下个回合再洗";
    return "";
  }
  if (type === "ADMIT") {
    if (state.queue.length === 0) return "走廊里没有人等着";
    if (selectedBed == null) return "先点一张空床，再安排床位";
    if (state.beds[selectedBed] != null) return "这张床上有人。换一张空床";
    return "";
  }
  if (selectedBed == null) return "先点一张床，按钮才会对它起作用";
  const pid = state.beds[selectedBed];
  if (!pid) return "这张床是空的。要安排人住进来的话，点「安排床位」";
  const p = state.patients[pid];
  if (type === "STABILIZE") {
    // legalActions 会把稳定了的人排除在外，但 reduce 不拦 —— 在 UI 层挡住这只白烧的手。
    if (p.acuity <= 0) return "他的病情已经稳定了，会自己出院";
    // 余额不够也必须在这里拦住。不改的话按钮照样能点，点下去 `reduce` 判非法、
    // 静默返回 —— 不扣手、不推进回合、不弹提示，玩家只看到「点了没反应」。
    // 这是用户报的夜间 01「不检测直接治，之后点击治疗无效」的真正原因：
    // 治愈档要 2 只手，而此时恰好只剩 1 只。
    const cost = stabilizeCost(state, p);
    if (state.ap < cost) {
      return `这一回合的手不够了 —— 治他一次要 ${cost} 只，你只剩 ${state.ap} 只。先把这只手用在别处，下个回合就有 ${state.actionPointsPerTurn} 只了`;
    }
    return "";
  }
  if (type === "SCAN") {
    if (p.revealed.length >= p.revealOrder.length) return "能查的都查完了";
    return "";
  }
  if (type === "ISOLATE") {
    if (isBedIsolated(state, selectedBed)) return "这张床四周已经全部围上帘子了";
    return "";
  }
  return "现在不能这么做";
}
