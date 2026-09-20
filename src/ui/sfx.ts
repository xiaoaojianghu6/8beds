/**
 * 程序合成音效 —— 零素材，WebAudio 振荡器直接出声。
 *
 * 设计约束（04-ART-DIRECTION 的听觉版）：
 *   声音是信息的回声，不是气氛音乐。每个声音都对应一个结算事实，
 *   没有环境音、没有循环 BGM。音量全部压低（峰值 ≤ 0.12），
 *   静音状态存 localStorage（`8beds.muted`），首次用户手势时才创建 AudioContext。
 */
export type SfxName =
  | "click"
  | "admit"
  | "scan"
  | "treat"
  | "discharge"
  | "reverse"
  | "remedy"
  | "isolate"
  | "escalate"
  | "win"
  | "lose";

let ctx: AudioContext | null = null;
let muted = false;

if (typeof localStorage !== "undefined") {
  try {
    muted = localStorage.getItem("8beds.muted") === "1";
  } catch {
    /* 隐私模式等场景下不可用，保持默认开声 */
  }
}

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

type ToneOpts = {
  type?: OscillatorType;
  gain?: number;
  /** 相对当前时刻的起始偏移（秒） */
  at?: number;
  /** 滑向的频率（音高滑动） */
  slideTo?: number;
};

function tone(
  freq: number,
  dur: number,
  { type = "sine", gain = 0.07, at = 0, slideTo }: ToneOpts = {},
): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

export function play(name: SfxName): void {
  if (muted) return;
  switch (name) {
    case "click":
      tone(880, 0.045, { type: "triangle", gain: 0.03 });
      break;
    case "admit":
      tone(520, 0.07, { type: "triangle", gain: 0.05 });
      tone(660, 0.08, { type: "triangle", gain: 0.05, at: 0.07 });
      break;
    case "scan":
      tone(1180, 0.08, { gain: 0.05 });
      tone(1560, 0.09, { gain: 0.05, at: 0.09 });
      break;
    case "treat":
      tone(660, 0.12, { slideTo: 880, gain: 0.06 });
      break;
    case "discharge":
      tone(784, 0.09, { gain: 0.05 });
      tone(988, 0.09, { gain: 0.05, at: 0.08 });
      tone(1319, 0.14, { gain: 0.05, at: 0.16 });
      break;
    case "reverse":
      tone(196, 0.28, { type: "sawtooth", gain: 0.09 });
      tone(147, 0.3, { type: "sawtooth", gain: 0.08, at: 0.1 });
      break;
    case "remedy":
      tone(440, 0.1, { slideTo: 550, gain: 0.06 });
      tone(550, 0.1, { slideTo: 660, gain: 0.06, at: 0.1 });
      break;
    case "isolate":
      tone(320, 0.12, { type: "triangle", gain: 0.06 });
      tone(240, 0.16, { type: "triangle", gain: 0.05, at: 0.1 });
      break;
    case "escalate":
      tone(220, 0.2, { type: "sawtooth", gain: 0.07, slideTo: 160 });
      break;
    case "win":
      tone(523, 0.12, { gain: 0.06 });
      tone(659, 0.12, { gain: 0.06, at: 0.12 });
      tone(784, 0.12, { gain: 0.06, at: 0.24 });
      tone(1047, 0.3, { gain: 0.06, at: 0.36 });
      break;
    case "lose":
      tone(330, 0.3, { type: "sawtooth", gain: 0.07, slideTo: 220 });
      tone(165, 0.4, { type: "sawtooth", gain: 0.06, at: 0.25, slideTo: 110 });
      break;
  }
}

export function toggleMuted(): boolean {
  muted = !muted;
  try {
    localStorage.setItem("8beds.muted", muted ? "1" : "0");
  } catch {
    /* ignore */
  }
  return muted;
}

export function isMuted(): boolean {
  return muted;
}
