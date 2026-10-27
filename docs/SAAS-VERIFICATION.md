# v3 本地交付验证 · 2026-10-26

## 2026-10-27 公开 Agent 文档

- Cloudflare 版本 `70776663-ba18-4167-9371-2ea8e885f673` 已部署到 `mesh.xiaopingfeng.com`。公开页面 `/docs/agent-api`、CLI 下载和 OpenAPI 3.1 均返回 200，无需登录；登录页与授权面板均提供文档入口。
- 本地浏览器检查了文档页面、登录页跳转和控制台错误；375px 手机宽度无横向溢出。线上 CLI 下载文件与本地文件 SHA-256 一致。
- TypeScript、Cloudflare 类型检查和 48 项测试通过。文档页面不包含真实凭证或设备密钥。

## 2026-10-27 Agent CLI / API 更新

- 首次 Cloudflare 版本 `7c0adafc-2c5d-43d1-ad2c-a702c6cfa408` 已发布到 `mesh.xiaopingfeng.com`。独立 CLI 下载文件与本地构建的 SHA-256 一致；公开发现入口和 OpenAPI 3.1 均返回 200。
- 使用当前只读 Agent 凭证验证公网 `whoami` 与 `devices list`，只列出获授权的 ADB 设备；凭证只存在本机 0600 文件中。公网 `/api/v1` 由 Worker 映射到既有 Hub 权限路由，长连接中的旧 Durable Object 实例也能立即使用新入口。
- 统一状态读取已由本地 HTTP/WSS 集成测试覆盖；线上实际调用返回 502，因为本机 `adb devices -l` 当前没有列出 USB 设备。没有向真实 Android 设备发送输入。
- 本地 TypeScript、Cloudflare TypeScript 与 48 项测试通过，新增 CLI 凭证范围、危险操作显式执行、版本化路由和统一状态测试。当前 ADB 输入在单独授予 `adb_input` 后直接执行，打印机控制继续要求所有者审批；下方旧记录描述的是当时的实现。

## 已验证

