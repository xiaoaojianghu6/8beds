export const tokens = {
  bg: 0xf4f3ee,
  surface: 0xffffff,
  navy: 0x172b3a,
  cyan: 0x5d9fa8,
  amber: 0xc59b4a,
  red: 0xb95555,
  muted: 0x6d7779,
  border: 0xd7d8d2,
  green: 0x5d8a72,
};

export const tokenCss = {
  bg: "#F4F3EE",
  surface: "#FFFFFF",
  navy: "#172B3A",
  cyan: "#5D9FA8",
  amber: "#C59B4A",
  red: "#B95555",
  muted: "#6D7779",
  border: "#D7D8D2",
  green: "#5D8A72",
  /**
   * 琥珀色的**正文墨色**。同一个色相，压暗到能在白底上读。
   *
   * 为什么必须另有一档：`amber #C59B4A` 对白底的对比度只有 **2.57:1**，
   * 远低于 AA 要求的 4.5:1。它当**标记色**（色块、图标、大字号标签）没问题，
   * 但当 12px 正文就是「灰蒙蒙一片」——而失败结算页上最该有分量的恰恰是
   * 「现实里」那一段（它引用真实病例）。用亮琥珀写它，等于让最重要的字最难读。
   *
   * `#8A6420` 是同一色相压暗，对白底 **5.35:1**，过 AA。
   * 亮琥珀继续留给需要「跳出来」的标记，深琥珀给需要「读进去」的正文。
   * 校验：`node -e` 算 WCAG 对比度（见 `docs/` 的文案/视觉纪律）。
   */
  amberInk: "#8A6420",
};

export const uiFont = "PingFang SC, Hiragino Sans GB, Noto Sans SC, sans-serif";
export const displayFont = "Iowan Old Style, Palatino, Songti SC, serif";
