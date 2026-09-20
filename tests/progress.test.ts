import { describe, expect, it } from "vitest";
import { isNightUnlocked, nextNightId } from "../src/progress";

describe("night progression", () => {
  it("starts with only Night 00 unlocked", () => {
    expect(isNightUnlocked("night-00")).toBe(true);
    expect(isNightUnlocked("night-01")).toBe(false);
  });

  it("advances only to the next defined night", () => {
    expect(nextNightId("night-00")).toBe("night-01");
    expect(nextNightId("night-01")).toBe("night-02");
    expect(nextNightId("night-02")).toBe("night-03");
    expect(nextNightId("night-03")).toBe("night-04");
    expect(nextNightId("night-04")).toBe("night-05");
    expect(nextNightId("night-05")).toBe("night-06");
    // 最后一关之后没有下一关 —— 加新关卡时这条会红，提醒你同步更新
    expect(nextNightId("night-06")).toBeNull();
  });
});
