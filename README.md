# MeshMind

个人设备网格 · 分层 AI 多智能体系统。

把名下所有设备接入一张私有虚拟网（Tailscale/Headscale），公网部署一个会自主推理的
**主 Agent**，它把目标分解后下发给每台设备上的**子 Agent**，子 Agent 在本地自主完成
子任务并回传，主 Agent 综合产出。

完整架构见 [DESIGN.md](./DESIGN.md)。消息格式见 [proto/messages.md](./proto/messages.md)。

## 快速开始（本机验证 P0/P1）

```bash
make nats                 # 1. 启动 NATS（需要 Docker）
make master               # 2. 主 Agent 监听器（终端 A）
make agent                # 3. 子 Agent，device_id=本机 hostname（终端 B）
make agent2               #    再起一台 device_id=linux-box

# 4. 给设备发任务（终端 C）
cd master
npm run task -- mac-studio echo "hello mesh"
npm run task -- linux-box shell -- ls /tmp
npm run task -- mac-studio shell -- rm -rf /x   # 会被安全作用域拒绝

# 5. 编排目标（主 Agent 多设备并行调度 + 结果汇聚）
npm run goal -- shell-all uname -a
npm run goal -- echo-all "mesh roll call"
```

主 Agent 终端每 5 秒打印在线设备表（🟢/🟡/🔴 + 能力清单）。

## 目录

| 路径 | 内容 |
|---|---|
| `infra/` | NATS / Postgres 部署；`headscale/` 远程网络层配置 |
| `proto/` | 主/子 Agent 共享的消息 schema |
| `agent/` | 子 Agent（Go 单文件二进制 + 能力作用域强制） |
| `master/` | 主 Agent（TS）：注册表、监听器、任务下发 |

## 状态

- [x] 架构设计（DESIGN.md v1.0）
- [x] **P0 骨架**：NATS + Go 子 Agent 注册/心跳 + TS 主机在线设备表（2 设备验证通过）
- [x] **P1 远程执行**：echo / shell.run 端到端 RPC + 能力作用域强制（白名单/破坏性命令拦截）
- [x] **P2 编排骨架**：可插拔 Planner + 规则规划器 + 多设备并行调度 + 结果汇聚（`control.goal`）
  - [ ] P2.5 接 GLM 规划器（BigModel），让主 Agent 听懂自然语言目标
- [ ] P3 子 Agent 本地智能体（本地 agentic loop + LLM 代理）
- [ ] P4 安全治理（签名、ACL、审批门、审计、kill switch）
- [ ] P5 高级能力（设备间直传、传感器汇聚、能力调度器）

> 注：本机当前无 `docker compose` 插件，故用 `docker run`（见 Makefile）。
> 有 compose 时可改用 `infra/docker-compose.yml`。
