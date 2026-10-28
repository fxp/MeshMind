# Cloudflare SaaS 部署

线上地址：[mesh.xiaopingfeng.com](https://mesh.xiaopingfeng.com/)。此入口部署的是 `saas/` 多租户版本，旧的 `meshmind-hub` / `hub.xiaopingfeng.com` 原型保持独立。

## 运行方式

- Worker：`meshmind-saas`；自定义域名和 HTTPS 由 Cloudflare 管理，禁用 workers.dev 及预览域名。
- 前端：Workers Static Assets，所有者登录、共享凭证和 MCP 都使用同一站点。
- Mac 程序安装包：R2 `meshmind-releases` 桶；Worker 在 `/downloads/` 以版本化路径流式提供安装包和 SHA-256 文件。安装包不写入 Durable Object 或 Worker 静态资源。
- 状态：SQLite-backed Durable Object `SaasHub`；通过 `DurableSqlite` 复用现有参数化 SQL 和同步事务，账号、身份、授权、审批及审计不写入临时磁盘。
- 网关：Cloudflare WebSocketPair，复用相同的入网凭证、公钥挑战、设备能力校验、任务绑定、心跳和撤销规则。
- HTTP：Cloudflare 官方 `handleAsNodeRequest` 适配现有 API 和 MCP SDK，避免重写权限逻辑。
- 登录：现有 Google Web 客户端同时保留 localhost 回调及 `https://mesh.xiaopingfeng.com/api/auth/google/callback`，Client ID / Secret 由 Workers secrets 注入。

当前仍是单 Hub 协调的 MVP，保持原有账号隔离和 SQLite 事务语义；尚未实现按空间分片及多实例高可用。网关 WebSocket 使用活动连接模式，连接期间会产生相应 Durable Objects 运行用量，未实现休眠连接适配。公开注册当前开启，Google 项目仍处于测试模式，只允许其测试名单内账号授权。

本地 SQLite 与 Cloudflare 数据库相互独立，没有自动复制本地账号、会话或网关身份。首次访问线上可用 Google 登录建立设备空间。网关需要在对应线上空间重新入网，不能直接复用指向 localhost 的身份文件。打印机 LAN 访问码、IP、序列号和证书仍只存网关本地。

## 更新与检查

在 `saas` 目录：

```bash
npm ci
npm run typecheck
npm run cf:typecheck
npm test
npm run cf:deploy -- --dry-run
npm run cf:deploy
```

发布新的 Mac 版本时，先配置 `MESHMIND_CODESIGN_IDENTITY` 和 `MESHMIND_NOTARY_PROFILE`，运行 `npm run mac:release`，再执行 `npm run mac:smoke`。发布脚本只有在 Developer ID hardened runtime 签名、Apple 公证、staple 和 Gatekeeper 检查全部通过后才会生成 `macos/dist/` 中的 ZIP 与校验文件。上传到 R2 后再更新 Worker 下载白名单和网页版本路径；本地 `npm run mac:build:dev` 生成的 ad-hoc 构建禁止公开分发。

部署配置在 `saas/cloudflare/wrangler.jsonc`，使用本项目的 Wrangler 版本，不使用旧原型目录的部署脚本。后续部署会保留现有线上 secrets，不需要重复传递密钥。添加或修改绑定后执行 `npm run cf:types` 生成类型。

首次部署需从私有配置准备仅含 `GOOGLE_CLIENT_ID` 与 `GOOGLE_CLIENT_SECRET` 的 0600 JSON 文件，再通过 `npm run cf:deploy -- --secrets-file /absolute/path/secrets.json` 上传。密钥文件应放在忽略目录、使用后删除，不能写入配置或终端参数值。

本地 Cloudflare 运行时：

```bash
npm run cf:dev
npm run cf:smoke -- --hub http://localhost:8790
```

`cf:dev` 使用单独的本地 Durable Object 状态。`--local-upstream localhost:8790` 保证本地请求地址与本地 PUBLIC_URL 一致；不连接线上数据。

`cf:smoke` 在本地可创建临时测试账号；公网检查必须通过 `--owner-cookie-file` 提供现有所有者会话文件，不自动注册公网演示账号。脚本只使用明确标记的模拟 X1C，最后撤销它创建的网关和访问凭证。撤销记录和审计保留，不操作真实设备。

## 验证与恢复

- 51 项自动化测试、Cloudflare 类型检查和 Mac 打包运行时联调，包含 ADB 权限、通用 USB／局域网设备本地操作白名单、所有者审批链路及 Home Assistant 限定实体读取。
- Cloudflare 本地运行时完整验证：9 项检查，含重复 MCP 请求、网关 WSS、状态读取、审批执行及撤销；本地运行时重启后原账号仍可登录。
- 线上通过同一模拟器流程检查；结果见 `SAAS-VERIFICATION.md`。
- 不提供公网数据库管理接口。数据恢复使用 Cloudflare 的 Durable Objects SQLite 存储恢复能力；代码回滚不会回滚数据库。恢复前应核对目标实例、时间点及可能重复或未知的设备操作，不能自动重放动作。
- 本机服务、容器启动方式及原有模拟器、X1C 连接器均保留。真实 X1C 的证书和固件兼容性仍需真机联调。

所依据的官方接口：[Node HTTP 适配](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/)、[Durable Objects SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Node crypto 兼容性](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)。
