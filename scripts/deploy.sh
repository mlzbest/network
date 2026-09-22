#!/bin/bash
# deploy.sh - 统一部署脚本
# 确保 git版本 = package.json版本 = 微信上传版本 三者一致
#
# 用法:
#   ./scripts/deploy.sh              # 增量patch + 构建 + 上传
#   ./scripts/deploy.sh minor        # 增量minor + 构建 + 上传
#   ./scripts/deploy.sh "fix login"  # 带说明的增量

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

NOTE="${1:-Update}"

# ========== Step 0: 版本一致性检查 ==========
echo ""
echo "🔍 Step 0: 检查版本一致性..."

PKG_VERSION=$(grep '"version"' package.json | python3 -c "import sys,json;print(json.load(sys.stdin)['version'])")
LATEST_COMMIT=$(git log --oneline -1)

if echo "$LATEST_COMMIT" | grep -qi "v${PKG_VERSION}"; then
    echo "   ✅ 最新版本已匹配: $PKG_VERSION"
else
    echo "   ⚠️  最新版本未包含 $PKG_VERSION，将重新bump"
fi

# ========== Step 1: Bump Version ==========
echo ""
echo "🔨 Step 1: Bumping version..."
python3 scripts/bump-version.js "$NOTE"

NEW_VERSION=$(grep '"version"' package.json | python3 -c "import sys,json;print(json.load(sys.stdin)['version'])")
echo "   → 新版本: $NEW_VERSION"

# ========== Step 2: Build ==========
echo ""
echo "🔨 Step 2: Building mini program..."
pnpm build:weapp

# ========== Step 3: Commit ==========
echo ""
echo "🔨 Step 3: Committing..."
git add -A
git commit -m "chore: v${NEW_VERSION} deploy - ${NOTE}" || echo "   ℹ️  No changes to commit"

# ========== Step 4: Push ==========
echo ""
echo "🔨 Step 4: Pushing to github-ssh..."
git push github-ssh main

# ========== Step 5: Upload to WeChat ==========
echo ""
echo "🔨 Step 5: Uploading to WeChat..."
pnpm exec taro build --type weapp --upload --desc "Multi-platform Network Diagnostic & Chat Application"

echo ""
echo "✅ Deployed v${NEW_VERSION} successfully!"
echo "   QR: dist/upload.png"
echo "   → 请在微信后台设为体验版"
