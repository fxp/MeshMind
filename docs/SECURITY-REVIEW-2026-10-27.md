# MeshMind 安全检查 · 2026-10-27

范围：Cloudflare 公网站点、Node Hub、Google OIDC、共享凭证、Agent API/MCP、网关与设备授权、依赖和容器配置。采用代码审查、自动化测试、依赖扫描及未授权的线上只读请求；未对真实设备执行操作。

## 已修复

1. **旧邮箱密码接口可绕过 Google-only 登录策略。** 攻击者可直接调用 `/api/register` 创建账号，或调用 `/api/login` 使用已有密码；仅移除前端表单不足以限制接口。Hub 现对 `/api/register`、`/api/login` 及其 v1 别名返回 HTTP 410；Cloudflare Worker 在转发前重复拦截，以覆盖 WebSocket 保留的旧 Durable Object 实例。受邀用户的限权凭证和 Agent Bearer 凭证不受影响。
2. **Cloudflare 内部转发可能让访客共用登录限流桶。** Node 适配层的连接地址可能是内部地址；任意访客重复发起 Google 授权可耗尽所有人的登录额度。Worker 现从 Cloudflare 访客地址设置私有转发头，Hub 仅在可信 Worker 模式采用该地址；自托管 Hub 忽略访客自填的同名头。测试覆盖伪造头不能绕过本地限流，以及可信边缘地址之间相互隔离。

## 检查结果

- Google OIDC 使用 state、浏览器绑定、PKCE、nonce、已验证邮箱及签名/受众/有效期校验；不会根据同名邮箱自动合并旧账号。
- 所有者 Cookie 设置 HttpOnly、SameSite=Strict，HTTPS 下设置 Secure；写操作校验 Origin。MCP 不接受所有者 Cookie 或 URL 凭证。
- 设备、网关和共享凭证按租户与能力检查；ADB 输入需要独立授权，打印机操作需所有者审批；本地网关仍可收紧能力。
- 公网站点返回 CSP、HSTS、`nosniff`、`no-store`；未授权 MCP 请求返回 401。页面将设备数据以文本插入，未发现直接 HTML 注入路径。
- `npm audit` 对生产及全部依赖均报告 0 个已知漏洞。镜像以非 root 运行，Hub 容器禁用提权并移除 Linux capabilities；未发现被 Git 跟踪的实际密钥文件。

## 上线前仍需处理

- 当前 Google OAuth 应用仍为 Testing，公开注册会受测试用户限制。面向公众开放前需要独立的 MeshMind 品牌项目、正式发布及对外登录验证。
- 已失效会话的旧密码账号无法自助关联 Google，需要管理员核实身份后迁移；不能按邮箱自动合并，因为旧邮箱未经验证。
- 这是单 Hub MVP，缺少正式的运营告警、备份恢复演练、组织成员体系和独立渗透测试。当前检查不等于完整的第三方安全评估。
