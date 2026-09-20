/**
 * 病房主界面 —— DOM 版（替代 Phaser 场景 Ward.ts）。
 *
 * 与旧实现的功能一一对应，排版责任却完全不同：
 *   旧版把坐标写死在 1280×720 的画布里（遮挡/错行的根因）；
 *   新版交给文档流与 CSS Grid —— 文字换行是浏览器的活，永不手工量高。
 *
 * 素材是「图层」不是「整图」（docs/level-design/refs 的图层化决策）：
 *   床只有一张底图；患者四型、隔离帘（竖/横）、污渍（轻/重）全是叠加层；
 *   信息（文字、灯、徽标、屏障框）依旧代码画。
 */
import {
  canDischarge,
  createInitialState,
  isBedIsolated,
  legalActions,
  reduce,
  stabilizeCost,
  type ActionType,
  type GameState,
  type Patient,
  type PlayerAction,
} from "../core";
import { levels } from "../levels";
import {
  ACUITY_ZH,
  coachHint,
  disabledReason,
  NIGHT_INTROS,
  type CoachHint,
} from "./coach";
import { countdown, countdownText, exposureStatus } from "./forecast";
import { buildReview, type Review } from "./review";
import { resolveTips, TIP_DISCLAIMER, TIP_SEGMENT_ORDER, type TipView } from "./tips";
import { isMuted, play, toggleMuted, type SfxName } from "./sfx";
import { nextNightId, unlockNextNight } from "../progress";
import { el } from "./dom";

const ACUITY_CLASS = ["a0", "a1", "a2"];
const FLAG_MARK: Record<string, string> = { high: " ↑", low: " ↓", critical: " ！！" };

const HIDDEN_KEY_ZH: Record<string, string> = {
  riskProfile: "病情",
  transmission: "会不会把病传给别人",
  disposition: "能不能出院",
};

const HIDDEN_ZH: Record<string, string> = {
  trauma: "受了外伤",
  critical: "病得很重",
  mild: "病得轻",
  airway: "呼吸可能会出问题",
  source: "他正在把病传给别人",
  carrier: "他身上带着病菌，但自己看不出毛病",
  NONE: "不会",
  LOW: "会，只是传得慢",
  HIGH: "会，而且传得快",
  STABLE: "能，病情已经稳定",
};

function revealText(p: Patient): string[] {
  return p.revealed.map(
    (k) => `${HIDDEN_KEY_ZH[k] ?? k}：${HIDDEN_ZH[p.hidden[k]] ?? p.hidden[k]}`,
  );
}

const BASE_ACTION: Record<ActionType, { label: string; caption: string }> = {
  ADMIT: { label: "安排床位", caption: "让走廊里排第一的人住进这张床 · 1 只手" },
  SCAN: { label: "检测", caption: "花钱做化验，拿到结果 · 1 只手" },
  STABILIZE: { label: "治疗", caption: "动手治病，病情轻一级" },
  ISOLATE: { label: "隔离", caption: "用帘子把这人的床围起来 · 1 只手" },
  HAND_HYGIENE: { label: "洗手", caption: "把手洗干净 · 1 只手" },
};

const SKIP_ACTION = { label: "跳过", caption: "这只手不用了，什么都不做 · 1 只手" };

const FLASH_PRIORITY: Array<[RegExp, string]> = [
  [/^MISDIAGNOSIS/, "方向治反了 —— 他当场就没了"],
  [/^DIED/, "有一个病人死了"],
  [/^WINDOW_CLOSED/, "超过了抢救期限 —— 他带着残疾离开病房"],
  [/^QUEUE_PRESSURE/, "走廊站不下了 —— 还在等的人病情都重了一级"],
  [/^STABILIZE_INEFFECTIVE/, "治疗没有起作用 —— 这个人得先做检测"],
  [/^BED_UNIT_EXPOSURE/, "这张床上还留着病菌 —— 刚住进来的人立刻沾上"],
  [/^EXPOSURE_ESCALATE/, "有人被传染，病情加重了一级"],
  [/^HAND_CONTAMINATED/, "你的手脏了 —— 接触不会传病的病人，就会把病传给他，先洗手"],
  [/^ISOLATED/, "帘子挂上了 —— 他传不出去了"],
  [/^STABILIZED/, "治疗过了，他的病情轻了一级"],
  [/^DISCHARGED/, "他出院了，床位空出来了"],
  [/^DETERIORATED/, "他的病情自己加重了一级"],
  [/^ADMITTED/, "走廊里第一个人住进了床位"],
  [/^SCANNED/, "检测完成，结果出来了"],
  [/^HAND_WASHED/, "手洗干净了"],
  [/^SKIPPED_HAND/, "这只手空过去了 —— 手全部用光，才会进入下一回合"],
  [/^REJECTED/, "这一下没能做成"],
];

function flashLabel(events: string[]): string {
  for (const [re, msg] of FLASH_PRIORITY) {
    if (events.some((e) => re.test(e))) return msg;
  }
  return "";
}

/** 每夜的开场插画（机制主题的静场氛围图，与 NIGHT_INTROS 一一对应）。 */
const NIGHT_ART: Record<string, string> = {
  "night-00": "assets/art/illustrations/night_00_calm_begin.jpg",
  "night-01": "assets/art/illustrations/night_01_first_tests.jpg",
  "night-02": "assets/art/illustrations/night_02_invisible_spread.jpg",
  "night-03": "assets/art/illustrations/night_03_the_source.jpg",
  "night-04": "assets/art/illustrations/night_04_hands_queue.jpg",
  "night-05": "assets/art/illustrations/night_05_crowded.jpg",
  "night-06": "assets/art/illustrations/night_06_long_night.jpg",
};

