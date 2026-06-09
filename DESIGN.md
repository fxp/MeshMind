# MeshMind — 个人设备网格 · 分层 AI 多智能体系统

> 设计文档 v1.0 · 2026-06-08
> 工作代号 **MeshMind**（可改名）。本文是后续开发的基线，任何架构变更先改本文再动代码。

---

## 1. 一句话定义

把我名下所有设备（Mac / Linux / 树莓派 / 手机 / 服务器）接入一张私有虚拟网，
在公网部署一个**会自主推理的主 Agent**，它把目标分解后下发给每台设备上**同样会自主推理的子 Agent**，
子 Agent 在本地环境里自主完成子任务、回传结果，主 Agent 综合产出。

本质：**私有设备网格（网络层）+ 分层多智能体编排（智能层）** 两层叠加。

---

## 2. 设计原则

1. **三平面解耦**——网络 / 控制 / 执行三层各自可独立替换，互不感知实现细节。
2. **子 Agent 主动拨出**——设备永不需要入站端口，休眠/重连/换网无需任何防火墙配置。
3. **推理集中可观测**——子 Agent 的所有 LLM 调用经主 Agent 的 LLM 代理；密钥只存在 VPS，
   主 Agent 能观测/限流/计费/熔断每一次「思考」。这是把「自主 AI + 远程 shell」关进笼子的核心机制。
4. **能力而非设备**——主 Agent 按设备**声明的能力**（shell / fs / GPU / 传感器…）调度，而不是按设备名硬编码。
5. **默认最小授权**——子 Agent 工具按作用域授权（命令白名单、路径白名单、只读/可写分级），危险动作走审批门。
6. **小步可验证**——分阶段交付，每阶段都能独立跑通并验证。

---

## 3. 三平面总览

```
                        用户 (Web / CLI / 聊天)
                              │
┌─────────────────────────────────────────────────────────────┐
│  公网 VPS (Fly.io) — 控制平面                                  │
│   ┌─────────────────────────────────────────────────┐         │
│   │  主 Agent 大脑  (Claude Agent SDK, 长驻)           │         │
│   │  目标→规划→分解→调度→收集→综合 的 agentic loop      │         │
│   └───────────────┬─────────────────────┬─────────────┘         │
│         ┌─────────▼────┐  ┌──────────────▼──────────┐           │
│         │  LLM 代理     │  │ 设备注册表 + 审计 (Postgres)│         │
│         └──────────────┘  └─────────────────────────┘           │
│   ┌──────────────┐        ┌─────────────────────────┐           │
│   │  Headscale    │        │  NATS + JetStream         │         │
│   │ (网络协调面)  │        │  device.{id}.task/events  │         │
└───┴──────────────┴────────┴──────────┬──────────────────────────┘
       Tailscale 虚拟网 (设备名寻址)     │  NATS 长连接 (子 Agent 拨出)
   ┌──────────────────────┬────────────┴──────────┬───────────────┐
   ▼                      ▼                        ▼               ▼
┌────────────┐    ┌────────────┐         ┌────────────┐   ┌────────────┐
│ 子Agent(Mac)│    │子Agent(Linux)│       │子Agent(树莓派)│  │子Agent(手机) │
│ 本地agentic │    │ 本地agentic │        │ 传感器采集   │   │ 位置/状态   │
│ loop+工具   │    │ loop+GPU工具 │       │             │   │            │
└────────────┘    └────────────┘         └────────────┘   └────────────┘
```

| 平面 | 职责 | 选型 |
|---|---|---|
| 网络平面 | 让任意两台设备能稳定互相寻址（穿透 NAT） | **Tailscale + 自托管 Headscale** |
| 控制平面 | 思考、规划、调度、综合、治理 | **Claude Agent SDK + NATS + Postgres** |
| 执行平面 | 在设备本地自主执行子任务 | **Go 单文件子 Agent + 本地 agentic loop** |

---

## 4. 网络平面 — Tailscale + Headscale

**为什么不用 ZeroTier**（最初设想）而选 Tailscale：

- WireGuard 内核态加密，更快；
- **MagicDNS** 让主 Agent 用设备名（如 `mac-studio.mesh`）寻址，契合「按能力调度」；
- **ACL 即代码**——一个 HuJSON 文件表达「谁能用什么能力访问哪台设备」，可直接复用进安全模型；
- 移动端体验好，白送 `tailscale ssh` 作兜底管理通道；
- **Headscale** 把协调面自托管，跟主 Agent 同机部署，不依赖 Tailscale 公司。

> ZeroTier 仍随时可换：上层 Agent 对网络层完全无感，只依赖「能用名字/IP 访问到设备」这一抽象。

