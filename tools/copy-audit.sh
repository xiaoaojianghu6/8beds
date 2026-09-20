#!/usr/bin/env bash
#
# 文案「真实渲染」审计 —— 静态护栏之外的最后一关。
#
# 为什么需要它：`tests/copy.test.ts` 只能保证**字面里没有**违规词，
# 它保证不了「这一整句话是废话」，也抓不到**组合出来的**句子。
# 实测教训（2026-09-16）：三层静态护栏全绿的那一版，线上仍然留着
#   - night-06 的线索「要围别人，就得从他这儿抽走」（措辞变了，正则没匹配上）
#   - chiefComplaint「撕开」渲染成「撕开 · 黄灯」（裸动词当标签）
#   - coach 提示里四处复述帘子机制
# 所以凡是用户抱怨过的**某一类**说法，验收都要走一次这个脚本：把玩家真正看到的字 dump 出来逐屏读。
#
# 做法：canvas 里没有 DOM 文本，只能 `window.__game`（`src/game/main.ts` 暴露）
# 遍历 Phaser 显示列表取 `Text` 对象 —— 逐张床选中（右栏文案全在这）再乱走到判负（复盘文案）。
#
# 用法：
#   bash tools/copy-audit.sh                                  # 审线上
#   bash tools/copy-audit.sh http://localhost:5173            # 审本地 dev server
#   bash tools/copy-audit.sh https://game.8beds.haozi.dev "night-06"
#   DUMP=1 bash tools/copy-audit.sh                           # 顺便把逐关原文落到 /tmp/copy-audit/
#
# 注意：本脚本里的 BANNED 是与 `tests/copy.test.ts` 平行的**第二份**名单，
# 只做字面量拦截（有意不用正则，正则写太字面就是给同类废话留后门）。
# 那边改了词，这边要同步 —— 两边职责不同：那边防回退，这边负责读得出来。
#
# **贴士是唯一放行区**（2026-09-17 用户拍板：「用真实疾病，专业知识术语，真实医疗事故」；
# 随后又追问「谵妄啥意思，这是医学专业术语？医学术语可以用，其他一律不准看不懂」）。
# 放行靠 `Ward.ts` 给贴士的 Text 打 `setData("tip", true)` 标记来识别，
# 与 `tests/copy.test.ts → TIP_MEDICAL_TERMS`（只收真实诊断名，当前恰好 1 个）是同一政策
# 的两层实现：那边管源码字面量，这边管渲染出来的字。**只放行术语**，碎片与内部编号对贴士照旧全量适用。
# 注意两层口径的差：源码层只放行白名单里的那一个词，渲染层因为拿不到「哪个词在标题上」
# 的上下文，只能整个贴士块放行 —— 所以**标题必须通俗**这条由 `tests/copy.test.ts` 硬保证。
# 本脚本自带防空转自检：一局里贴士块计数为 0 就直接判失败 ——
# 标签静默丢失时，放行会整个失效而「0 违规」看起来仍然像通过。
set -uo pipefail

BASE="${1:-https://game.8beds.haozi.dev}"
LEVELS="${2:-night-00 night-01 night-02 night-03 night-04 night-05 night-06}"
WAIT_MS="${WAIT:-5000}"
OUT_DIR="${OUT_DIR:-/tmp/copy-audit}"

PAYLOAD="$(mktemp -t copy-audit-payload.XXXXXX.js)"
trap 'rm -f "$PAYLOAD"; agent-browser close >/dev/null 2>&1' EXIT