const ART = {
  bed: "assets/art/sprites/bed_clean.jpg",
  patients: {
    generic: "assets/art/sprites/patient_generic.jpg",
    trauma: "assets/art/sprites/patient_trauma.jpg",
    critical: "assets/art/sprites/patient_critical.jpg",
    fever: "assets/art/sprites/patient_fever.jpg",
  } as Record<string, string>,
  curtainV: "assets/art/sprites/curtain_vertical.jpg",
  curtainH: "assets/art/sprites/curtain_horizontal.jpg",
  stain1: "assets/art/textures/stain_light.jpg",
  stain2: "assets/art/textures/stain_heavy.jpg",
  handDirty: "assets/art/sprites/hand_dirty.png",
  handClean: "assets/art/sprites/hand_clean.png",
  sanitizer: "assets/art/sprites/hand_sanitizer.jpg",
  queue: "assets/art/sprites/corridor_queue.jpg",
  winArt: "assets/art/illustrations/ending_win_dawn.jpg",
  loseArt: "assets/art/illustrations/ending_loss_curtain.jpg",
};

/** 患者原型 → 覆盖层插画。风险画像影响的是配色而不是形态，先用症状定位。 */
function patientArt(p: Patient): string {
  if (p.revealed.includes("riskProfile") && p.hidden.riskProfile === "critical") return ART.patients.critical;
  if (p.chiefComplaint.includes("外伤") || p.chiefComplaint.includes("撞") || p.chiefComplaint.includes("摔")) {
    return ART.patients.trauma;
  }
  if (p.chiefComplaint.includes("烧") || p.chiefComplaint.includes("热") || p.chiefComplaint.includes("感")) {
    return ART.patients.fever;
  }
  if (p.acuity >= 2) return ART.patients.critical;
  return ART.patients.generic;
}

function tipHead(tip: TipView): string {
  return tip.subject ? `${tip.label}　${tip.subject}` : tip.label;
}

export class WardView {
  private state: GameState;
  private selectedBed: number | null = null;
  /** 手机端：患者详情弹卡只随「查看详情」打开，点床选中本身不弹。 */
  private detailOpen = false;
  private flash = "";
  private introIndex: number | null = 0;
  private shownTips = new Set<string>();
  private pendingTip: { key: string; title: string; body: string } | null = null;
  private lastScanBed: number | null = null;
  private lastDischargeBed: number | null = null;
  /** 结算弹窗的步骤：0 = 结果与原因，1 = 历史案例与按钮。 */
  private outcomeStep = 0;
  /** 当前显示中的贴士（跨渲染存活，到 until 时间戳为止）。 */
  private activeTip: { key: string; title: string; body: string; until: number } | null = null;
  /** 进入关卡的黑幕标题：黑底居中显示夜号与标题，约 2 秒后自动进入病房。 */
  private titleCard = true;

  constructor(
    private root: HTMLElement,
    levelId: string,
    private onExit: () => void,
  ) {
    this.state = createInitialState(levels[levelId]);
    this.introIndex = NIGHT_INTROS[levelId] ? 0 : null;
  }

  mount(): void {
    this.render();
  }

  // ── 主渲染 ────────────────────────────────────────────────

  private render(): void {
    const s = this.state;
    const hint = this.hint();
    this.pendingTip = this.maybeTip();

    // 每次渲染都重建整个 DOM，先把旧画面的滚动位置记下来，建好再还原
    // —— 否则手机上点床、做动作，页面会瞬间弹回顶部
    const prevScreen = this.root.firstElementChild;
    const keepScroll = prevScreen ? { top: prevScreen.scrollTop, left: prevScreen.scrollLeft } : null;

    const screen = el("div", { class: "screen" }, el("div", { class: "bg-art" }));
    const ward = el("div", { class: "ward" });
    screen.append(ward);

    ward.append(this.drawTop(hint));
    ward.append(this.drawFlash());

    const main = el("div", { class: "ward-main" });
    const wardCol = el("div", { class: "ward-col" });
    // 贴士横幅排在病房列最顶、随滚动吸附 —— 与病房同宽居中，不再悬空压住顶栏
    const tipToast = this.drawTipToast();
    if (tipToast) wardCol.append(tipToast);
    wardCol.append(this.drawFloor(s, hint));
    wardCol.append(this.drawCorridor(hint));
    wardCol.append(this.drawActions(hint));
    main.append(wardCol);
    // 右栏列：只有患者信息栏，顶边与病房顶对齐；「返回 / 音效」统一放顶栏右格
    const sideCol = el("div", { class: "side-col" });
    sideCol.append(this.drawSidePanel());
    main.append(sideCol);
    ward.append(main);

    // 手机端没有右栏（上中下结构）：点床只选中做操作，点「查看详情」才弹卡
    if (
      window.matchMedia("(max-width: 899px)").matches &&
      this.introIndex == null &&
      s.outcome === "ONGOING" &&
      this.selectedPatient()
    ) {
      if (!this.detailOpen) {
        screen.append(
          el("button", {
            class: "detail-fab",
            text: "查看详情",
            onclick: () => {
              play("click");
              this.detailOpen = true;
              this.render();
            },
          }),
        );
      } else {
        const sheet = el("div", { class: "bed-sheet" });
        // 外壳固定不滚动（圆角边界稳定），只有内层内容上下滑
        const sheetScroll = el("div", { class: "bed-sheet-scroll" });
        sheetScroll.append(this.drawSidePanel());
        sheet.append(
          el("button", {
            class: "bed-sheet-close",
            text: "收起 ✕",
            onclick: () => {
              this.detailOpen = false;
              this.render();
            },
          }),
          sheetScroll,
        );
        screen.append(sheet);
      }
    }

    if (this.titleCard) screen.append(this.drawTitleCard());
    else if (this.introIndex != null) screen.append(this.drawIntro());
    else if (s.outcome !== "ONGOING") screen.append(this.drawOutcome());

    this.root.replaceChildren(screen);
    if (keepScroll) {
      screen.scrollTop = keepScroll.top;
      screen.scrollLeft = keepScroll.left;
    }
  }