**职责边界**：网络平面**只**保证可达性。它不负责任务语义、认证授权（那是控制平面的事）。
NATS 长连接和设备间文件直传都跑在这张虚拟网上。

---

## 5. 消息平面 — NATS + JetStream

所有子 Agent 和主 Agent 都拨出连到 VPS 上的 NATS。**子 Agent 永远是客户端，不开任何入站端口。**

### Subject 设计

| Subject | 方向 | 模式 | 用途 |
|---|---|---|---|
| `device.{id}.register` | 子→主 | request-reply | 首次注册，上报能力清单 |
| `device.{id}.heartbeat` | 子→主 | pub | 心跳 + 在线状态 + 资源占用 |
| `device.{id}.task` | 主→子 | request-reply | 下发签名的子任务规格 |
| `device.{id}.events` | 子→主 | JetStream | 流式回传日志 / 进度 / 结果（持久化、可断点续传） |
| `llm.proxy.{device_id}` | 子→主 | request-reply | 子 Agent 推理请求，经主 Agent 代理到 Claude |
| `control.kill.{id}` | 主→子 | pub | kill switch，立即停掉该设备的执行/思考权 |

- **认证**：NATS nkey（每设备一对密钥），subject 级权限——设备 X 只能发自己 `device.X.*` 的 subject。
- **持久化**：`events` 走 JetStream，主 Agent 重启不丢结果；大文件产物走对象存储，消息里只带引用。

---

## 6. 控制平面 — 主 Agent 大脑

长驻在 Fly.io machine 上的 **Claude Agent SDK** 进程，跑一个 agentic loop。

### 6.1 主 Agent 的工具集

| 工具 | 说明 |
|---|---|
| `list_devices()` | 列出在线设备及其能力清单 |
| `match_capability(cap)` | 找出声明了某能力的设备 |
| `dispatch_task(device_id, spec)` | 把签名的子任务规格经 NATS 下发 |
| `collect_results(task_id)` | 从 JetStream 汇聚某任务的所有设备结果 |
| `request_approval(action)` | 危险动作 → 推给用户审批门 |
| `kill_device(device_id)` | 触发 kill switch |

### 6.2 任务生命周期

```
用户目标
  → 主 Agent 规划（Claude Opus）
  → 按能力匹配设备 + 分解出每台的子任务规格
  → 主 Agent 对规格签名
  → NATS device.{id}.task 下发
  → 子 Agent 本地自主执行（推理经 llm.proxy 回主机）
  → device.{id}.events 流式回传
  → 主 Agent 综合 → 产出交付用户
```

### 6.3 子任务规格（Task Spec）结构（草案）

```jsonc
{
  "task_id": "t_01H...",
  "goal": "列出 30 天未访问、>100MB 的文件，输出 JSON",
  "constraints": ["只读", "不得离开 /Users 和 /data"],
  "granted_capabilities": ["fs.list", "fs.stat"],   // 本次授权的工具子集
  "deadline_sec": 120,
  "signature": "ed25519:..."                          // 主 Agent 签名，子 Agent 验签
}
```

---

## 7. 执行平面 — 子 Agent

**形态**：Go 编译的**单文件静态二进制**，一份代码出全平台（macOS/Linux/Windows/arm）。
内嵌一个由主 Agent LLM 代理驱动的**本地 agentic loop**——子 Agent 自己会推理、自己决定调用哪个工具，
而不是哑执行器。

### 7.1 子 Agent 工具集（按四类场景）

| 场景 | 工具 | 安全要点 |
|---|---|---|
| 跨设备命令/脚本执行 | `shell.run(cmd)` | 命令白名单 + 作用域；危险命令触发审批门 |
| 文件同步与远程取用 | `fs.read/write/list/stat`、`file.transfer` | 路径白名单；只读/可写分级；设备间直传走 Tailscale |
| 本地资源调度 | 能力声明（GPU/软件/数据集）+ 调度器匹配 | — |
| 数据/传感器汇聚 | `sensor.read`、`metrics.push` | 推到 JetStream 时序流 |

### 7.2 能力声明（Capability Manifest）

每台设备启动时上报，主 Agent 据此调度：

```jsonc
{
  "device_id": "mac-studio",
  "os": "darwin/arm64",
  "capabilities": {
    "shell": { "allow": ["ls","stat","du","git","python3"], "deny_destructive": true },
    "fs":    { "read": ["/Users/me","/data"], "write": ["/data/out"] },
    "gpu":   { "available": false },
    "sensors": []
  }
}
```

### 7.3 本地 agentic loop 与 LLM 代理

