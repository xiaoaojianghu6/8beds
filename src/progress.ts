import { nightOrder } from "./levels";

const STORAGE_KEY = "8beds.unlockedNight";
const DEV_KEY = "8beds.dev";

/**
 * 开发者模式：跳过解锁进度，任意关卡直接可玩。
 * 入口：URL `?dev=1` 开启、`?dev=0` 关闭（Boot 落到 localStorage，之后无需再带参数）。
 * 只影响本机浏览器，不影响普通玩家的解锁曲线。
 */
export function isDevMode(): boolean {
  try {
    return localStorage.getItem(DEV_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDevMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(DEV_KEY, "1");
    else localStorage.removeItem(DEV_KEY);
  } catch {
    /* ignore */
  }
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function unlockedNightIndex(): number {
  const raw = storage()?.getItem(STORAGE_KEY);
  const parsed = raw == null ? 0 : Number(raw);
  if (!Number.isInteger(parsed)) return 0;
  return Math.max(0, Math.min(parsed, nightOrder.length - 1));
}

export function isNightUnlocked(levelId: string): boolean {
  if (isDevMode()) {
    return nightOrder.includes(levelId as (typeof nightOrder)[number]);
  }
  const index = nightOrder.indexOf(levelId as (typeof nightOrder)[number]);
  return index >= 0 && index <= unlockedNightIndex();
}

export function unlockNextNight(levelId: string): void {
  const index = nightOrder.indexOf(levelId as (typeof nightOrder)[number]);
  if (index < 0) return;
  const nextIndex = Math.min(index + 1, nightOrder.length - 1);
  const current = unlockedNightIndex();
  if (nextIndex <= current) return;
  storage()?.setItem(STORAGE_KEY, String(nextIndex));
}

export function nextNightId(levelId: string): string | null {
  const index = nightOrder.indexOf(levelId as (typeof nightOrder)[number]);
  return index >= 0 && index + 1 < nightOrder.length ? nightOrder[index + 1] : null;
}