cat > "$PAYLOAD" <<'JS'
(() => {
  const g = window.__game;
  if (!g || !g.scene) return JSON.stringify({ error: "no __game" });
  const s = g.scene.getScene("Ward");
  if (!s || !s.scene || !s.scene.isActive()) {
    return JSON.stringify({
      error: "Ward not active",
      scenes: (g.scene.getScenes(true) || []).map((x) => x.scene.key),
    });
  }

  // 与 tests/copy.test.ts 平行的一份字面量名单（有意不做正则花样）
  const BANNED = [
    // ① 术语与文艺化表达
    "帘轨", "谵妄", "暴露", "升档", "档位", "阈值", "定植", "隐匿", "体征",
    "处置", "剂量", "缓冲", "不可逆",
    // ② 缺主语的碎片（用户点名过的原句）
    "不会自己变差", "撑不过这一回合", "最多再撑", "顶过线", "顶上去", "缺口", "口子",
    // ③ 动作过程复述（「围住他就会从别处抽走帘子」这类废话）
    "抽走",
    // ④ 指意不明的裸标签
    "压榨感",
  ];
  // 「缝」要放过「缝合」，所以单独用正则
  const SPECIAL = [[/缝(?!合)/, "缝"]];

  // 内部编号：N01 / S01 / T01 是数据结构，不是人
  const PATIENT_ID = /(?<![A-Za-z0-9])[A-Z]\d{2}(?![A-Za-z0-9])/;

  const seen = new Set();
  const offenses = [];
  let scanned = 0;
  let tipScanned = 0;
  let exemptHits = 0;

  const collect = () => {
    const walk = (o, d) => {
      if (!o || d > 14) return;
      if (o.type === "Text" && typeof o.text === "string" && o.text.length) {
        scanned++;
        if (!seen.has(o.text)) {
          seen.add(o.text);
          // 贴士块（`Ward.ts` 里 `setData("tip", true)` 标记的那些 Text）是
          // 全项目**唯一**允许出现医学术语的地方 —— 用户 2026-09-17 拍板：
          // 「用真实疾病，专业知识术语，真实医疗事故」。`tests/copy.test.ts`
          // 的 `TIP_MEDICAL_TERMS` 放行的是同一批内容，这里是它在渲染层的对偶。
          //
          // 但放行**只覆盖术语**：碎片与内部编号对贴士照旧全量适用，
          // 因为「主动脉夹层」是专业，「撕开」还是缺主语的裸动词。
          const isTip = typeof o.getData === "function" && o.getData("tip") === true;
          if (!isTip) {
            for (const w of BANNED) if (o.text.includes(w)) offenses.push(`禁用词「${w}」 :: ${o.text}`);
            for (const [re, name] of SPECIAL) if (re.test(o.text)) offenses.push(`禁用词「${name}」 :: ${o.text}`);
          } else {
            // 自检口径：豁免必须**真的在用**。数一数它到底放过了几个词 ——
            // 标签哪天静默丢了（`Ward.ts` 改了渲染路径），tipScanned 会掉到 0
            // 并直接判失败，而不是伪装成「0 违规」蒙混过关。
            tipScanned++;
            for (const w of BANNED) if (o.text.includes(w)) exemptHits++;
            for (const [re] of SPECIAL) if (re.test(o.text)) exemptHits++;
          }
          if (PATIENT_ID.test(o.text)) offenses.push(`内部编号 :: ${o.text}`);
        }
      }
      const kids = o.list || (o.children && o.children.list);
      if (Array.isArray(kids)) for (const k of kids) walk(k, d + 1);
    };
    for (const o of s.children.list) walk(o, 0);
  };

  collect(); // 未选床的整屏
  s.introIndex = null; // 跳过开场卡
  for (let b = 1; b <= 8; b++) {
    try { s.selectBed(b); } catch (e) { /* 床不存在就跳过 */ }
    collect();
  }
  // 一路乱走到终局：让真实的结算界面（胜或负、含失败复盘）上屏。
  //
  // 为什么要**轮着把所有动作都试一遍**：`dispatch` 对不合法的动作会被 reducer 拒绝，
  // 既不花手也不推进回合 —— 只反复 SCAN 同一批人会卡死在 ONGOING（night-00 就是这么卡的）。
  // 只有真的花掉手，回合才会结算，患者才会恶化到死，结算界面才会上屏。
  const cands = [];
  for (const pid of Object.keys(s.state.patients)) {
    cands.push({ type: "SCAN", patientId: pid });
    cands.push({ type: "STABILIZE", patientId: pid });
    cands.push({ type: "ISOLATE", patientId: pid });
  }
  for (const b of [1, 2, 3, 4, 5, 6, 7, 8]) cands.push({ type: "ADMIT", bedId: b });
  cands.push({ type: "HAND_HYGIENE" });

  for (let i = 0; i < cands.length * 6 && s.state.outcome === "ONGOING"; i++) {
    try {
      s.dispatch(cands[i % cands.length]);
    } catch (e) { break; }
  }
  collect();

  return JSON.stringify({
    scene: s.scene.key,
    build: (document.querySelector('script[src*="assets/index-"]') || {}).src || "?",
    turn: s.state.turn,
    outcome: s.state.outcome,
    scanned,
    tipScanned,
    exemptHits,
    unique: seen.size,
    offenses,
    strings: [...seen],
  });
})()
JS