- 子 Agent 收到 Task Spec → 启动本地 loop → 需要推理时，把上下文经 `llm.proxy.{id}` 发回主机。
- 主机的 **LLM 代理**统一调 Claude（密钥只在 VPS），并对每次调用：记录审计、按设备限流、可熔断。
- 好处：① 设备上无密钥；② 所有自主推理集中可观测；③ 一个开关停掉任意设备的「思考权」。

> 备选：低敏感/离线场景可让子 Agent 用本地小模型，不走代理（P5 再议）。

---

## 7.5 设备入网（Enrollment）— 确定版

**已定决策**：Mesh 优先（Tailscale 必选，NATS 仅绑 mesh 内网口、永不公网）+ 每设备一次性令牌。
关键技巧：一次性令牌**内嵌一把 Tailscale 一次性 auth key**，设备先入 mesh 再访问只在内网开放的
注册端点 → **零公网攻击面**（公网上只剩 Tailscale 自己的协调服务）。

### 三层 join

| 层 | 设备获得 | 凭据 |
|---|---|---|
| ① 网络层 | mesh IP + MagicDNS 名 | Tailscale auth key（令牌内嵌，一次性） |
| ② 消息层 | NATS 连接，subject 锁死 `device.<id>.*` | per-device NATS 凭证（注册端点下发） |
| ③ 智能层 | device_id + 授权能力，写入注册表 | ed25519 设备密钥对（设备本地生成，签名注册） |

### 一次性令牌（Enrollment Token）内容

```jsonc
{
  "ts_authkey": "tskey-auth-...",        // Tailscale 一次性入网 key（或 Headscale preauthkey）
  "control_addr": "ctrl.mesh:8443",       // 内网控制面注册端点
  "enroll_secret": "<single-use random>", // 一次性、TTL 有效，主 Agent 侧存哈希
  "granted_caps": ["shell", "fs"],         // 授权能力
  "name_hint": "mac-studio",
  "expires_at": "2026-06-08T11:00:00Z"
}
```

### join 流程（目标 UX：一行命令）

```
你在主 Agent:  meshmind enroll new --name mac-studio --caps shell,fs   →  打印一次性令牌

新设备:        meshmind-agent join --token <令牌>
  1. 本地生成 ed25519 密钥对（私钥永不离开设备，chmod 600）
  2. tailscale up --authkey <ts_authkey>            → 入 mesh
  3. POST control_addr/enroll {enroll_secret, pubkey, manifest}
  4. 主 Agent 校验 enroll_secret(一次性) → 返回 device_id + NATS 凭证 + 确认能力
  5. 用凭证连 NATS（subject 锁死 device.<id>.*）
  6. 上报能力清单（设备私钥签名）→ 主 Agent 用第①步 pubkey 验签 → 写入注册表
  7. 凭证落盘 ~/.meshmind/{identity.json, nats.creds, config.json}
```

之后 `meshmind-agent run` 读盘复用身份；注册消息始终带签名，主 Agent 验签防冒充。

### 设备本地持久化布局

```
~/.meshmind/
├── identity.json    # device_id + ed25519 公私钥（priv chmod 600）
├── nats.creds       # per-device NATS 凭证
└── config.json      # control_addr / nats_url / mesh 名
```

### 撤销 / Kill（网络+消息层）

`meshmind revoke <device_id>` → 作废 NATS 凭证 + 删 Tailscale/Headscale 节点 + 注册表标记 revoked。
补在运行时 `control.kill.{id}`（§8.8）之外，从网络与消息两层断开设备。

### 推荐云服务

- **网络平面**：起步用 **Tailscale 免费版**（个人 100 设备/3 用户免费，零运维）；
  要彻底去依赖再切自托管 **Headscale**（接口兼容）。
- **控制平面主机**：默认 **Hetzner CX22**（~€4/月，2vCPU/4GB）；零成本版 **Oracle Cloud 免费 ARM**；
  也可 Fly.io / DigitalOcean。主机以普通设备身份加入 tailnet，NATS 绑 tailscale 网口。

### 实现分层

| 层 | 何时做 | 与主机选择 |
|---|---|---|
| 入网仪式核心（令牌→密钥→注册端点→分配身份→签名注册→落盘） | 现在，本机可验证 | **无关** |
| NATS per-device 凭证强制（nkey/JWT 去中心化认证） | 部署层 | 相关 |
| Tailscale/Headscale auth key 签发 + `tailscale up` 接线 | 部署层 | 相关 |

---

## 8. 安全模型

「自主 AI + 远程 shell」是高危组合，安全是一等公民。

1. **网络层**：Tailscale ACL 限定谁能访问哪台设备的哪些端口。
2. **消息层**：NATS nkey + subject 级权限，设备只能发自己命名空间的消息。
3. **任务层**：Task Spec 由主 Agent **ed25519 签名**，子 Agent 验签后才执行。
4. **工具层**：子 Agent 本地强制**能力作用域**（命令白名单 / 路径白名单 / 只读分级），
   作用域同时镜像进主 Agent 的策略，双侧校验。
