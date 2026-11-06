#!/usr/bin/env bash
# 承载层部署脚本：4 个 TCB 函数 + 1 个 Cloudflare Worker
#
# 前置条件：
#   TCB（可选）：
#   1. 已 `tcb login`（腾讯云 TCB CLI，@cloudbase/cli）
#   2. 每个函数的 tcb.json 里 envVariables 填入真实密钥
#
#   Cloudflare（ai-relay Worker 独立上线，不依赖 TCB）：
#   1. cp ai-relay/.env.cloudflare.example ai-relay/.env.cloudflare.local
#      填入 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
#      （或 shell export CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID）
#   2. 可选：扩展 relay 白名单（默认走代码内置 DEFAULT_WHITELIST）
#
# 用法：
#   cd functions-cloud/providers
#   bash deploy.sh tcb        # 只部署 4 个 TCB 函数
#   bash deploy.sh workers    # 只部署 ai-relay Worker（不依赖 TCB，可独立先上线）
#   bash deploy.sh all        # 全部
set -euo pipefail

cd "$(dirname "$0")"

# ── TCB：4 个函数（asr / smtp-recovery / net-diagnose / reverse-geocode）──
# 实测环境：@cloudbase/cli 3.9.1（2026-11）。要点：
#   1. 云函数运行时只认 CJS + 默认入口 index.main → 必须先用 esbuild 编译 TS
#   2. fn deploy 必须带 --path /<name> 才会创建「HTTP 访问服务」，否则是纯 Event 函数、无公网 URL
#   3. fn deploy 不读 tcb.json 的 envVariables → 环境变量要用 tcb api scf UpdateFunctionConfiguration 单独写
#   4. 公网 URL 固定为 https://<envId>.service.tcloudbase.com/<path>
#   5. Git Bash 会把 /<name> 转成 Windows 路径 → 必须设 MSYS2_ARG_CONV_EXCL
deploy_tcb() {
  local TCB_CLI="${TCB_CLI:-npx -y @cloudbase/cli}"
  local TCB_ENV_ID="${TCB_ENV_ID:-}"
  local ONLY_FN="${2:-}"

  if [[ -z "${TCB_ENV_ID}" ]]; then
    echo "!!! 缺少 TCB 环境 ID。请：export TCB_ENV_ID=<instanceId>（npx -y @cloudbase/cli env list --json 可查）"
    exit 1
  fi

  local FN_LIST=("${ONLY_FN:-}")
  if [[ -z "${ONLY_FN}" ]]; then
    FN_LIST=(asr smtp-recovery net-diagnose reverse-geocode)
  fi

  for fn in "${FN_LIST[@]}"; do
    echo "--- 部署 TCB 函数 ${fn} ---"
    mkdir -p "../deploy/${fn}"

    # 1) TS → CJS。中转 ASCII 临时目录，规避 esbuild 在中文路径下参数解析异常。
    local TMPDIR_BUILD
    TMPDIR_BUILD="$(mktemp -d)"
    cp "${fn}/index.ts" "${TMPDIR_BUILD}/index.ts"
    npx -y esbuild "${TMPDIR_BUILD}/index.ts" \
      --bundle --platform=node --target=node18 --format=cjs \
      --outfile="${TMPDIR_BUILD}/index.js" || { echo "!!! ${fn} 编译失败，跳过"; continue; }
    cp "${TMPDIR_BUILD}/index.js" "../deploy/${fn}/index.js"
    rm -rf "${TMPDIR_BUILD}"
    printf '{"name":"%s","version":"1.0.0","main":"index.js"}\n' "${fn}" > "../deploy/${fn}/package.json"

    # 2) 部署 + 创建 HTTP 访问服务路径（--path 是关键）。
    printf 'y\n' | MSYS2_ARG_CONV_EXCL="/${fn}" ${TCB_CLI} fn deploy "${fn}" \
      --force --dir "../deploy/${fn}" --path "/${fn}" || {
        echo "!!! 函数 ${fn} 部署失败，继续下一个"; continue;
      }

    # 3) 读非空密钥写进云函数环境变量。
    #    真实密钥放 tcb.local.json（已 gitignore），仓库里的 tcb.json 只是空值模板。
    local BODY
    BODY="$(TCB_ENV_ID="${TCB_ENV_ID}" FN_NAME="${fn}" node -e '
      const fs = require("fs");
      const dir = "./" + process.env.FN_NAME + "/";
      const local = dir + "tcb.local.json";
      const c = require(fs.existsSync(local) ? local : dir + "tcb.json");
      const vars = Object.entries(c.envVariables || {})
        .filter(([, v]) => String(v) !== "")
        .map(([Key, Value]) => ({ Key, Value: String(Value) }));
      process.stdout.write(JSON.stringify({
        Namespace: process.env.TCB_ENV_ID,
        FunctionName: process.env.FN_NAME,
        Environment: { Variables: vars }
      }));
    ')" || { echo "!!! ${fn} tcb.json 解析失败"; continue; }
    ${TCB_CLI} api scf UpdateFunctionConfiguration --body "${BODY}" >/dev/null \
      && echo "    环境变量已写入（$(echo "${BODY}" | grep -o '"Key"' | wc -l) 项）" \
      || echo "!!! ${fn} 环境变量写入失败（可手动重试该 api 调用）"

    echo "    URL: https://${TCB_ENV_ID}.service.tcloudbase.com/${fn}"
  done

  echo ""
  echo "============================================================"
  echo "✅ TCB 网关根（VITE_CLOUD_FN_BASE_URL）："
  echo "   https://${TCB_ENV_ID}.service.tcloudbase.com"
  echo "⚠️  只有 4 个函数全部部署完才填这个值；否则未部署的能力会 404。"
  echo "   想单独启用某一类能力，见 DEPLOY.md「渐进式切换」一节。"
  echo "============================================================"
}

