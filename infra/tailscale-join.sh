#!/usr/bin/env bash
# 把当前机器加入 Tailscale tailnet。macOS 走 Homebrew，Linux 走官方安装脚本。
# 出于 git 安全考虑，key 不写死在本脚本里，运行时通过参数或环境变量传入。
#
# 用法：
#   ./tailscale-join.sh tskey-auth-xxxxxxxx
#   # 或
#   TS_AUTHKEY=tskey-auth-xxxxxxxx ./tailscale-join.sh
#
# 可选环境变量：
#   TS_HOSTNAME      设备在 tailnet 里的名字（默认用系统 hostname）
#   TS_LOGIN_SERVER  自建 Headscale 地址，例如 https://vps:8080（默认官方 Tailscale SaaS）
#   TS_PROXY         本机出网代理，例如 http://127.0.0.1:7897
#                    给 tailscaled 直连官方控制面被墙/超时的机器用（常见于中国大陆网络，
#                    因为 tailscaled 以 root/系统服务身份运行，不会继承你终端里的代理环境变量）
set -euo pipefail

AUTHKEY="${1:-${TS_AUTHKEY:-}}"
if [ -z "$AUTHKEY" ]; then
  echo "错误：未提供 auth key。用法：./tailscale-join.sh <tskey-auth-...>  或设置 TS_AUTHKEY 环境变量" >&2
  echo "在 https://login.tailscale.com/admin/settings/keys 生成，注意选 'Auth key'（前缀 tskey-auth-），不是 API access token（tskey-api-）" >&2
  exit 1
fi

UP_ARGS=(--authkey="$AUTHKEY")
[ -n "${TS_HOSTNAME:-}" ] && UP_ARGS+=(--hostname="$TS_HOSTNAME")
[ -n "${TS_LOGIN_SERVER:-}" ] && UP_ARGS+=(--login-server="$TS_LOGIN_SERVER")

wait_for_daemon() {
  for _ in $(seq 1 15); do
    tailscale status >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "错误：等待 tailscaled 就绪超时" >&2
  exit 1
}

OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  command -v brew >/dev/null 2>&1 || { echo "错误：需要先安装 Homebrew (https://brew.sh)" >&2; exit 1; }

  if ! command -v tailscale >/dev/null 2>&1; then
    echo "→ 安装 tailscale (Homebrew) ..."
    brew install tailscale
  fi

  TAILSCALED_BIN="$(brew --prefix tailscale)/bin/tailscaled"

  if [ -n "${TS_PROXY:-}" ]; then
    echo "→ 写 LaunchDaemon（daemon 走代理 $TS_PROXY，重启后仍生效）..."
    sudo brew services stop tailscale >/dev/null 2>&1 || true
    PLIST=/Library/LaunchDaemons/com.tailscale.tailscaled.plist
    sudo tee "$PLIST" >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tailscale.tailscaled</string>
  <key>ProgramArguments</key>
  <array>
    <string>$TAILSCALED_BIN</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HTTP_PROXY</key><string>$TS_PROXY</string>
    <key>HTTPS_PROXY</key><string>$TS_PROXY</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/tailscaled.log</string>
  <key>StandardErrorPath</key><string>/tmp/tailscaled.log</string>
</dict>
</plist>
EOF
    sudo launchctl bootout system "$PLIST" >/dev/null 2>&1 || true
    sudo launchctl bootstrap system "$PLIST"
  else
    echo "→ 启动 tailscaled ..."
    sudo brew services start tailscale
  fi

elif [ "$OS" = "Linux" ]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "→ 安装 tailscale（官方脚本）..."
    curl -fsSL https://tailscale.com/install.sh | sh
  fi

  if [ -n "${TS_PROXY:-}" ]; then
    echo "→ 写 systemd drop-in（daemon 走代理 $TS_PROXY）..."
    sudo mkdir -p /etc/systemd/system/tailscaled.service.d
    printf '[Service]\nEnvironment=HTTP_PROXY=%s\nEnvironment=HTTPS_PROXY=%s\n' "$TS_PROXY" "$TS_PROXY" \
      | sudo tee /etc/systemd/system/tailscaled.service.d/proxy.conf >/dev/null
    sudo systemctl daemon-reload
  fi

  echo "→ 启动 tailscaled ..."
  sudo systemctl enable --now tailscaled

else
  echo "错误：未识别的系统 $OS，请手动安装 tailscale 并启动 tailscaled 后重跑：sudo tailscale up ${UP_ARGS[*]}" >&2
  exit 1
fi

echo "→ 等待 daemon 就绪 ..."
wait_for_daemon

echo "→ tailscale up ..."
sudo tailscale up "${UP_ARGS[@]}"

echo "→ 完成，当前状态："
tailscale status