  private hint(): CoachHint {
    if (this.introIndex != null) {
      const cards = this.intros();
      const last = this.introIndex >= cards.length - 1;
      return {
        title: "先读说明",
        body: last
          ? "点「下一页」关掉这张卡，然后就能动手了。"
          : `还有 ${cards.length - this.introIndex - 1} 张说明要看 —— 点「下一页」继续。`,
        highlight: "turns",
      };
    }
    return coachHint(this.state, this.selectedBed);
  }

  private intros() {
    return NIGHT_INTROS[this.state.nightId] ?? [];
  }

  // ── 顶栏 ──────────────────────────────────────────────────

  private drawTop(hint: CoachHint): HTMLElement {
    const s = this.state;
    const intro = this.introIndex != null ? this.intros()[this.introIndex] : null;
    const dirty = s.handHygieneEnabled && s.handState === "CONTAMINATED";
    const handsHi = intro?.highlight === "hands" || hint.highlight === "hands";
    const turnsHi = intro?.highlight === "turns" || intro?.highlight === "hands";

    // 回合圆点：实心 = 还剩几个回合（与手的圆点同一套语言）
    const remaining = Math.max(0, s.maxTurns - s.turn + 1);
    const turnDots = el("div", { class: "hand-dots" });
    for (let i = 0; i < s.maxTurns; i++) {
      turnDots.append(el("span", { class: `hand-dot turn${i < remaining ? " on" : ""}` }));
    }

    const handDots = el("div", { class: "hand-dots" });
    if (s.handHygieneEnabled) {
      handDots.append(
        el("img", {
          class: "hand-icon",
          src: dirty ? ART.handDirty : ART.handClean,
          alt: dirty ? "手是脏的" : "手是干净的",
        }),
      );
    }
    for (let i = 0; i < s.actionPointsPerTurn; i++) {
      handDots.append(
        el("span", {
          class: `hand-dot${i < s.ap ? " on" : ""}${dirty ? " dirty" : ""}`,
        }),
      );
    }

    const bar = el(
      "div",
      { class: "topbar" },
      // 左格与病房同列：回合贴左、手贴病房右缘
      el(
        "div",
        { class: "meter-group" },
        el(
          "div",
          { class: "meter" },
          el("div", { class: `label${turnsHi ? " hi" : ""}`, text: `回合` }),
          turnDots,
          el("div", { class: "sub", text: `${s.turn} / ${s.maxTurns}` }),
        ),
        el(
          "div",
          { class: "meter hand-meter" },
          el("div", {
            class: `label${handsHi || dirty ? " hi" : ""}`,
            style: dirty ? "color: var(--amber-ink)" : "",
            text: "手",
          }),
          handDots,
          // 脏手当刻就常驻提醒「接触不会传病的人会传病」，不等玩家自己注意颜色
          dirty
            ? el("div", { class: "sub dirty", text: "脏手接触不会传病的病人，就会把病传给他 —— 先洗手" })
            : null,
        ),
      ),
      // 右格压在右栏列正上方：返回 / 音效
      el(
        "div",
        { class: "topbar-buttons" },
        el("button", { class: "link-btn", text: "返回", onclick: () => this.onExit() }),
        el("button", {
          class: "link-btn",
          text: isMuted() ? "音效 关" : "音效 开",
          onclick: () => {
            toggleMuted();
            play("click");
            this.render();
          },
        }),
      ),
    );
    return bar;
  }

  private drawFlash(): HTMLElement {
    const line = el("div", { class: "flash-line", text: this.flash || "" });
    if (this.flash) line.classList.add("show");
    return line;
  }

  // ── 病房地板：床 + 帘幕 ───────────────────────────────────

  private drawFloor(s: GameState, hint: CoachHint): HTMLElement {
    const grid = el("div", { class: "bed-grid" });

    // 两排床（帘子实体化后不再渲染轨道格，帘幕直接盖在床上）
    for (let id = 1; id <= 4; id++) {
      grid.append(this.bedCard(id, s, hint, { col: id, row: 1 }));
    }
    for (let id = 5; id <= 8; id++) {
      grid.append(this.bedCard(id, s, hint, { col: id - 4, row: 2 }));
    }

    const floor = el("div", { class: "floor" }, grid);
    return floor;
  }

