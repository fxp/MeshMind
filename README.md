# MeshMind

[官网](https://mesh.xiaopingfeng.com/) · [GitHub 源代码](https://github.com/fxp/MeshMind) · [MIT License](./LICENSE)

MeshMind 是一个开源的设备接入平台。源代码可以自由使用、修改和分发；部署者需要自行保护 OAuth 密钥、设备凭据和网关身份。

**当前方向：v3 设备接入 SaaS。** 线上入口：[mesh.xiaopingfeng.com](https://mesh.xiaopingfeng.com/)。让不同网络中的设备通过本地网关接入，由所有者把指定设备的能力授权给用户和 Agent。展示场景包括 **内网拓竹 X1 Carbon → Codex MCP**、**本机 ADB → Codex MCP**，以及通过 MeshMind Connect for Mac 接入任意 USB 串口和局域网 HTTP 设备。

Agent 可通过 MCP、[独立 JSON CLI 与版本化 HTTP API](https://mesh.xiaopingfeng.com/docs/agent-api) 访问获授权的设备。

当前可运行版本在 **[saas/](./saas/README.md)**，支持独立设备空间、网关一次性入网、连接挑战验签、设备发现、短期共享凭证、状态读取、控制审批、撤销和审计。X1C LAN 密钥与 ADB 设备序列号留在本地网关。公网 Hub 地址可配置，不依赖 Tailscale 或 Cloudflare 才能运行。

```bash
cd saas
npm ci
npm start
# 打开 http://localhost:8788，创建账号，然后按页面接入模拟 X1C、真实 X1C 或本机 ADB。
```

容器运行：

```bash
docker compose -f saas/compose.local.yml up --build -d
```

完整演示、Mac 程序、X1C / ADB 本地配置、Codex 接入、容器部署及当前限制见 [saas/README.md](./saas/README.md)。架构见 [docs/SAAS-ARCHITECTURE.md](./docs/SAAS-ARCHITECTURE.md)。

生产环境的结构化系统日志保存在 Cloudflare Workers Logs。记录范围、查询方式与隐私边界见 [日志与可观测性](./docs/OBSERVABILITY.md)。

**交付状态：本地／容器 MVP 与 Apple Silicon Mac 开发版，已部署 Cloudflare 公网试用版。** 模拟流程有自动化集成测试；本机 ADB 已通过真实设备状态与界面结构读取验证，Home Assistant 通过模拟服务集成测试，ESP32 串口仍需实物联调。公开 Mac 下载会在 Developer ID 签名和 Apple 公证完成后恢复。真实 X1C 仍需按设备固件与证书联调。当前按设备能力接入，通用 TCP/UDP 组网、虚拟 IP 和远程桌面还没有实现。

| 目录 | 当前定位 |
|---|---|
| `saas/` | v3 当前入口：多租户 Hub、管理页面、地点网关、X1C／模拟器／ADB／ESP32／Home Assistant、MCP、Mac 程序 |
| `docs/SAAS-ARCHITECTURE.md` | v3 架构、安全边界与后续演进 |
| `cloudflare/` | v2 单所有者 Cloudflare Hub，历史原型，尚未迁移为 SaaS |
| `agent/`、`master/`、`infra/` | v1/v2 Go Agent、NATS 和网络实验，历史参考 |

<details>
<summary>v1 / v2 历史说明（原型记录，不作为 SaaS 部署指南）</summary>

个人设备网格 · 分层 AI 多智能体系统。

把名下所有设备接入一个**会自主推理的主 Agent**，它把目标分解后下发给每台设备上的
**子 Agent**，子 Agent 在本地自主完成子任务并回传，主 Agent 综合产出。

**v2.0 架构（当前）**：控制平面跑在 **Cloudflare 边缘**（Worker + Durable Object + WebSocket），
除模型推理走 **BigModel(GLM)** 外，连接中枢/队列/存储/编排全在 Cloudflare —— 零运维、永远在线、无 VPS。
完整架构见 [DESIGN.md §0](./DESIGN.md)；Hub 见 [cloudflare/](./cloudflare/)。

> v1.0 的 NATS + Tailscale(Mesh 优先) 方案仍保留在 `infra/` + `master/`，可作本地/离线备选。

## 快速开始（Cloudflare 版，推荐）

```bash
cd cloudflare && npm install && npm run dev    # 本地起 Hub（workerd），无需 CF 账号

# 真实设备经 CF 入网（另开终端）
cd agent && go build -o meshmind-agent .
ENC=$(curl -s -X POST localhost:8787/admin/enroll/new -d '{"name":"box","caps":["shell","fs"]}' \
      | python3 -c "import sys,json;print(json.load(sys.stdin)['encoded'])")
./meshmind-agent join --token "$ENC" && ./meshmind-agent run &

curl localhost:8787/devices                              # 看在线设备
curl -X POST localhost:8787/goal -d '{"goal":"shell-all uname -a"}'   # 经 CF 多设备下发
```

详见 [cloudflare/README.md](./cloudflare/README.md)。

## 快速开始（v1.0 NATS 版，本地/离线备选）

```bash
make nats                 # 1. 生成本地随机凭证并启动只监听回环地址的 NATS
make master               # 2. 主 Agent 监听器（终端 A）
make agent                # 3. 子 Agent，device_id=本机 hostname（终端 B）
make agent2               #    再起一台 device_id=linux-box

# 4. 给设备发任务（终端 C）
cd master
set -a; . ../infra/.env; set +a
export NATS_URL=nats://127.0.0.1:4222
npm run task -- mac-studio echo "hello mesh"
npm run task -- linux-box shell -- ls /tmp
npm run task -- mac-studio shell -- rm -rf /x   # 会被安全作用域拒绝

# 5. 编排目标（主 Agent 多设备并行调度 + 结果汇聚）
npm run goal -- shell-all uname -a
npm run goal -- echo-all "mesh roll call"
```

主 Agent 终端每 5 秒打印在线设备表（🟢/🟡/🔴 + 能力清单）。

## 设备入网（Enrollment，本机联调）

```bash
# 在主 Agent 上签发一次性令牌
cd master
set -a; . ../infra/.env; set +a
export NATS_URL=nats://127.0.0.1:4222
npm run enroll -- new --name mac-studio --caps shell,fs
# → 打印 meshmind-agent join --token <...>

# 在目标设备上入网（本机联调加 --skip-network 跳过 tailscale）
go build -o meshmind-agent ./agent
./meshmind-agent join --token <令牌> --skip-network   # 生成密钥 → 注册 → 落盘 ~/.meshmind/
./meshmind-agent run                                  # 加载身份 → 签名注册 → 上线
```

入网设计见 [DESIGN.md §7.5](./DESIGN.md)；真实跨设备部署见 [infra/DEPLOY.md](./infra/DEPLOY.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `infra/` | NATS / Postgres 部署；`headscale/` 远程网络层配置 |
| `proto/` | 主/子 Agent 共享的消息 schema |
| `agent/` | 子 Agent（Go 单文件二进制 + 能力作用域强制） |
| `master/` | 主 Agent（TS）：注册表、监听器、任务下发 |

## 状态

- [x] 架构设计 v2.0（Cloudflare 边缘 + BigModel 推理）
- [x] **Cloudflare Hub**：Worker + Hub Durable Object（WS Hibernation）+ 入网 + 注册表 + 规则编排 + 离线信箱
  - [x] 管理面鉴权：`/admin` `/goal` `/devices` 需 admin token
  - [x] **已部署上线**：自定义域名 `https://hub.xiaopingfeng.com`（绕开 workers.dev 被墙）+ 回退 `meshmind-hub.fxp007.workers.dev`
  - [x] 自动部署：`make deploy` / `bash cloudflare/scripts/deploy.sh`（认证存 `cloudflare/.deploy.env`）
- [ ] P2.5 GLM 规划器（BigModel，听懂自然语言目标）
- [ ] P3 子 Agent 本地 agentic loop（DO + alarm 分步驱动）
- [x] 架构设计（DESIGN.md v1.0，已被 v2.0 取代部分）
- [x] **P0 骨架**：NATS + Go 子 Agent 注册/心跳 + TS 主机在线设备表（2 设备验证通过）
- [x] **P1 远程执行**：echo / shell.run 端到端 RPC + 能力作用域强制（白名单/破坏性命令拦截）
- [x] **P2 编排骨架**：可插拔 Planner + 规则规划器 + 多设备并行调度 + 结果汇聚（`control.goal`）
  - [ ] P2.5 接 GLM 规划器（BigModel），让主 Agent 听懂自然语言目标
- [ ] P3 子 Agent 本地智能体（本地 agentic loop + LLM 代理）
- [x] **入网仪式**：一次性令牌 + ed25519 设备身份 + 注册端点 + 签名注册（本机端到端验证：签名注册/令牌一次性/防冒充全通过）
  - [ ] 部署层：Tailscale auth key 签发 + NATS per-device 凭证（见 infra/DEPLOY.md）
- [ ] P4 安全治理（ACL、审批门、审计、kill switch）
- [ ] P5 高级能力（设备间直传、传感器汇聚、能力调度器）

> 注：本机当前无 `docker compose` 插件，故用 `docker run`（见 Makefile）。
> 有 compose 时先运行 `./infra/init-local-env.sh`，再执行 `docker compose --env-file infra/.env -f infra/docker-compose.yml up -d`。NATS、监控端口和 PostgreSQL 均只监听 `127.0.0.1`。

</details>
