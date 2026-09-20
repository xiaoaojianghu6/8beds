import { reduce } from "./reducer";
import { createInitialState } from "./state";
import type { LevelDef, PlayerAction, ReduceResult } from "./types";

export function replay(level: LevelDef, actions: PlayerAction[]): {
  state: ReturnType<typeof createInitialState>;
  log: ReduceResult[];
} {
  let state = createInitialState(level);
  const log: ReduceResult[] = [];
  for (const action of actions) {
    const result = reduce(state, action);
    state = result.state;
    log.push(result);
  }
  return { state, log };
}