  private bedCard(
    id: number,
    s: GameState,
    hint: CoachHint,
    pos?: { col: number; row: number },
  ): HTMLElement {
    const selected = this.selectedBed === id;
    // 高亮只属于两处：教程指的第一张床。教练提示不再制造床位高亮。
    const spotlight = this.introIndex != null && hint.highlight === "bed" && id === 1;
    const pid = s.beds[id];
    const p = pid ? s.patients[pid] : null;
    const isolated = s.infectionEnabled && isBedIsolated(s, id);

    const card = el("div", {
      class: `bed-card${selected ? " selected" : ""}${spotlight ? " spotlight" : ""}${isolated ? " isolated" : ""}`,
      style: pos ? `--gc:${pos.col};--gr:${pos.row};` : "",
    });
    if (this.lastScanBed === id) card.classList.add("scanning");
    if (this.lastDischargeBed === id) card.classList.add("discharged");
    if (this.introIndex == null && s.outcome === "ONGOING") {
      card.addEventListener("click", () => this.selectBed(id));
    }

    const head = el("div", { class: "bed-head" }, el("span", { class: "bed-no", text: `${id} 号床` }));
    if (spotlight && this.introIndex == null) head.append(el("span", { class: "bed-here", text: "点这里" }));
    if (p) {
      head.append(el("span", { class: `lamp ${ACUITY_CLASS[Math.min(p.acuity, 2)]}` }));
    }
    card.append(head);

    const art = el("div", { class: "bed-art" });
    art.append(el("img", { class: `bed-img${p ? "" : " empty"}`, src: ART.bed, alt: "" }));
    if (p) {
      const risk = s.bedRisk[id] ?? 0;
      if (risk > 0) {
        art.append(
          el("img", {
            class: `stain-img risk${risk >= 2 ? 2 : 1}`,
            src: risk >= 2 ? ART.stain2 : ART.stain1,
            alt: "",
          }),
        );
      }
      art.append(el("img", { class: "patient-img", src: patientArt(p), alt: "" }));
    }
    card.append(art);

    // 隔离帘幕：半透明青纱盖在床画面上（帘子的主要视觉实体）
    if (isolated) art.append(el("div", { class: "curtain-drape" }));

    if (!p) {
      card.append(el("div", { class: "bed-empty-label", text: "空床" }));
      return card;
    }

    card.append(el("div", { class: "bed-complaint", text: p.chiefComplaint }));
    card.append(el("div", { class: "bed-sub", text: `${ACUITY_ZH[Math.min(p.acuity, 2)]}灯` }));

    const cdText = countdownText(p);
    const cdClass = cdText.urgent ? "urgent" : p.acuity >= 2 || (countdown(p).turnsToDeath ?? 99) <= 3 ? "warn" : "";
    card.append(el("div", { class: `bed-count ${cdClass}`, text: cdText.text }));

    const statusBits: string[] = [];
    const alarm: Array<{ text: string; cls: string }> = [];
    if (s.infectionEnabled) {
      const ex = exposureStatus(s, p);
      // 信息纪律：源没揭示、他也没被撞过时闭嘴 —— 提前广播等于免费剧透传染源
      if (ex.disclosed && ex.dose > 0) {
        if (ex.willEscalate) {
          // 第一回合就会发生的传染加重（剂量正好满格）也走这里，提前一回合喊出来
          alarm.push({ text: "他这一回合末就会被传染，病情加重一级", cls: "red" });
        } else {
          const turns = Math.ceil(ex.need / ex.dose);
          statusBits.push(
            turns === 1
              ? "下回合末就会被传染，加重一级"
              : `${turns} 个回合末会被传染，加重一级`,
          );
        }
      } else if (p.exposure > 0) {
        statusBits.push("身上带着被传染的风险，但现在没人传给他");
      }
    }
    if (p.revealed.includes("riskProfile")) statusBits.push("已经检测过");
    if (statusBits.length) {
      card.append(el("div", { class: "bed-status", text: statusBits.join(" · ") }));
    }

    if (p.timeWindow && p.windowClock > 0 && !p.sequela) {
      alarm.push({
        text: `抢救期限只剩 ${p.windowClock} 个回合`,
        cls: p.windowClock <= 1 ? "red" : "amber",
      });
    }
    if (p.disruptive) alarm.push({ text: "他神志不清，旁边床治疗要多花 1 只手", cls: "amber" });
    if (canDischarge(p)) alarm.push({ text: "可以出院了", cls: "green" });
    for (const a of alarm.slice(0, 2)) {
      card.append(el("div", { class: `bed-alarm ${a.cls}`, text: a.text }));
    }

    return card;
  }

  /** 一条缝：开缝 / 正在传 / 挂帘。挂帘时帘段滑入。 */
  // ── 走廊 ──────────────────────────────────────────────────

  private drawCorridor(hint: CoachHint): HTMLElement {
    const s = this.state;
    const hi = hint.highlight === "queue";
    const limit = s.queueLimit;
    const over = limit != null && s.queue.length >= limit;
    const label =
      limit != null
        ? `走廊（等着安排床位）　已经站了 ${s.queue.length} / ${limit} 个人${
            over ? " —— 站不下，这个回合结束还在等的人会一起加重一级" : ""
          }`
        : "走廊（等着安排床位）";

    const box = el(
      "div",
      { class: "corridor" },
      el("img", { class: "queue-art", src: ART.queue, alt: "" }),
      el("div", { class: "corridor-head" }, el("span", { class: `corridor-title${over ? " over" : hi ? " hi" : ""}`, text: label })),
    );

    if (s.queue.length === 0) {
      box.append(el("div", { class: "queue-empty", text: "现在没有人等着" }));
      return box;
    }

    const row = el("div", { class: "queue-row" });
    const shown = s.queue.slice(0, 4);
    shown.forEach((pid, i) => {
      const p = s.patients[pid];
      const card = el(
        "div",
        { class: `queue-card${i === 0 && hi ? " first" : ""}` },
        el("div", {
          class: "name",
          text: i === 0 ? `排第一 · ${p.chiefComplaint}` : p.chiefComplaint,
        }),
        el(
          "div",
          { class: "sub" },
          el("span", { class: `lamp ${ACUITY_CLASS[Math.min(p.acuity, 2)]}` }),
          el("span", { text: `${ACUITY_ZH[Math.min(p.acuity, 2)]}灯` }),
        ),
        p.deteriorationClock > 0
          ? el("div", { class: "wait", text: `他还能等 ${p.deteriorationClock} 个回合` })
          : null,
      );
      row.append(card);
    });
    if (s.queue.length > shown.length) {
      row.append(
        el("div", { class: "queue-card queue-rest", text: `还有 ${s.queue.length - shown.length} 个人在走廊里排队` }),
      );
    }
    box.append(row);
    return box;
  }

  // ── 一次性贴士条 ──────────────────────────────────────────

  /** 只在「情况本身是新的」时候弹（与旧版同一个 key 规则）。 */
  private maybeTip(): { key: string; title: string; body: string } | null {
    if (this.introIndex != null || this.state.outcome !== "ONGOING") return null;
    const h = coachHint(this.state, this.selectedBed);
    if (!h.title || !h.body) return null;
    const key = `${h.tipKey ?? h.highlight ?? "?"}|${h.highlightBed ?? ""}`;
    if (this.shownTips.has(key)) return null;
    this.shownTips.add(key);
    return { key, title: h.title, body: h.body };
  }

