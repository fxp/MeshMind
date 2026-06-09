# 部署层 — 把入网从「本机联调」升到「真实跨设备」

入网仪式的核心逻辑（令牌→密钥→注册端点→分配身份→签名注册→落盘）已与主机无关地实现并验证。
本文是选定主机后要补的**部署层**三件事。决策已定：Mesh 优先 + 每设备一次性令牌。

推荐：**Tailscale 免费版 + Hetzner CX22**（零成本版：Tailscale 免费版 + Oracle 免费 ARM）。

## ① 网络平面：Tailscale（或 Headscale）

### A. Tailscale 免费版（推荐起步，零运维）

1. 注册 Tailscale，建一个 tailnet。
2. 主机（VPS）和每台设备装客户端：`curl -fsSL https://tailscale.com/install.sh | sh`
3. 主 Agent 需要能**程序化签发一次性 auth key**——创建一个 OAuth client（Settings → OAuth），
   授予 `auth_keys` 写权限，把 client id/secret 配给主 Agent：

   ```bash
   # 主 Agent 用 Tailscale API 为每次 enroll 现签一把一次性 key
   POST https://api.tailscale.com/api/v2/tailnet/-/keys
   { "capabilities": { "devices": { "create": { "reusable": false, "ephemeral": false } } },
     "expirySeconds": 3600 }
   ```

   把返回的 key 通过 `enroll new --ts-authkey <key>` 注入令牌。

### B. 自托管 Headscale（彻底去依赖）

见 `infra/headscale/README.md`。签发预授权 key：
`headscale preauthkeys create --user mesh --expiration 1h`，同样注入令牌。

## ② 消息平面：NATS 绑 mesh 内网口 + per-device 凭证

1. **只绑 tailscale 网口**（永不公网）。NATS 配置：

   ```conf
   # nats.conf
   host: "100.x.x.x"        # 主机的 tailscale IP（或用 MagicDNS 名解析）
   port: 4222
   jetstream { store_dir: "/data" }
   # 去中心化 JWT 认证：每设备一个 user，subject 锁死 device.<id>.>
   ```

2. **per-device 凭证**：用 `nsc` 建 operator/account，enroll 时为每设备签一个 user JWT，
   权限限定 `publish: device.<id>.>` + `subscribe: device.<id>.>, _INBOX.>`。
   注册端点把生成的 `.creds` 随响应下发，设备存到 `~/.meshmind/nats.creds`，
   `run` 时 `nats.Connect(url, nats.UserCredentials(path))`。

   > 当前代码：注册端点已下发 `nats_url`，creds 字段留待此处接入。
   > 主机侧 `PUBLIC_NATS_URL` 设为 `nats://ctrl.mesh:4222`（MagicDNS 名）。

## ③ 注册端点：放内网 + TLS

- 主 Agent 的 `/enroll`（默认 :7700）部署时**绑 tailscale 网口**，设备先入 mesh 再访问。
- `enroll new` 令牌里的 `control_addr` 设为 `ctrl.mesh:7700`。
- 设备 `join` 默认走 https：去掉 `--skip-network`，加 `--https`（端点配 TLS，或前置 Caddy 自动证书）。

## 主机环境变量一览（主 Agent）

```bash
NATS_URL=nats://ctrl.mesh:4222          # 主 Agent 自己连 NATS
PUBLIC_NATS_URL=nats://ctrl.mesh:4222   # 下发给设备
CONTROL_ADDR=ctrl.mesh:7700             # 写进令牌
MESH_NAME=ctrl.mesh
ENROLL_PORT=7700
# Tailscale OAuth（用于现签 auth key）
TS_OAUTH_CLIENT_ID=...
TS_OAUTH_CLIENT_SECRET=...
```

## 验收

异地一台新设备上，仅一行：

```bash
meshmind-agent join --token <主 Agent 签发的令牌>
```

应自动：入 mesh → 拿 NATS 凭证 → 签名注册 → 出现在主 Agent 在线设备表。