# ── Cloudflare：ai-relay Worker（不依赖 TCB，可独立上线）──
deploy_workers() {
  cd ai-relay

  # 从 .env.cloudflare.local 读凭证（若存在）
  if [[ -f .env.cloudflare.local ]]; then
    echo ">>> 读取 .env.cloudflare.local 凭证 ..."
    # 仅 source 这两行，避免把其它内容带进环境
    set -a
    # shellcheck disable=SC1091
    source .env.cloudflare.local
    set +a
  fi

  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    echo "!!! 缺少 CLOUDFLARE_API_TOKEN"
    echo "    请: cp .env.cloudflare.example .env.cloudflare.local 并填入真实 token + account_id"
    echo "    或: export CLOUDFLARE_API_TOKEN=xxx && export CLOUDFLARE_ACCOUNT_ID=xxx"
    exit 1
  fi
  if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    echo ">>> 部署 ai-relay Worker（account=${CLOUDFLARE_ACCOUNT_ID}）..."
    DEPLOY_OUT="$(npx -y wrangler deploy --account-id "${CLOUDFLARE_ACCOUNT_ID}" 2>&1)"
  else
    echo ">>> 部署 ai-relay Worker（未指定 account，走 wrangler login 态）..."
    DEPLOY_OUT="$(npx -y wrangler deploy 2>&1)"
  fi
  echo "${DEPLOY_OUT}" | tail -30

  # 抓 Worker 公网 URL（形如 https://ai-relay.<account>.workers.dev）
  WORKER_URL="$(echo "${DEPLOY_OUT}" | grep -oE 'https://ai-relay\.[a-z0-9-]+\.workers\.dev' | head -1 || true)"
  if [[ -n "${WORKER_URL}" ]]; then
    echo ""
    echo "============================================================"
    echo "✅ ai-relay Worker 已上线：${WORKER_URL}"
    echo ""
    echo "请把下面两行填进前端 .env 和 .env.miniprogram（去掉注释、填真实值）："
    echo "  VITE_CLOUD_FN_RELAY_URL=\"${WORKER_URL}\""
    echo "============================================================"
  else
    echo ""
    echo "⚠️  未能自动抓到 Worker URL（wrangler 日志格式可能变化），请手动从上方日志里找"
    echo "   形如 https://ai-relay.<account>.workers.dev 的地址，填入 .env 的 VITE_CLOUD_FN_RELAY_URL"
  fi
  cd ..
}

case "${1:-all}" in
  tcb) deploy_tcb "${1}" "${2:-}" ;;
  workers) deploy_workers ;;
  all) deploy_tcb "${1}" "${2:-}"; deploy_workers ;;
  *) echo "用法: $0 [tcb|workers|all] [可选:只部署某个 TCB 函数名，如 asr]"; exit 1 ;;
esac

echo ""
echo "📌 回填前端 URL 后可真机验收（DEPLOY.md 第四节验收对照表）："
echo "  TCB 网关 URL  → VITE_CLOUD_FN_BASE_URL"
echo "  Worker URL    → VITE_CLOUD_FN_RELAY_URL"
echo "  注释掉任一 URL → 自动回落旧 supabaseUrl + /functions/v1/* 网关"
