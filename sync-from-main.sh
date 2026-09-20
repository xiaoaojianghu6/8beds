#!/usr/bin/env bash
# 从主开发仓库同步增量到开源仓库。
#
# 用法：在 ~/Projects/8beds-oss 下执行 ./sync-from-main.sh
# 同步完成后 git add -A && git commit && git push 即可发布。
#
# 同步什么：src/ levels/ tests/ tools/ public/ index.html 及构建配置
# 不同步什么：主仓库的 docs/ .workbuddy/ spec/（设计过程与内部文档）
#             以及本仓库手工维护的 package.json（主仓库依赖 phaser，此处已去除）
# 结构差异自动处理：src/game/progress.ts → src/progress.ts（Phaser 场景是死代码，不导出）

set -euo pipefail

MAIN="$HOME/Projects/8beds游戏"
OSS="$(cd "$(dirname "$0")" && pwd)"

[ -d "$MAIN" ] || { echo "找不到主仓库 $MAIN"; exit 1; }

echo "→ 同步 src / levels / tests / tools / public"
rsync -a --delete --exclude '.DS_Store' --exclude 'game' "$MAIN/src/" "$OSS/src/"
rsync -a --delete --exclude '.DS_Store' "$MAIN/levels/" "$OSS/levels/"
rsync -a --delete --exclude '.DS_Store' --exclude 'tmp' "$MAIN/tests/" "$OSS/tests/"
rsync -a --delete --exclude '.DS_Store' --exclude 'tmp' "$MAIN/tools/" "$OSS/tools/"
rsync -a --delete --exclude '.DS_Store' "$MAIN/public/" "$OSS/public/"
cp "$MAIN/index.html" "$OSS/index.html"
cp "$MAIN/tsconfig.json" "$OSS/tsconfig.json"
cp "$MAIN/vite.config.ts" "$OSS/vite.config.ts"
cp "$MAIN/vitest.config.ts" "$OSS/vitest.config.ts"

echo "→ 处理结构差异：src/game/progress.ts → src/progress.ts"
cp "$MAIN/src/game/progress.ts" "$OSS/src/progress.ts"
sed -i '' 's|from "../levels"|from "./levels"|' "$OSS/src/progress.ts"
sed -i '' 's|from "\.\./game/progress"|from "../progress"|g' "$OSS/src/ui/ward-view.ts" "$OSS/src/ui/menu-view.ts"
sed -i '' 's|from "\.\./src/game/progress"|from "../src/progress"|' "$OSS/tests/progress.test.ts"

echo "→ 校验（tsc + 测试）"
npm --prefix "$OSS" run verify >/dev/null 2>&1 || {
  echo "!! verify 未通过——请检查上方改动后再提交"; exit 1;
}
echo "✓ 同步完成且 verify 全绿。接下来：git add -A && git commit -m '...' && git push"
