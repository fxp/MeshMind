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
npx wrangler deploy                                   # 部署 Worker + Hub DO
echo "<强随机串>" | npx wrangler secret put ADMIN_TOKEN  # 设管理令牌
```
部署后 `enroll_url` / `ws_url` 自动变成你的 `*.workers.dev`（或自定义域）。

**当前线上**：`https://meshmind-hub.fxp007.workers.dev`

### 自定义域名（绕开 workers.dev 被墙）

`wrangler.jsonc` 已加 `routes: [{pattern:"hub.xiaopingfeng.com", custom_domain:true}]`。
重新 `npx wrangler deploy`，CF 自动建 DNS + 边缘证书。之后用自定义域名签发/入网：

```bash
ADMIN=<你的 ADMIN_TOKEN>; HUB=https://hub.xiaopingfeng.com
ENC=$(curl -s -H "authorization: Bearer $ADMIN" -X POST $HUB/admin/enroll/new \
      -d '{"name":"box","caps":["shell","fs"]}' | python3 -c "import sys,json;print(json.load(sys.stdin)['encoded'])")
./meshmind-agent join --token "$ENC" --server "$HUB"   # ws_url 自动变成 hub.xiaopingfeng.com
./meshmind-agent run
```

被墙时换地址无需重签令牌：`run --ws wss://<可达域>/agent/<id>` 或 `MESHMIND_WS_URL` 环境变量。

真机入网（任意机器）：
```bash
cd agent && go build -o meshmind-agent .
ENC=$(curl -s -H "authorization: Bearer $ADMIN_TOKEN" -X POST \
      https://meshmind-hub.fxp007.workers.dev/admin/enroll/new \
      -d '{"name":"my-box","caps":["shell","fs"]}' \
      | python3 -c "import sys,json;print(json.load(sys.stdin)['encoded'])")
./meshmind-agent join --token "$ENC" && ./meshmind-agent run
```

## HTTP / WS 接口

| 路由 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | 健康检查 |
| `/admin/enroll/new` | POST | 签发一次性令牌 `{name, caps}` |
| `/enroll` | POST | 设备兑换令牌 `{enroll_secret, public_key, manifest}` |
| `/agent/<id>` | WS | 设备长连接（`?token=<bearer>`） |
| `/devices` | GET | 在线设备 + 能力 |
| `/goal` | POST | 编排目标 `{goal}` → 并行下发 + 汇聚 |
| `/admin/prune` | POST | 清理离线设备记录 |
| `/.well-known/agent-card.json` | GET | A2A 聚合 Agent Card（公开，仅在线设备） |
| `/a2a/<device>/.well-known/agent-card.json` | GET | A2A 单设备 Agent Card（公开发现） |
| `/a2a/<device>` | POST | A2A JSON-RPC `message/send`（需 admin token），`metadata.skillId` 选 skill |

### A2A（Agent2Agent）

Hub 当 A2A 网关：每台设备的能力自动映射成 A2A skill（`llm.available`→`llm-inference`，
shell→`shell-exec`），外部任意 A2A 客户端可发现并调用。示例（调本地推理）：

```bash
curl -s -H "authorization: Bearer $ADMIN" -X POST https://hub.xiaopingfeng.com/a2a/glm-office-2 -d '{
  "jsonrpc":"2.0","id":"1","method":"message/send",
  "params":{"message":{"role":"user","parts":[{"kind":"text","text":"你好"}]},
            "metadata":{"skillId":"llm-inference"}}}'
```