  /** 活跃贴士跨渲染存活：点一下动作不会让还没看完的贴士凭空消失。 */
  private drawTipToast(): HTMLElement | null {
    const TOAST_MS = 6000;
    const tip = this.pendingTip
      ? (this.activeTip = { ...this.pendingTip, until: Date.now() + TOAST_MS })
      : this.activeTip && Date.now() < this.activeTip.until
        ? this.activeTip
        : null;
    if (!tip) return null;
    const remain = Math.max(0, tip.until - Date.now());
    const toast = el(
      "div",
      { class: "tip-toast", "data-tip": "true" },
      el("span", { class: "tip-title", text: tip.title }),
      el("span", { class: "tip-body", text: tip.body }),
      el("span", { class: "tip-tag", text: "贴士 · 只提示这一次" }),
    );
    const wrap = el("div", { class: "tip-toast-wrap" }, toast);
    window.setTimeout(() => toast.classList.add("bye"), Math.max(1, remain - 700));
    window.setTimeout(() => wrap.remove(), remain);
    return wrap;
  }

  // ── 动作区 ────────────────────────────────────────────────

  private selectedPatient(): Patient | null {
    if (this.selectedBed == null) return null;
    const pid = this.state.beds[this.selectedBed];
    return pid ? this.state.patients[pid] : null;
  }

  /** 「治疗」按钮的动态形态（与旧版同一套措辞纪律）。 */
  private stabilizeButton(): { label: string; caption: string } {
    const p = this.selectedPatient();
    if (!p) return { label: "治疗", caption: "动手治病，按病情轻重定手数" };
    const cost = stabilizeCost(this.state, p);
    if (this.state.ap < cost) {
      return {
        label: "治疗",
        caption: `要 ${cost} 只手 · 这一回合只剩 ${this.state.ap} 只，下个回合再来`,
      };
    }
    const effect =
      p.acuity >= 2 ? `${cost} 只手 · 病情轻一级（还出不了院）` : `${cost} 只手 · 治好，他会自己出院`;
    if (p.axisIntervention === "MIRROR") {
      const scanned = p.revealed.includes("riskProfile");
      return {
        label: "治疗",
        caption: scanned ? `${effect}（已经查清该往哪个方向治）` : `${cost} 只手 · 还没查清该往哪个方向治`,
      };
    }
    return { label: "治疗", caption: effect };
  }

  private drawActions(hint: CoachHint): HTMLElement {
    const wrap = el("div", { class: "actions-wrap" });
    const row = el("div", { class: "actions" });
    const intro = this.introIndex != null ? this.intros()[this.introIndex] : null;
    // 列数显式写给 CSS（--n）：所有按钮落进同一行，顶端严格对齐
    row.style.setProperty("--n", String(this.state.enabledActions.length + 1));

    for (const type of this.state.enabledActions) {
      const legal = this.introIndex == null && this.actionIsUsable(type);
      const spotlight =
        (hint.highlight === "admit" && type === "ADMIT") ||
        (hint.highlight === "stabilize" && type === "STABILIZE") ||
        (hint.highlight === "scan" && type === "SCAN") ||
        (hint.highlight === "isolate" && type === "ISOLATE") ||
        (intro?.highlight === "stabilize" && type === "STABILIZE") ||
        (intro?.highlight === "scan" && type === "SCAN");
      const { label, caption } =
        type === "STABILIZE" ? this.stabilizeButton() : BASE_ACTION[type];

      const btn = el(
        "button",
        {
          class: `action-btn${legal ? "" : " disabled"}${spotlight ? " spotlight" : ""}`,
          type: "button",
        },
        el("div", { class: "label", text: label }),
        el("div", { class: "caption", text: caption }),
      );
      if (this.introIndex == null && this.state.outcome === "ONGOING") {
        btn.addEventListener("click", () => this.tryAction(type));
      }
      row.append(btn);
    }

    // 跳过：这一夜始终在场的第六个动作 —— 剩下的手不想要了，空过一手
    {
      const live = this.introIndex == null && this.state.outcome === "ONGOING" && this.state.ap > 0;
      const btn = el(
        "button",
        { class: `action-btn skip${live ? "" : " disabled"}`, type: "button" },
        el("div", { class: "label", text: SKIP_ACTION.label }),
        el("div", { class: "caption", text: SKIP_ACTION.caption }),
      );
      if (live) btn.addEventListener("click", () => this.dispatch({ type: "SKIP_HAND" }));
      row.append(btn);
    }
    wrap.append(row);
    return wrap;
  }

  private actionIsUsable(type: ActionType): boolean {
    const legal = legalActions(this.state);
    // 洗手是全局动作，不挂在任何患者身上，不依赖床位选择
    if (type === "HAND_HYGIENE") return legal.some((a) => a.type === "HAND_HYGIENE");
    if (type === "ADMIT") {
      return legal.some((a) => a.type === "ADMIT" && a.bedId === this.selectedBed);
    }
    const p = this.selectedPatient();
    if (!p) return false;
    return legal.some((a) => a.type === type && "patientId" in a && a.patientId === p.id);
  }

  private tryAction(type: ActionType): void {
    const reason = disabledReason(type, this.state, this.selectedBed);
    if (reason) play("click");
    if (reason) {
      this.flash = reason;
      this.render();
      return;
    }
    if (type === "ADMIT") {
      if (this.selectedBed == null) return;
      this.dispatch({ type: "ADMIT", bedId: this.selectedBed });
      return;
    }
    if (type === "HAND_HYGIENE") {
      this.dispatch({ type: "HAND_HYGIENE" });
      return;
    }
    const p = this.selectedPatient();
    if (!p) return;
    this.dispatch({ type, patientId: p.id } as PlayerAction);
  }

  private selectBed(id: number): void {
    play("click");
    this.selectedBed = id;
    this.detailOpen = false;
    this.flash = "";
    this.render();
  }

