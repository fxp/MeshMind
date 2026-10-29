# MeshMind 日志与可观测性

生产环境使用 **Cloudflare Workers Logs** 保存结构化系统日志。Worker 请求日志、运行异常、Hub 网关会话和本地设备执行事件都进入 `meshmind-saas` 的 Observability 日志；面向设备所有者的授权与操作记录仍保存在 MeshMind 审计表中。

## 查看日志

在 Cloudflare Dashboard 中打开 **Workers & Pages → meshmind-saas → Observability → Logs**。常用结构化字段：

| 字段 | 用途 |
|---|---|
| `service` | Cloudflare 中为 `meshmind-edge` 或 `meshmind-hub`；本机终端日志为 `meshmind-local` |
| `component` | `http`、`gateway`、`local-gateway` 或 `device` |
| `event` | 稳定事件名，例如 `request.completed`、`connection.verified`、`task.result` |
| `level` | `info`、`warn` 或 `error` |
| `requestId` | Cloudflare Ray ID，可关联一次边缘请求 |
| `gatewayId`、`taskId` | 关联网关会话和设备任务；不包含本地设备序列号 |
| `status`、`durationMs`、`outcome` | HTTP 或设备操作结果 |

本地实时排障可以使用：

```bash
cd saas
npm run cf:logs
```

历史保留时间、查询额度与费用由当前 Cloudflare 套餐决定。需要长期归档时，应在 Cloudflare 中配置受控的日志导出目标，而不是让设备直接持有存储凭据。

## 记录范围

- 边缘请求：方法、归一化路由、状态码、耗时和 Ray ID。
- Hub：网关认证、连接、验签、断开、帧拒绝和任务分发结果。
- 本地网关：连接就绪、停止、设备任务开始、完成、拒绝或失败。
- 本地 HTTP 服务：请求结果写入运行该服务的终端；未连接 Cloudflare 时产生的本机日志不会上传。
- Cloudflare 运行时：应用主动输出的结构化日志、未捕获异常和启用采样的 Traces。自动 Invocation Logs 保持关闭，避免平台自动记录带 OAuth 参数的完整请求地址。

本地网关日志只能通过已验签的网关 WebSocket 上报，使用固定事件和字段 schema，并限制为每分钟 120 条。网关不能向 Cloudflare 日志写入任意文本。

## 隐私边界

系统日志使用字段白名单，不记录：

- Google OAuth 密钥、访问凭证、Cookie、Authorization 请求头或 enrollment 文件；
- 拓竹访问码、Home Assistant token、网关私钥或设备原始报文；
- ADB 页面内容、输入文本、局域网地址、查询参数或请求体；
- 任意异常消息和设备 stderr。异常只记录受限的错误类型与安全错误码。

设备所有者需要查看“谁访问了哪台设备、请求了什么能力”时，应使用网页中的“访问记录”和“操作记录”；Cloudflare 日志用于平台运行与故障排查。
