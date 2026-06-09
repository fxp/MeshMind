# MeshMind Hub — Cloudflare 控制平面

除模型推理走 BigModel(GLM) 外，连接中枢/队列/存储/编排全部跑在 Cloudflare。
架构见 [../DESIGN.md §0](../DESIGN.md)。

## 组成

| 文件 | 角色 |
|---|---|
| `src/worker.ts` | Worker 入口，转发到单个 Hub DO |
| `src/hub.ts` | **Hub Durable Object**：WS 连接(Hibernation)、注册表、入网、编排、离线信箱、验签 |
| `src/crypto.ts` | ed25519 验签（WebCrypto）+ 随机令牌 |
| `src/planner.ts` | 规则规划器（可插拔，GLM 版将来实现同接口） |

## 鉴权

| 路由 | 鉴权 |
|---|---|
| `/health` | 公开 |
| `/enroll` | 一次性 `enroll_secret` 自鉴权 |
| `/agent/<id>` (WS) | per-device `bearer` |
| `/admin/* `·`/goal`·`/devices` | **admin token**（`Authorization: Bearer <ADMIN_TOKEN>`） |

- 本地：`ADMIN_TOKEN` 放 `.dev.vars`（见 `.dev.vars.example`，wrangler dev 自动加载）。
- 线上：`npx wrangler secret put ADMIN_TOKEN`。
- 未配置 `ADMIN_TOKEN` 时，所有管理操作一律拒绝（安全默认）。

## 本地开发（无需 CF 账号）

```bash
cd cloudflare && npm install
cp .dev.vars.example .dev.vars   # 改成你的随机串
npm run dev                      # wrangler dev → http://localhost:8787

# 模拟一台设备（另开终端，会用 .dev.vars 里的 ADMIN_TOKEN 签发令牌）
ADMIN_TOKEN=local-dev-admin-secret-change-me node test/client.mjs

# 管理操作需带 admin token
A='-H "authorization: Bearer local-dev-admin-secret-change-me"'
curl $A -X POST localhost:8787/admin/enroll/new -d '{"name":"box","caps":["shell","fs"]}'
curl $A localhost:8787/devices
curl $A -X POST localhost:8787/goal -d '{"goal":"shell-all uname -a"}'
```

## 真实设备（Go 子 Agent 经 CF 入网）

```bash
cd agent && go build -o meshmind-agent .
# 用 /admin/enroll/new 返回的 encoded 令牌：
./meshmind-agent join --token <encoded>   # CF 令牌无 ts_authkey，自动跳过 tailscale
./meshmind-agent run                       # 走 WebSocket 连 Hub
```

## 部署到 Cloudflare

```bash
npm run deploy        # wrangler deploy（需 cloudflare 账号 + wrangler login）
```
部署后 `enroll_url` / `ws_url` 自动变成你的 `*.workers.dev`（或自定义域）。

## HTTP / WS 接口

| 路由 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | 健康检查 |
| `/admin/enroll/new` | POST | 签发一次性令牌 `{name, caps}` |
| `/enroll` | POST | 设备兑换令牌 `{enroll_secret, public_key, manifest}` |
| `/agent/<id>` | WS | 设备长连接（`?token=<bearer>`） |
| `/devices` | GET | 在线设备 + 能力 |
| `/goal` | POST | 编排目标 `{goal}` → 并行下发 + 汇聚 |
