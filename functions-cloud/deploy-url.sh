#!/usr/bin/env bash
# 在你本机跑 wrangler deploy 后，把返回的 Worker 公网 URL 回填到前端 .env
# 用法：
#   cd functions-cloud/providers/ai-relay
#   bash ../../../functions-cloud/deploy-url.sh <worker-url>
# 例如：
#   bash deploy-url.sh https://ai-relay.e67f8c9a0b1d2e3f.workers.dev
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "用法: $0 <worker-url>"
  echo "  worker-url 形如 https://ai-relay.<account>.workers.dev"
  exit 1
fi

WORKER_URL="$1"
# 规范化：去尾斜杠
WORKER_URL="${WORKER_URL%/}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
ENV_MP_FILE="${REPO_ROOT}/.env.miniprogram"

echo ">>> 回填 VITE_CLOUD_FN_RELAY_URL=\"${WORKER_URL}\" 到 .env 和 .env.miniprogram"

for f in "$ENV_FILE" "$ENV_MP_FILE"; do
  if [[ ! -f "$f" ]]; then
    echo "  (跳过 $f：不存在)"; continue
  fi
  # 用 python 安全替换（避免 sed 的转义陷阱）
  python3 - "$f" "$WORKER_URL" <<'PY'
import sys, re
path, url = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as fp:
    text = fp.read()
# 匹配 VITE_CLOUD_FN_RELAY_URL=... 或 # VITE_CLOUD_FN_RELAY_URL=... 行
new_lines = []
replaced = False
for line in text.splitlines(keepends=True):
    m = re.match(r'^\s*(#\s*)?VITE_CLOUD_FN_RELAY_URL=.*$', line)
    if m:
        # 取消注释（若被注释）+ 替换为真实值
        new_lines.append(f'VITE_CLOUD_FN_RELAY_URL="{url}"\n')
        replaced = True
    else:
        new_lines.append(line)
if not replaced:
    # 追加到文件末尾
    new_lines.append(f'\nVITE_CLOUD_FN_RELAY_URL="{url}"\n')
with open(path, "w", encoding="utf-8") as fp:
    fp.write("".join(new_lines))
print(f"  updated {path}")
PY
done

echo ""
echo "✅ 已回填。验证："
grep -n "VITE_CLOUD_FN_RELAY_URL" "$ENV_FILE" "$ENV_MP_FILE" 2>/dev/null || echo "  (grep 无结果)"
echo ""
echo "下一步：pnpm build:weapp（或 build:dd/build:douyin）真机验收 relay 通道"