- `saas` TypeScript 类型检查通过。
- 当前 42 项测试在宿主机通过；此前的 37 项基础测试还在 Node 22 容器中通过。新增 5 项 ADB MCP 集成测试使用假 ADB 可执行程序，不触碰真实设备。测试启动真实 HTTP／WebSocket 服务和多个网关，并使用 MCP SDK 客户端完成工具调用。
- 覆盖跨租户设备 ID 访问、目录枚举、网关撤销、凭证范围、控制越权、到期／撤销、审批、幂等键、Cookie CSRF、错误 bearer 不回退到所有者身份。
- 覆盖一次性入网、未注册心跳、错误签名、另一网关伪造任务结果、本地只读策略拒绝 Hub 控制。
- 覆盖短暂连接超时后的自动重连，重连后设备 ID 与已有授权保持稳定；临时超时与凭证撤销使用不同关闭码。
- Google 登录测试仅替换 Google 网络端点，使用真实 RSA 签名和 Google 官方 SDK 校验身份令牌；覆盖错误签名、发行方、受众、有效期、nonce、未验证邮箱、浏览器绑定、回调重放和授权取消。
- 覆盖 Google 身份按稳定 subject 登录、同邮箱不自动合并、已有所有者主动关联、跨租户关联拦截、退出后关联失效、关闭注册后已有账号仍可登录，以及旧邮箱密码路由均返回 HTTP 410。
- `/mcp` 使用官方 Streamable HTTP 客户端完成初始化、七个工具发现、读取模拟器状态及提交审批。覆盖不同租户客户端交错调用、只读凭证拒绝控制、幂等申请、所有者审批后模拟状态改变、原客户端凭证到期／撤销失效，以及 Cookie／URL 凭证、恶意 Host／Origin、批量及超大请求拒绝。
- ADB 测试覆盖固定本机 ADB 服务与单个序列号、状态与界面结构读取的独立授权、非法字符拒绝、跨租户隔离、审批前零输入、审批参数展示与幂等、批准后单次执行、凭证撤销。没有测试任意 shell 执行，因为未提供该能力。
- 「用户与 Agent」提供直接 MCP 地址、Codex 环境变量配置命令和本机地址可达性提示；浏览器已检查页面展示。
- 最新 Cloudflare 版本：`1e6af7f8-d720-40f7-9ff2-50aeda9428ed`。Google-only 页面、四个旧密码接口的边缘 HTTP 410 拦截、HTTPS 页面和文档、未授权 MCP 拒绝均已验证；49 项自动化测试通过。安全检查见 [2026-10-27 报告](SECURITY-REVIEW-2026-10-27.md)。
- Cloudflare Worker `meshmind-saas` 已部署到 `https://mesh.xiaopingfeng.com`，静态页面、HTTPS、安全响应头和未授权 MCP 拒绝通过。旧 `meshmind-hub` 原型独立保留。
- Cloudflare 本地运行时完成 9 项完整流程检查，使用持久化 Durable Objects SQLite；重启运行时后原账号登录通过。测试包含真实 HTTP/WebSocket 连接，设备为模拟器。
- 线上真实 Google 账号登录、HTTPS 回调及 Secure / HttpOnly 会话已验证。随后使用该所有者会话完成同一套 9 项线上检查，包含多次 MCP 请求、状态读取、所有者批准、凭证撤销及网关撤销。测试创建的访问凭证和模拟网关均已撤销，未创建公网默认账号或密码。
- 真实 Android 设备通过本机 ADB 和出站 WSS 接入线上所有者空间；网页与官方 MCP 客户端均成功读取在线状态、型号、Android 版本及当前界面结构。真实 `adb_input` 申请在线上产生待审批记录，所有者核对参数后拒绝，没有向设备发送输入。Agent 凭证仅绑定这台设备，有效期 24 小时；`adb_input` 请求仍需所有者逐次批准。macOS LaunchAgent 已配置登录后启动网关。第一次签发的凭证因检查输出误显，已立即撤销并签发替代凭证，替代凭证仅存于本机 0600 文件。
- 2026-10-26 在 Ego Lite 中创建真实 Google Web OAuth 客户端，配置本地回调与权限为 0600 的 `.env`，重启 Hub 后完成账号选择、邮箱授权、真实回调及进入设备空间的完整登录流程。Google 项目仍为 Testing，使用已有测试用户；授权页沿用现有项目的「AI Buzzwords Distribute」名称。
- 生产依赖 `npm audit --omit=dev` 当次报告 0 个已知漏洞；检查中发现的 Zod 高危版本已升级至修复版本。该结果不等同于全面安全审计。
- Docker 镜像构建成功，以 UID 1000 非 root 用户运行；健康检查、注册、鉴权请求和容器重启后的账号持久化通过。
- 三份 Compose 配置解析通过：本地 Hub、公网 HTTPS 模板、地点网关。
- 使用 gstack `/browse` 实际操作登录、创建网关、签发凭证、提交控制申请、所有者批准与状态读取；模拟器从 RUNNING 变为 PAUSE。
- 浏览器控制台没有报错；375px 宽度检查无横向页面溢出。
- 演示账号、其关联网关／凭证／审批以及临时网关身份已清理，没有添加默认账号或密码。

## 尚未验证／实现

- 没有接入、读取或操作真实 X1C。连接器的 LAN 模式、MQTT 字段与控制命令、固件授权限制、证书兼容性均需要真机联调。官方文档访问被本机浏览工具的地址安全检查拦截，未将其描述为已核实的固件兼容结论。
- 尚未在真实设备上执行 ADB 输入；该操作会改变设备状态，需所有者在网页中审批。不同 Android 版本的 `uiautomator` 输出也需要更多硬件验证。
- 已验证当前网络到 Cloudflare 公网域名的 HTTPS / WSS / MCP；尚未验证不同运营商和所有地点的互联网可达性。
- 未实现启动打印、文件上传、摄像头、通用 TCP/UDP 组网或虚拟 IP。
- Google OAuth 公网 HTTPS 回调已验证；独立 MeshMind 品牌项目和面向公众的 Google 应用发布尚未完成，现有 Google 项目仍为测试状态。配置步骤见 saas/README.md 的「启用 Google 账号登录」。
- 当前为单实例 SQLite MVP，没有多副本高可用、计费、正式成员邀请、旧账号自助迁移或完整运营监控。
- 旧版 Cloudflare／Go／NATS 原型保留为历史参考，未被迁移成多租户 SaaS。根目录默认入口已指向 v3；旧 Cloudflare 部署需使用明确的 `deploy-legacy-cloudflare` 名称。

运行及接入步骤见 [saas/README.md](../saas/README.md)，安全与信任边界见 [SAAS-ARCHITECTURE.md](./SAAS-ARCHITECTURE.md)。