  // ── 右侧患者信息栏 ────────────────────────────────────────

  private drawSidePanel(): HTMLElement {
    const s = this.state;
    const panel = el("div", { class: "side-panel" });
    const p = this.selectedPatient();
    const emptySelected = this.selectedBed != null && s.beds[this.selectedBed] == null;

    if (!p) {
      panel.append(
        el("h3", {
          text: emptySelected ? `${this.selectedBed} 号床 · 空床` : "没有选中床位",
        }),
        el("div", {
          class: "muted",
          text: emptySelected
            ? "这张床上没有人。"
            : "点一张床，这里显示床上这个人的全部情况。",
        }),
      );
      return panel;
    }

    panel.append(
      el(
        "h3",
        {},
        el("span", { text: `${this.selectedBed} 号床` }),
        el("span", { class: `lamp ${ACUITY_CLASS[Math.min(p.acuity, 2)]}` }),
      ),
      el("div", {
        class: "sub-title",
        text: `${p.chiefComplaint} · ${ACUITY_ZH[Math.min(p.acuity, 2)]}灯`,
      }),
    );

    // 倒计时：这个患者最要紧的一个数字
    {
      const cd = countdownText(p);
      const color = !cd.urgent ? "muted" : p.acuity >= 2 ? "red" : "amber";
      panel.append(
        el("div", {
          class: `block ${color}`,
          text: cd.detail ? `${cd.text}（${cd.detail}）` : cd.text,
        }),
      );
    }

    if (p.disruptive) {
      panel.append(
        el("div", {
          class: "block amber",
          text: "神志不清、又喊又动：他躺在床上的时候，旁边几床做治疗都要多花 1 只手，得先分出人手把他按住。",
        }),
      );
    }
    if (p.timeWindow && p.windowClock > 0 && !p.sequela) {
      panel.append(
        el("div", {
          class: `block ${p.windowClock <= 1 ? "red" : "amber"}`,
          text: `抢救期限只剩 ${p.windowClock} 个回合。一超过这个期限，他会带着残疾离开病房${
            s.sequelaLimit === 0 ? "，而这一夜不允许任何人留下残疾" : ""
          }。`,
        }),
      );
    }
    const bedRisk = this.selectedBed != null ? s.bedRisk[this.selectedBed] ?? 0 : 0;
    if (s.bedUnitEnabled && bedRisk > 0) {
      panel.append(
        el("div", {
          class: "block amber",
          text: "这张床上还留着病菌。现在安排人住进来，他立刻会沾上。",
        }),
      );
    }
    if (p.utterance) {
      panel.append(el("div", { class: "block", text: `他说 —— ${p.utterance}` }));
    }

    if (p.vitals.length) {
      const vitals = el("div", { class: "vitals" });
      for (const v of p.vitals) {
        const cls = v.flag === "critical" ? "red" : v.flag ? "amber" : "muted";
        const mark = v.flag ? (FLAG_MARK[v.flag] ?? "") : "";
        vitals.append(
          el("div", { class: cls }, el("span", { text: v.label }), el("span", { text: `${v.value}${mark}` })),
        );
      }
      panel.append(vitals);
    }

    if (p.keyClue) {
      panel.append(el("div", { class: "block amber", text: `线索 —— ${p.keyClue}` }));
    }

    if (p.revealed.includes("riskProfile") && p.scanResult) {
      panel.append(el("div", { class: "block cyan", text: `检测 —— ${p.scanResult}` }));
    }

    if (p.axisIntervention === "MIRROR" && p.acuity > 0 && !p.revealed.includes("riskProfile")) {
      panel.append(
        el("div", {
          class: "block muted",
          text: "两种病长得几乎一样，病历上没写他是哪一种 —— 现在没有把握该往哪个方向治。",
        }),
      );
    }

    if (p.revealed.length) {
      const list = el("div", { class: "reveal-list" });
      for (const line of revealText(p)) {
        list.append(el("div", { class: "cyan", text: line }));
      }
      panel.append(list);
    }

    // 被传染的风险：不只给原始值，直接给「还差几点会出事」。
    // 同样守信息纪律：源没揭示、也没撞过时（disclosed = false）闭嘴，不剧透。
    if (s.infectionEnabled && this.selectedBed != null) {
      const sealed = isBedIsolated(s, this.selectedBed);
      const ex = exposureStatus(s, p);
      if (ex.disclosed && (ex.dose > 0 || ex.value > 0)) {
        let text: string;
        if (ex.dose > 0) {
          // 点数口径玩家读不懂（会被读成「还差几回合」），改说回合与后果
          text = "旁边床有人在传病给他：每个回合末都会传一次，这个回合末他就会加重一级";
          if (p.escalations > 0) text += `（他已经因为被传染加重过 ${p.escalations} 次）`;
          text += "。";
        } else {
          text = "他身上还留着被传染的风险，但现在没有人往这边传，不会再加重了。";
        }
        panel.append(
          el("div", { class: `block ${ex.dose > 0 ? "red" : "muted"}`, text }),
        );
      }
      if (sealed) {
        panel.append(
          el("div", { class: "block cyan", text: "他四周的帘子都挂上了，病传不出去了。" }),
        );
      }
    }

    if (p.deteriorationClock > 0) {
      panel.append(
        el("div", {
          class: "block muted",
          text: `接下来 ${p.deteriorationClock} 个回合之内，他的病情不会自己加重。`,
        }),
      );
    }
    if (canDischarge(p)) {
      panel.append(el("div", { class: "block green", text: "✓ 病情已经稳定，会自己出院" }));
    }

    // 空间还有富余时，补一块「谁最危险」（按数字排序的名单，不是建议）
    if (s.outcome === "ONGOING" && this.introIndex == null) {
      const list = Object.values(s.patients)
        .filter((q) => q.alive && !q.discharged)
        .map((q) => ({ q, cd: countdown(q) }))
        .filter((x) => x.cd.turnsToDeath != null)
        .sort((a, b) => {
          const d = (a.cd.turnsToDeath ?? 99) - (b.cd.turnsToDeath ?? 99);
          return d !== 0 ? d : b.q.acuity - a.q.acuity;
        })
        .slice(0, 3);
      if (list.length) {
        panel.append(el("hr"));
        panel.append(el("div", { class: "urgent-title", text: "谁最快撑不住" }));
        for (const { q, cd } of list) {
          const where = q.bedId != null ? `${q.bedId} 号床` : "走廊里";
          const n = cd.turnsToDeath ?? 0;
          const urgent = n <= 2;
          panel.append(
            el(
              "div",
              { class: `urgent-row${urgent ? " red" : " muted"}` },
              el("span", { class: "where", text: `${where} · ${q.chiefComplaint}` }),
              el("span", { text: `${n} 个回合后会死` }),
            ),
          );
        }
      }
    }

    return panel;
  }

