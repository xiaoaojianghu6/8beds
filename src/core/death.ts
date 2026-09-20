/**
 * 死亡的唯一出口。
 *
 * 为什么单开一个叶模块：核心层有两个地方会让人死 ——
 *
 *   ① `reducer.reapDead()` —— 自然病程 / 传染 / 队列压力把人推到 `acuity >= 3`；
 *   ② `actions.stabilize()` —— 误诊（Contract §5.3）：不检测就治「方向相反的病」。
 *
 * 两处必须做**同一套善后**（释放床位、按 §6A.2 留下床单元污染、`deaths + 1`、
 * 打出带床位的 `DIED` 事件），否则「死在床上的人有没有留下污染」会随死因漂移 ——
 * 而这类漂移一旦发生，`BED_UNIT_EXPOSURE` 那条贴士的归因就再也对不上。
 *
 * 不放在 `reducer.ts` 里的理由：`actions.ts` 也要用它，而 reducer 已经 import 了 actions，
 * 反向再 import 会形成循环。叶模块是唯一不引入环的摆法。
 */
import type { GameState, Patient } from "./types";

/**
 * 让一个人死掉，并做完全部善后。幂等：对已经死掉的人再调一次无效果。
 *
 * `DIED` 事件里的位置写法与 `DETERIORATED` 完全一致（`BED<n>` / `QUEUE`）——
 * 失败复盘要靠它说「4 号床 · 受了外伤」，**绝不允许**回退到内部编号。
 */
export function killPatient(state: GameState, p: Patient, events: string[]): void {
  if (!p.alive) return;

  p.alive = false;
  p.observing = false;
  p.observationClock = 0;

  // 位置必须先记下来再清床位 —— 清了就再也说不出他死在几号床。
  const location = p.bedId == null ? "QUEUE" : `BED${p.bedId}`;

  if (p.bedId != null) {
    // 床单元污染（Contract §6A.2）：HIGH 源死在床上，这张床从此不干净。
    if (state.bedUnitEnabled && p.transmission === "HIGH") {
      state.bedRisk[p.bedId] = Math.max(state.bedRisk[p.bedId] ?? 0, 2);
      events.push(`BED_CONTAMINATED:${p.bedId}:risk2`);
    }
    state.beds[p.bedId] = null;
  }

  p.bedId = null;
  state.queue = state.queue.filter((id) => id !== p.id);
  state.deaths += 1;
  events.push(`DIED:${p.id}:${location}`);
}
