# MeshMind

个人设备网格 · 分层 AI 多智能体系统。

把名下所有设备接入一张私有虚拟网（Tailscale/Headscale），公网部署一个会自主推理的
**主 Agent**，它把目标分解后下发给每台设备上的**子 Agent**，子 Agent 在本地自主完成
子任务并回传，主 Agent 综合产出。

完整架构见 [DESIGN.md](./DESIGN.md)。

## 状态

- [x] 架构设计（DESIGN.md v1.0）
- [ ] P0 骨架：Headscale + NATS + Go 子 Agent 注册/心跳
- [ ] P1 远程执行
- [ ] P2 主 Agent 大脑
- [ ] P3 子 Agent 本地智能体
- [ ] P4 安全治理
- [ ] P5 高级能力