fail=0
printf '文案审计 · %s\n\n' "$BASE"
for lv in $LEVELS; do
  num=$((10#${lv#night-}))
  # `cb=` 是防御性的：浏览器对 `index.html` 会走 HTTP 缓存，而这份 HTML 里写着
  # 带 hash 的 JS 文件名 ⇒ 刚部署完立刻审计时，缓存里的旧 HTML 会把审计指向
  # **上一个包**，新加的护栏看起来像没生效。审计必须能证明自己审的是哪个包，
  # 所以下面把 `build`（实际加载的 JS 文件名）随结果一起打出来。
  agent-browser open "$BASE/?dev=1&level=$lv&unlock=$num&cb=$(date +%s)" >/dev/null 2>&1
  agent-browser wait "$WAIT_MS" >/dev/null 2>&1
  raw="$(agent-browser eval "$(cat "$PAYLOAD")" 2>&1)"

  if [ "${DUMP:-0}" = "1" ]; then
    mkdir -p "$OUT_DIR"
    printf '%s' "$raw" | tr -d '\\' > "$OUT_DIR/$lv.json"
  fi

  flat="$(printf '%s' "$raw" | tr -d '\\')"
  build="$(printf '%s' "$flat" | sed -n 's/.*build":"\([^"]*\)".*/\1/p' | sed 's#.*/##')"
  scanned="$(printf '%s' "$flat" | sed -n 's/.*scanned":\([0-9]*\).*/\1/p')"
  tipscanned="$(printf '%s' "$flat" | sed -n 's/.*tipScanned":\([0-9]*\).*/\1/p')"
  exempt="$(printf '%s' "$flat" | sed -n 's/.*exemptHits":\([0-9]*\).*/\1/p')"
  unique="$(printf '%s' "$flat" | sed -n 's/.*unique":\([0-9]*\).*/\1/p')"
  outcome="$(printf '%s' "$flat" | sed -n 's/.*outcome":"\([A-Z]*\)".*/\1/p')"
  offenses="$(printf '%s' "$flat" | sed -n 's/.*offenses":\[\(.*\)\],"strings".*/\1/p')"
  [ -z "$build" ] && build="?"

  if printf '%s' "$raw" | grep -q 'error'; then
    printf '  %-9s ✗ 没进到病房（Ward 未激活）\n' "$lv"
    fail=1
    continue
  fi

  # 自检：每一局都以 LOSE 收场（脚本乱走到终局），失败页必有贴士块。
  # 贴士块一个没标上 ⇒ 术语豁免整个空转 ⇒ 下面的 ✓ 是假的。
  if [ "${tipscanned:-0}" = "0" ]; then
    printf '  %-9s ✗ 贴士块没被标记（tipScanned=0）—— 术语豁免空转，本次结论不可信\n' "$lv"
    printf '  %-9s   审的是 %s —— 确认它是不是刚构建的那个包\n' "" "$build"
    fail=1
    continue
  fi

  if [ -z "$offenses" ]; then
    printf '  %-9s ✓ 0 违规  %-14s outcome=%-5s 文本 %s / 去重 %s · 贴士块 %s（豁免术语 %s 处）\n' \
      "$lv" "$build" "$outcome" "$scanned" "$unique" "$tipscanned" "$exempt"
  else
    printf '  %-9s ✗ 违规（%s）：\n' "$lv" "$build"
    printf '%s' "$offenses" | tr ',' '\n' | sed 's/^/      /'
    fail=1
  fi
done

if [ "$fail" != "0" ]; then
  printf '\n不过关 —— 上面每一条都是玩家真的会看到的字。\n'
  printf '文字型违规优先修源头；修完记得把词加进 tests/copy.test.ts 防回退。\n'
else
  printf '\n全过。注意这**不能**替代人读一遍：机器只挡已知词，读起来像不像人话还得自己看。\n'
  printf '想看原文：DUMP=1 bash tools/copy-audit.sh（落到 %s）\n' "$OUT_DIR"
fi
exit "$fail"
