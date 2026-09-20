/**
 * `src/ui/text.ts` —— 中文换行。
 *
 * 这层守的是一条**纯视觉**的底线，但它是「文案看起来像坏了」的唯一来源：
 * Phaser 自带换行会把中文整段切坏，所以这里必须自己按字符宽度断。
 * 断言只看两件事：不超宽，且续行不带缩进空格。
 */
import { describe, expect, it } from "vitest";
import { wrapCJK } from "../src/ui/text";

/** 估算宽度，与实现同口径（CJK/全角 1em，其余 0.5em）。 */
function widthOf(s: string, fontSize: number): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x2e80 && c <= 0x303e) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? fontSize : fontSize * 0.5;
  }
  return w;
}

describe("wrapCJK —— 中文按宽度断行", () => {
  it("每一行都不超过 maxWidth", () => {
    const text =
      "这一夜最多允许 1 次传染，实际发生了 2 次（第 1、2 回合）。每一次传染都来自一个没有挂帘子的缺口 —— 把旁边那个人隔离，或者把他治好，都能堵住。";
    const out = wrapCJK(text, 13, 276);
    for (const line of out.split("\n")) {
      expect(widthOf(line, 13)).toBeLessThanOrEqual(276);
    }
    expect(out.split("\n").length).toBeGreaterThan(1);
  });

  it("续行不能以空格开头 —— 否则会出现「…花 1 / ␣只手」这种坏排版", () => {
    const out = wrapCJK("宁可先花 1 只手做检测，看清了再动手。", 12, 90);
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.trimStart()).toBe(line);
    }
  });

  it("避头点不出现在行首", () => {
    const out = wrapCJK("先看床卡上「传染风险」那行还差几点到上限，差 1 点就是下个回合出事。", 12, 132);
    for (const line of out.split("\n")) {
      expect("，。、；：？！）」』】》”’".includes(line[0] ?? "")).toBe(false);
    }
  });

  it("保留显式换行（分段）", () => {
    expect(wrapCJK("第一段\n第二段", 12, 400)).toBe("第一段\n第二段");
  });
});