  // ── 动作分发 ──────────────────────────────────────────────

  private dispatch(action: PlayerAction): void {
    if (this.state.outcome !== "ONGOING" || this.introIndex != null) return;
    const bedsBefore = { ...this.state.beds };
    const result = reduce(this.state, action);
    this.state = result.state;
    this.flash = flashLabel(result.events);
    if (result.accepted && result.state.outcome === "WIN") {
      unlockNextNight(this.state.nightId);
    }
    if (result.accepted && action.type === "ADMIT") {
      this.selectedBed = action.bedId;
      this.detailOpen = false;
    }
    if (action.type === "SCAN" && result.accepted) this.lastScanBed = this.selectedBed;
    else this.lastScanBed = null;
    if (action.type === "STABILIZE" && result.accepted && this.selectedBed != null) {
      const pid = bedsBefore[this.selectedBed];
      const before = pid ? this.state.patients[pid] : null;
      this.lastDischargeBed = before?.discharged ? this.selectedBed : null;
    } else {
      this.lastDischargeBed = null;
    }
    this.playSfxFor(result.events, this.state.outcome);
    this.render();
  }

  private playSfxFor(events: string[], outcome: string): void {
    if (outcome === "WIN") return void play("win");
    if (outcome === "LOSE") return void play("lose");
    const priority: Array<[RegExp, SfxName]> = [
      [/^MISDIAGNOSIS/, "reverse"],
      [/^DIED/, "reverse"],
      [/^WINDOW_CLOSED/, "escalate"],
      [/^QUEUE_PRESSURE/, "escalate"],
      [/^BED_UNIT_EXPOSURE/, "escalate"],
      [/^EXPOSURE_ESCALATE/, "escalate"],
      [/^HAND_CONTAMINATED/, "escalate"],
      [/^HAND_WASHED/, "click"],
      [/^SKIPPED_HAND/, "click"],
      [/^ISOLATED/, "isolate"],
      [/^DISCHARGED/, "discharge"],
      [/^STABILIZED/, "treat"],
      [/^ADMITTED/, "admit"],
      [/^SCANNED/, "scan"],
      [/^STABILIZE_INEFFECTIVE/, "escalate"],
    ];
    for (const [re, name] of priority) {
      if (events.some((e) => re.test(e))) {
        play(name);
        return;
      }
    }
  }

  // ── 覆盖层：黑幕标题开场 ──────────────────────────────────

  /** 进关黑幕：黑底居中「夜 04 / 标题 / 目标」，约 2 秒后自动淡出进病房，点击可跳过。 */
  private drawTitleCard(): HTMLElement {
    const s = this.state;
    const overlay = el(
      "div",
      { class: "title-intro" },
      el("div", { class: "title-night", text: `夜 ${s.nightId.slice(-2)}` }),
      el("div", { class: "title-name", text: s.title }),
      el("div", {
        class: "title-goal",
        text: `目标：${s.totalPatients} 个人全部出院 · 死 1 个人，或者回合用完还有人留在病房里，就算失败`,
      }),
    );
    overlay.addEventListener("click", () => this.dismissTitleCard());
    window.setTimeout(() => this.dismissTitleCard(), 2400);
    return overlay;
  }

  private dismissTitleCard(): void {
    if (!this.titleCard) return;
    this.titleCard = false;
    const node = this.root.querySelector(".title-intro");
    if (node) {
      node.classList.add("out");
      window.setTimeout(() => this.render(), 380);
    } else {
      this.render();
    }
  }

  // ── 覆盖层：开场卡 ────────────────────────────────────────

  private drawIntro(): HTMLElement {
    const cards = this.intros();
    const card = cards[this.introIndex ?? 0];
    if (!card) return el("div", {});
    const last = (this.introIndex ?? 0) >= cards.length - 1;
    const art = NIGHT_ART[this.state.nightId];

    return el(
      "div",
      { class: "overlay dim" },
      el(
        "div",
        { class: "overlay-panel" },
        el("div", { class: "step", text: `${(this.introIndex ?? 0) + 1} / ${cards.length}` }),
        el("h3", { text: card.title }),
        art ? el("img", { class: "scene-art", src: art, alt: "" }) : null,
        el("div", { class: "body", text: card.body }),
        el(
          "div",
          { class: "overlay-buttons" },
          el("button", {
            class: "primary-btn",
            text: last ? "开始这一夜" : "下一页",
            onclick: () => {
              if (last) this.introIndex = null;
              else this.introIndex = (this.introIndex ?? 0) + 1;
              this.render();
            },
          }),
        ),
      ),
    );
  }

  // ── 覆盖层：结算 ──────────────────────────────────────────

  private statsLine(): string {
    const s = this.state;
    return (
      `出院 ${Object.values(s.patients).filter((q) => q.discharged).length} / ${s.totalPatients}` +
      `${s.sequelaCount > 0 ? `（其中 ${s.sequelaCount} 人落下残疾）` : ""}` +
      ` · 死亡 ${s.deaths}` +
      ` · 用了 ${s.turn} / ${s.maxTurns} 回合` +
      (s.infectionEnabled ? ` · 有人被传染 ${s.infectionEvents} 次` : "")
    );
  }

