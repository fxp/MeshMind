# MeshMind — 个人设备网格 · 分层 AI 多智能体系统

> 设计文档 v2.0 · 2026-06-09
> 工作代号 **MeshMind**（可改名）。本文是后续开发的基线，任何架构变更先改本文再动代码。
>
> **v2.0 重大转向**：控制平面迁到 **Cloudflare 边缘**（Worker + Durable Object + WS），
> 除模型推理走 **BigModel(GLM)** 外，连接中枢/队列/存储/编排全部跑在 Cloudflare 上。
> 这取代了 v1.0 的「VPS + NATS + Tailscale(Mesh 优先)」控制平面方案 —— 详见 §0。
> v1.0 的 §4/§5/§7.5/§10（Tailscale/NATS/入网部署层）降级为**可选/历史参考**；
> 入网仪式的**核心**（一次性令牌 + ed25519 身份 + 签名注册）传输无关，**继续有效**。

---

## 1. 一句话定义

把我名下所有设备（Mac / Linux / 树莓派 / 手机 / 服务器）接入一张私有虚拟网，
在公网部署一个**会自主推理的主 Agent**，它把目标分解后下发给每台设备上**同样会自主推理的子 Agent**，
子 Agent 在本地环境里自主完成子任务、回传结果，主 Agent 综合产出。

本质：**分层多智能体编排** + **Cloudflare 边缘做永远在线的连接/队列/存储中枢**。

---

## 0. 控制平面（v2.0 确定版）— Cloudflare 边缘

**决策**：除模型推理走 BigModel(GLM) 外，其余尽量跑在 Cloudflare 上。换掉 v1.0 的 VPS+NATS+Tailscale。
**收益**：零运维、零自维护服务器、永远在线、全球边缘、按量计费近乎免费（个人规模）。

```
设备 (Go 子 Agent, WebSocket 客户端)
   ║ wss://ctrl.<domain>/agent/<id>   (TLS + per-device bearer token 鉴权)
   ▼
┌──────────────────────── Cloudflare 边缘 ────────────────────────┐
│  Worker (路由)                                                   │
│   /enroll(POST)  /agent/<id>(WS)  /goal(POST)  /admin/enroll/new │
│        │ forward                                                 │
│  ┌─────▼────────────────── Hub Durable Object ────────────────┐  │
│  │ • 持有所有设备 WS 连接（Hibernation API，空闲不计费）        │  │
│  │ • 设备注册表 + 能力清单（DO SQLite storage）                │  │
│  │ • 编排：规划→并行下发→结果汇聚（规则规划器/GLM 规划器）      │  │
│  │ • 离线信箱：设备不在线则存任务，重连/alarm 唤醒再投递        │  │
│  │ • 一次性令牌 + 设备公钥登记 + ed25519 验签                   │  │
│  └─────┬──────────────────────────────────────────────────────┘  │
│  D1(注册表/审计持久化)  KV(令牌)  R2(大文件/产物)                  │
└────────┼─────────────────────────────────────────────────────────┘
         │ fetch 出站
         ▼
   BigModel (GLM) — 仅模型推理
```

### 组件映射

| 角色 | Cloudflare 原语 |
|---|---|
| 设备长连接中枢（替代 NATS） | **Durable Object + WebSocket Hibernation** |
| 离线设备任务排队 | **DO storage 信箱**（或 Cloudflare Queues），DO **alarm** 做超时/重投 |
| 注册表 / 审计 | **DO SQLite storage**（量大再迁 **D1**） |
| 一次性令牌 / per-device bearer | **DO storage**（或 **KV**） |
| 大文件 / 产物中转 | **R2** |
| 注册端点 / 路由 | **Worker** 路由 |
| LLM 推理 | Worker `fetch` → **BigModel(GLM)** |

### 与 v1.0 的差异

