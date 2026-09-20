/**
 * 按最优路径实走一遍（2026-09-18 用户要求：不用每次算，按最好的路径走，看中间响应正不正常）。
 *
 * 每关：求解最优解 → 逐步重放 → 打印每一步的动作与全部事件，并做三项体检：
 *   1. 任何 ADMITTED 事件必须来自当步的 ADMIT 动作（杜绝「自动收治」）
 *   2. 任意时刻全场被围死的床 ≤ 1（隔离互斥）
 *   3. 结局必须 WIN
 */
import { readFileSync } from "node:fs";
import { solve, formatPath } from "../src/solver";
import { reduce } from "../src/core/reducer";
import { createInitialState } from "../src/core/state";
import { isBedIsolated } from "../src/core/rules";
import type { GameState, LevelDef, PlayerAction } from "../src/core/types";

const load = (id: string): LevelDef =>
  JSON.parse(readFileSync(new URL(`../levels/${id}.json`, import.meta.url), "utf8"));

const ISOLATION_VIOLATION = "隔离互斥被破坏";
const GHOST_ADMIT = "出现不经 ADMIT 动作的收治";

function sealedBeds(s: GameState): number[] {
  const out: number[] = [];
  for (let bed = 1; bed <= 8; bed++) {
    if (s.beds[bed] == null) continue;
    if (isBedIsolated(s, bed)) out.push(bed);
  }
  return out;
}

function walk(lv: LevelDef, path: PlayerAction[]): { state: GameState; problems: string[] } {
  const problems: string[] = [];
  let s = createInitialState(lv);
  console.log(`\n=== ${lv.id}「${lv.title}」 路径 ${path.length} 手 ===`);
  console.log(
    `开局: 隔离位=${s.isolatedBedId ?? "无"} 被围死的床=[${sealedBeds(s)}] 走廊=[${s.queue.join(",")}]`,
  );
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    const r = reduce(s, a);
    if (!r.accepted) {
      problems.push(`第${i + 1}手 ${JSON.stringify(a)} 被拒`);
      console.log(`  #${i + 1} ${JSON.stringify(a)} ✗ 被拒`);
      continue;
    }
    s = r.state;
    const events = r.events.filter((e) => e !== "TURN_END");
    const flags: string[] = [];
    // 体检 1：ADMITTED 必须来自 ADMIT 动作
    for (const e of events) {
      if (e.startsWith("ADMITTED:") && a.type !== "ADMIT") flags.push(GHOST_ADMIT);
    }
    // 体检 2：隔离互斥
    const sealed = sealedBeds(s);
    if (sealed.length > 1) flags.push(`${ISOLATION_VIOLATION}:[${sealed}]`);
    const isoEvents = events.filter((e) => e.startsWith("ISOLATED:") || e.startsWith("ISOLATION_CLEARED"));
    const label =
      a.type === "ADMIT"
        ? `ADMIT→${a.bedId}床`
        : `${a.type} ${"patientId" in a ? a.patientId : ""}`;
    console.log(
      `  #${i + 1} T${s.turn} ${label} | ap${s.ap}` +
        (isoEvents.length ? ` ⭐[${isoEvents.join(",")}]` : "") +
        (events.length ? ` | ${events.join(" ")}` : "") +
        (flags.length ? ` ⚠ ${flags.join(";")}` : ""),
    );
    problems.push(...flags);
  }
  console.log(`  终局: ${s.outcome} 死亡${s.deaths} 出院${Object.values(s.patients).filter((p) => p.discharged).length}/${s.totalPatients} 感染${s.infectionEvents} 隔离位=${s.isolatedBedId ?? "无"}`);
  if (s.outcome !== "WIN") problems.push(`结局=${s.outcome}（应为 WIN）`);
  return { state: s, problems };
}

const allProblems: string[] = [];
for (const id of ["night-00", "night-01", "night-02", "night-03", "night-05"]) {
  const lv = load(id);
  const r = solve(lv, { maxNodes: 150_000 });
  if (!r.solvable || !r.path) {
    allProblems.push(`${id}: 求解失败（solvable=${r.solvable} exhausted=${r.exhausted} 节点${r.nodesExplored}）`);
    console.log(`\n=== ${id} 求解失败 ===`);
    continue;
  }
  console.log(`最小 ${r.minAP} AP / 余量 ${r.slack} / 节点 ${r.nodesExplored}`);
  const { problems } = walk(lv, r.path);
  allProblems.push(...problems.map((p) => `${id}: ${p}`));
}

// night-04 / night-06：精确 A* 超内存或超节点护栏 —— 按文档化例外用加权 A* 找可行解。
for (const id of ["night-04", "night-06"]) {
  const lv = load(id);
  const r = solve(lv, { maxNodes: 300_000, weight: 3 });
  if (r.solvable && r.path) {
    console.log(`\n(${id} 加权 A* 可行解 ${r.path.length} 手，minAP 口径为可行值 ${r.minAP})`);
    console.log("PATH-JSON: " + JSON.stringify(r.path));
    const { problems } = walk(lv, r.path);
    allProblems.push(...problems.map((p) => `${id}: ${p}`));
  } else {
    allProblems.push(`${id}: 加权 A* 也找不到解（节点${r.nodesExplored}）`);
    console.log(`\n=== ${id} 加权求解失败 ===`);
  }
}

console.log("\n======== 体检汇总 ========");
if (allProblems.length === 0) {
  console.log("全部通过：无自动收治、隔离全场唯一、七关全胜。");
} else {
  for (const p of allProblems) console.log("⚠ " + p);
}
void formatPath;