  private drawOutcome(): HTMLElement {
    const win = this.state.outcome === "WIN";
    if (win) return this.drawWin();
    return this.drawLose();
  }

  private drawWin(): HTMLElement {
    const s = this.state;
    const next = nextNightId(s.nightId);
    return el(
      "div",
      { class: "overlay dim" },
      el(
        "div",
        { class: "overlay-panel result-pop win" },
        el("h2", { text: "全部出院了" }),
        el("img", { class: "scene-art", src: ART.winArt, alt: "" }),
        el("div", { class: "result-stats", text: this.statsLine() }),
        el("div", {
          class: "result-cheer",
          text: `${s.totalPatients} 个人全部送出院，没有一个人留在病房里。`,
        }),
        el(
          "div",
          { class: "overlay-buttons" },
          next
            ? el("button", {
                class: "primary-btn",
                text: `继续 · 夜 ${next.slice(-2)}`,
                onclick: () => {
                  this.state = createInitialState(levels[next]);
                  this.selectedBed = null;
                  this.detailOpen = false;
                  this.flash = "";
                  this.shownTips.clear();
                  this.outcomeStep = 0;
                  this.introIndex = NIGHT_INTROS[next] ? 0 : null;
                  this.titleCard = true;
                  this.render();
                },
              })
            : null,
          el("button", { class: "primary-btn ghost", text: "重玩本夜", onclick: () => this.restartNight() }),
          el("button", { class: "primary-btn ghost", text: "返回夜班列表", onclick: () => this.onExit() }),
        ),
      ),
    );
  }

  /**
   * 失败结算拆成两步弹窗（与开场贴士同一套 overlay-panel 风格）：
   *   第一步只回答「这一夜输在哪」—— 大图、一句结论、几条原因；
   *   点「继续」才进第二步 —— 历史案例（tips.ts）与「再来一次 / 返回」。
   * 不再出现双栏并排 —— 那种排版在手机上挤成一团。
   */
  private drawLose(): HTMLElement {
    const review = buildReview(this.state);
    return this.outcomeStep === 0 ? this.drawLoseCause(review) : this.drawLoseTips(review);
  }

  private drawLoseCause(review: Review): HTMLElement {
    const labelColor: Record<string, string> = {
      fatal: "fatal",
      cause: "cause",
      gap: "gap",
      advice: "advice",
      good: "good",
    };
    // 第一步只讲原因：谁没了、因为什么、哪一步漏了。「下一把改哪件事」放第二步。
    const causes = review.lines
      .filter((l) => l.kind === "fatal" || l.kind === "cause" || l.kind === "gap")
      .slice(0, 4);

    const panel = el(
      "div",
      { class: "overlay-panel result-pop lose" },
      el("div", { class: "step", text: `夜 ${this.state.nightId.slice(-2)} 结束 · 1 / 2` }),
      el("h2", { text: review.headline }),
      el("img", { class: "scene-art", src: ART.loseArt, alt: "" }),
      el("div", { class: "result-stats", text: this.statsLine() }),
    );
    if (causes.length) {
      const list = el("div", { class: "cause-list" });
      for (const line of causes) {
        list.append(
          el(
            "div",
            { class: "review-line" },
            el("div", { class: `kind ${labelColor[line.kind] ?? "muted"}`, text: line.label }),
            el("div", { class: "body", text: line.body }),
          ),
        );
      }
      panel.append(list);
    }
    panel.append(
      el(
        "div",
        { class: "overlay-buttons" },
        el("button", {
          class: "primary-btn",
          text: "继续",
          onclick: () => {
            play("click");
            this.outcomeStep = 1;
            this.render();
          },
        }),
      ),
    );
    return el("div", { class: "overlay dim" }, panel);
  }

  private drawLoseTips(review: Review): HTMLElement {
    const panel = el(
      "div",
      { class: "overlay-panel result-pop lose" },
      el("div", { class: "step", text: `夜 ${this.state.nightId.slice(-2)} 结束 · 2 / 2` }),
      el("div", { class: "result-recap", text: review.headline }),
      el("h3", { text: "历史案例 · 这些事现实里真的发生过" }),
    );
    const tips = resolveTips(this.state, 3);
    for (const tip of tips) {
      const box = el("div", { class: "death-tip", "data-tip": "true" });
      const headRow = el("div", { class: "head-row" }, el("span", { class: "head", text: tipHead(tip) }));
      if (tip.source) headRow.append(el("span", { class: "source", text: tip.source }));
      box.append(headRow);
      for (const [key, name] of TIP_SEGMENT_ORDER) {
        const body = tip.segments[key];
        if (!body) continue;
        // 「现实里」那段用深琥珀标出 —— 唯一引用真实事件的一段。
        box.append(
          el("div", {
            class: `seg${key === "reality" ? " reality" : ""}`,
            text: `${name}：${body}`,
          }),
        );
      }
      panel.append(box);
    }
    panel.append(el("div", { class: "result-disclaimer", text: TIP_DISCLAIMER }));
    panel.append(
      el(
        "div",
        { class: "overlay-buttons" },
        el("button", { class: "primary-btn", text: "再来一次", onclick: () => this.restartNight() }),
        el("button", { class: "primary-btn ghost", text: "返回夜班列表", onclick: () => this.onExit() }),
      ),
    );
    return el("div", { class: "overlay dim" }, panel);
  }

  private restartNight(): void {
    this.state = createInitialState(levels[this.state.nightId]);
    this.selectedBed = null;
    this.detailOpen = false;
    this.flash = "";
    this.introIndex = null;
    this.outcomeStep = 0;
    this.shownTips.clear();
    this.render();
  }
}
