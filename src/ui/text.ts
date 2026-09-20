/**
 * 中文友好的换行。
 *
 * 为什么不用 Phaser 自带的 `setWordWrapWidth`：
 * - basic wrap 只在**空格**处断行 —— 中文整段没有空格，会直接溢出；
 * - advanced wrap 先把文本按空格切成词，再逐个塞进一行。中文段落会被切成一个超长的「词」，
 *   于是它把光标移到下一行、再把这个词逐字切开，结果第一行只剩「把 4」这种断法，
 *   看着像排版坏了。
 *
 * 所以中文文本一律走这里：按**字符宽度**累加断行。
 * 宽度用估算（CJK 与全角标点 = 1 em，其余 = 0.5 em），对 UI 排版足够准，
 * 而且不需要在每次渲染时去问 canvas 要真实字宽。
 */

/** 估算单个字符占的宽度（px）。 */
function charWidth(code: number, fontSize: number): number {
  const isWide =
    (code >= 0x1100 && code <= 0x115f) || // 韩文字母
    (code >= 0x2e80 && code <= 0x303e) || // CJK 部首、标点
    (code >= 0x3041 && code <= 0x33ff) || // 假名、CJK 兼容
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
    (code >= 0xa000 && code <= 0xa4cf) || // 彝文
    (code >= 0xac00 && code <= 0xd7a3) || // 韩文音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角形式
    (code >= 0xffe0 && code <= 0xffe6); // 全角符号
  return isWide ? fontSize : fontSize * 0.5;
}

/** 不允许出现在行首的标点（避头点）。 */
const NO_LINE_START = "，。、；：？！）」』】》”’%,.;:?!)]}";

/**
 * 一段文字占多宽（px）—— 与 `wrapCJK` 用**同一套**字符宽度规则。
 *
 * 用途：判断两段文字会不会撞在一起。例如失败结算页的贴士标题行，左边是标题、
 * 右边右对齐挂着出处角标 —— 两边都不知道对方多宽，就会叠成一团。
 * 必须有这个函数，才能「先量再放」；用 `字数 × 字号` 估会把数字和标点算得太宽，
 * 于是明明放得下也被判成放不下。
 */
export function measureText(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch.codePointAt(0) ?? 0, fontSize);
  return w;
}

/**
 * 按显示宽度把文本切成多行。保留原有的 `\n` 分段。
 *
 * 断行时做一个最小的中文排版处理：若断点正好落在避头点**之前**，
 * 就把前一个字符一起挪到下一行，避免标点出现在行首。
 */
export function wrapCJK(text: string, fontSize: number, maxWidth: number): string {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let line = "";
    let width = 0;
    for (const ch of paragraph) {
      // 行首不留空格：断行后残留的空格必须丢掉，否则会出现「…花 1 / ␣手检查」这种带缩进的续行
      if (line === "" && ch === " ") continue;
      const cw = charWidth(ch.codePointAt(0) ?? 0, fontSize);
      if (line !== "" && width + cw > maxWidth) {
        // 避头点：当前字符是标点，则把它留在上一行（挤一点也比行首标点好看）
        if (NO_LINE_START.includes(ch)) {
          line += ch;
          out.push(line);
          line = "";
          width = 0;
          continue;
        }
        out.push(line);
        line = "";
        width = 0;
      }
      if (line === "" && ch === " ") continue;
      line += ch;
      width += cw;
    }
    out.push(line);
  }
  return out.join("\n");
}
