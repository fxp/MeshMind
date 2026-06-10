#!/usr/bin/env bash
# MeshMind Hub 部署封装：认证一次后，Claude 可随时调用本脚本 deploy。
# 认证来源（任一即可）：
#   A. cloudflare/.deploy.env 里的 CLOUDFLARE_API_TOKEN（gitignore）
#   B. wrangler login 存在 ~ 下的凭证（需先 unset CLOUDFLARE_API_TOKEN 再 login）
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .deploy.env ] && { set -a; source .deploy.env; set +a; }
echo "→ wrangler deploy ..."
exec npx wrangler deploy "$@"