5. **推理层**：LLM 代理集中观测，可熔断任意设备的推理。
6. **审批门**：destructive ops / 花钱 / 对外发布 等动作，主 Agent 必须先 `request_approval` 走人工确认。
7. **审计**：每一次工具调用、每一条推理、每一个任务全量落 Postgres 审计表。
8. **Kill switch**：`control.kill.{id}` 一键停掉任意设备的执行与思考权。

---

## 9. 数据存储

| 存储 | 用途 |
|---|---|
| **Postgres** | 设备注册表、任务历史、审计日志、能力策略 |
| **NATS JetStream** | 事件 / 结果 / 传感器时序流（持久、可重放） |
| **对象存储（可选）** | 大文件产物 / 设备间传输的中转 |

---

## 10. 部署拓扑（VPS 单机起步）

公网 VPS（推荐 Fly.io machine，长驻）上跑：

- **Headscale** — 网络协调面
- **NATS server + JetStream** — 消息中枢
- **主 Agent 大脑** — Claude Agent SDK 长驻进程
- **LLM 代理** — 子 Agent 推理统一入口
- **Postgres** — 注册表 / 审计
- **Web 仪表盘 + API + Auth** — 用户界面（Auth/UI 可拆到 Vercel，编排核心留 VPS）

设备侧只需：装 Tailscale 客户端 + 跑 Go 子 Agent 二进制。

---

## 11. 技术栈一览

| 层 | 选型 |
|---|---|
| 网络 | Tailscale 客户端 + 自托管 Headscale |
| 消息 | NATS + JetStream（nkey 认证） |
| 主 Agent | Claude Agent SDK（TypeScript/Node 优先），长驻 Fly.io |
| 子 Agent | Go 单文件二进制 + 内嵌本地 agentic loop |
| 存储 | Postgres + JetStream + 可选对象存储 |
| 界面 | Web 仪表盘（Next.js）+ CLI |
| 签名 | ed25519 |

---

## 12. 分阶段落地路线

每阶段都能独立验证后再进入下一阶段。

| 阶段 | 目标 | 验证标准 |
|---|---|---|
| **P0 骨架** | Headscale 起、2 台设备入网、NATS 起、Go 子 Agent 注册+心跳+回显 | 主机能看到设备在线 + 能力清单 |
| **P1 远程执行**（无 AI） | 主 Agent 把一条 shell 任务下发到某设备并拿回结果 | 端到端 RPC 跑通 |
| **P2 主 Agent 大脑** | 接 Claude Agent SDK，自然语言目标 → 规划 → 多设备调度 → 综合 | 一句话目标产出跨设备报告 |
| **P3 子 Agent 本地智能体** | 子 Agent 跑自己的 agentic loop，推理经 LLM 代理，工具按能力作用域 | 「分层多智能体」真正成立 |
| **P4 安全治理** | 能力策略 + ACL、审计、审批门、kill switch | 危险动作被拦 + 可熔断 |
| **P5 高级能力** | 设备间文件直传、传感器时序汇聚、能力调度器 | 四类场景全打通 |

---

## 13. 待定 / 风险

- 子 Agent 本地 loop 用 Claude headless 还是自研轻量 loop？（P3 决策）
- 移动端（iOS/Android）子 Agent 形态——原生 app 还是受限后台？（P5）
- 多用户 / 团队共享？当前设计假设单一所有者。
- LLM 代理的成本与速率——大量设备并发推理时的预算护栏。
- 离线/弱网设备的任务排队与最终一致性（JetStream 已部分覆盖）。

---

## 附录 A — 仓库结构（规划）

```
meshmind/
├── DESIGN.md                  # 本文档
├── README.md
├── infra/                     # Headscale / NATS / Postgres 部署脚本 (Fly.io / docker-compose)
├── master/                    # 主 Agent 大脑 (Claude Agent SDK, TS)
│   ├── orchestrator/          # 规划/调度/综合
│   ├── llm-proxy/             # 子 Agent 推理代理
│   ├── registry/              # 设备注册表 + 审计
│   └── api/                   # Web/CLI API
├── agent/                     # 子 Agent (Go 单文件)
│   ├── cmd/                   # main
│   ├── transport/            # NATS 客户端
│   ├── tools/                 # shell / fs / sensor / transfer
│   └── capability/            # 能力声明 + 作用域强制
├── proto/                     # Task Spec / 消息 schema (共享)
└── dashboard/                 # Web 仪表盘 (Next.js)
```
