import { describe, expect, it } from "vitest";
import night00 from "../levels/night-00.json";
import { replay } from "../src/core/replay";
import { createInitialState } from "../src/core/state";
import { solve } from "../src/solver";
import type { LevelDef } from "../src/core/types";

const level = night00 as unknown as LevelDef;
const gold = solve(level, { maxNodes: 100_000 }).path!;

describe("deterministic replay（契约 §9）", () => {
  it("同一 action 序列两次重放，终态 deepEqual", () => {
    const a = replay(level, gold);
    const b = replay(level, gold);
    expect(a.state).toEqual(b.state);
  });

  it("重放不污染初始状态（createInitialState 每次都从关卡重新构造）", () => {
    const before = createInitialState(level);
    replay(level, gold);
    const after = createInitialState(level);
    expect(after).toEqual(before);
  });
});