| 维度 | v1.0 | v2.0（本版） |
|---|---|---|
| 传输 | NATS（设备拨出长连） | **WebSocket → Durable Object** |
| 设备鉴权 | NATS nkey/JWT 凭证 | **per-device bearer token**（enroll 下发）+ ed25519 签名注册 |
| 网络 | Tailscale Mesh 优先、零公网面 | **CF 公网边缘**（TLS+token+CF WAF/DDoS）；Tailscale 降级为 P5 设备间直传可选 |
| 常驻主机 | VPS / 家用机 | **无**（Cloudflare 托管） |
| 编排器宿主 | VPS 长驻进程 | **Hub Durable Object** |
| 重型自主 loop | 长驻进程随便跑 | **DO + alarm 分步驱动**（CPU 时间受限，P3 注意） |

### 不变的部分（v1.0 资产保留）

入网仪式核心（一次性令牌、ed25519 设备身份、签名注册防冒充）、能力模型与作用域强制、
Task Spec、规则规划器、可插拔 Planner 接口 —— 全部传输无关，直接复用。
只把「NATS 凭证」换成「WSS bearer token」，「ed25519 验签」用 Workers 的 WebCrypto 实现。

### 设备入网（CF 版）

```
你:   POST /admin/enroll/new {name, caps}              → 一次性令牌(含 enroll_url)
设备: meshmind-agent join --token <令牌>
      1. 本地生成 ed25519 密钥对
      2. POST enroll_url {enroll_secret, pubkey, manifest}
         ← {device_id, ws_url, bearer, granted_caps}
      3. 落盘 ~/.meshmind/
设备: meshmind-agent run
      → wss 连 ws_url（带 bearer）→ 发签名注册 → Hub 验签 → 心跳/任务
```

### 协议（WS 帧，JSON）

| kind | 方向 | 说明 |
|---|---|---|
| `register` | 设备→Hub | `{manifest_json, sig}`，Hub 验签后登记 |
| `heartbeat` | 设备→Hub | `{ts, load}` |
| `task` | Hub→设备 | `{task_id, type, payload, granted_capabilities, deadline_sec}` |
| `result` | 设备→Hub | `{task_id, ok, result, error, took_ms}` |
| `kill` | Hub→设备 | 停止执行/思考权 |

### 可达性 / 被墙网络（中国大陆）

`*.workers.dev` 在中国大陆常被 SNI 阻断、公司防火墙也常拉黑。CF 公网路线的主要软肋就是
「设备→Hub 这一跳的域名可能不可达」（这是 v1 Tailscale Mesh 能规避的——它有自带中继）。

**主解法：自定义域名（零代码改动）。** 被挡的是 `workers.dev` 这个域名，不是整个 CF 边缘。
绑一个自有域名（`hub.xiaopingfeng.com`，须在本 CF 账号）即可绕开。Hub 的 `enroll_url`/`ws_url`
从请求 Host 头派生，故**只要用该域名签发/入网，设备全程走该域名**，无需改码。
配置：`wrangler.jsonc` 的 `routes` 已加 `{pattern:"hub.xiaopingfeng.com", custom_domain:true}`，
`wrangler deploy` 时 CF 自动建 DNS + 边缘证书。

**设备侧灵活性**：Go 子 Agent 支持覆盖，换域名/加兜底无需重新签发令牌：
- `join --server https://hub.xiaopingfeng.com`（覆盖注册端点）
- `run --ws wss://hub.xiaopingfeng.com/agent/<id>` 或 `MESHMIND_WS_URL` 环境变量

**仍不稳时的兜底阶梯**（v1 代码均保留）：
| 兜底 | 做法 | 代价 |
|---|---|---|
| 小中转 | 设备够得着处（港/新 VPS、域内 VPS、同 LAN 机器）反代/CF Tunnel 转发到 Worker | 多一个极小盒子 |
| Mesh 混合 | 被挡网络里的设备走 v1 Tailscale（中继通常可达），其余走 CF | 多传输并存 |
| 自托管 | 这些设备连 v1 NATS/master（域内 VPS/家用机），完全不碰 CF | 维护一个常驻节点 |

> BigModel（`open.bigmodel.cn`）在国内，CF 边缘出站可正常访问；问题只在「设备→Hub」一跳。

---

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
