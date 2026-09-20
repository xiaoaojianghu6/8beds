/**
 * 夜班列表（菜单）—— DOM 版。
 *
 * 深链接与 Boot 场景的语义一致：`?level=night-04` 直进某一夜、
 * `?unlock=5` 顺带解锁到第 N 夜、`?dev=1/0` 开关开发者模式（只影响本机）。
 */
import { levels, nightOrder } from "../levels";
import { isDevMode, isNightUnlocked, setDevMode } from "../progress";
import { play } from "./sfx";
import { el } from "./dom";

export function routeFromParams(): { levelId: string | null; handled: boolean } {
  try {
    const params = new URLSearchParams(window.location.search);
    const lvl = params.get("level");
    const unlock = Number(params.get("unlock"));
    const dev = params.get("dev");
    if (dev === "1" || dev === "0") {
      localStorage.setItem("8beds.dev", dev === "1" ? "1" : "");
      if (dev === "0") localStorage.removeItem("8beds.dev");
    }
    if (Number.isInteger(unlock) && unlock >= 0) {
      localStorage.setItem("8beds.unlockedNight", String(Math.min(unlock, nightOrder.length - 1)));
    }
    if (lvl && levels[lvl]) return { levelId: lvl, handled: true };
  } catch {
    /* 非浏览器环境忽略 */
  }
  return { levelId: null, handled: false };
}

export function renderMenu(root: HTMLElement, onPick: (levelId: string) => void): void {
  document.title = "八张床";

  const bg = el("div", { class: "menu-bg" });
  const devBadge = isDevMode()
    ? el("div", {
        class: "dev-badge",
        text: "DEV · 点击关闭",
        onclick: () => {
          setDevMode(false);
          renderMenu(root, onPick);
        },
      })
    : null;

  const list = el("div", { class: "menu-list" });
  nightOrder.forEach((levelId) => {
    const unlocked = isNightUnlocked(levelId) || isDevMode();
    const isHero = levelId === "night-00";
    const item = el(
      "div",
      { class: `menu-item${isHero ? " hero" : ""}${unlocked ? "" : " locked"}` },
      el("span", { class: "no", text: `夜 ${levelId.slice(-2)}` }),
      el("span", { class: "t", text: levels[levelId].title }),
      unlocked ? null : el("span", { class: "lock", text: "未解锁" }),
      isHero
        ? el("div", { class: "menu-item-desc" }, el("div", { text: "这一夜病房里没有病人，专门给你练手。" }))
        : null,
      isHero
        ? el("div", { class: "menu-item-desc" }, el("div", { text: "先点一张床，再点下面的按钮：每回合 3 只手，用完才前进。" }))
        : null,
      isHero
        ? el("div", { class: "menu-item-desc" }, el("div", { text: "用「治疗」把病情灯从红变黄、黄变绿 —— 变绿的人会自己出院。" }))
        : null,
    );
    if (unlocked) {
      item.addEventListener("click", () => {
        play("click");
        onPick(levelId);
      });
    }
    list.append(item);
  });

  // 彩蛋：连点标语 5 次 = 开发者模式开关（不用记 URL）
  const footer = el("div", { class: "menu-footer", text: "八张床 · 一个夜班 · 手只有这么多" });
  let taps = 0;
  let resetTimer: number | undefined;
  footer.addEventListener("click", () => {
    taps += 1;
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      taps = 0;
      footer.textContent = "八张床 · 一个夜班 · 手只有这么多";
    }, 2500);
    if (taps >= 2 && taps < 5) footer.textContent = `再点 ${5 - taps} 下…`;
    if (taps >= 5) {
      taps = 0;
      window.clearTimeout(resetTimer);
      const on = !isDevMode();
      setDevMode(on);
      play(on ? "discharge" : "click");
      renderMenu(root, onPick);
    }
  });

  const screen = el(
    "div",
    { class: "screen" },
    bg,
    devBadge,
    el(
      "div",
      { class: "menu" },
      el("h1", { text: "八张床" }),
      el("p", { class: "subtitle", text: "8 BEDS" }),
      list,
      footer,
    ),
  );

  root.replaceChildren(screen);
}
