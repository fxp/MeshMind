# MeshMind SaaS · X1C / Android ADB → Codex

多租户设备接入与能力授权的第一版。每位所有者拥有独立设备空间；局域网网关主动通过 HTTPS/WSS 连接 Hub；用户和 Agent 通过独立、可撤销、会到期的凭证访问指定设备。

**当前交付：本地、容器及 Cloudflare 公网版本。线上入口为 [mesh.xiaopingfeng.com](https://mesh.xiaopingfeng.com/)，没有连接或操作你的真实打印机。** 模拟器覆盖打印机完整流程；本机 ADB 已完成真实设备状态与界面结构读取。真实 X1C 的 MQTT 连接器仍需按固件、LAN 模式和证书联调。

## 本地启动

需要 Node.js 22.13+（建议 Node 22 LTS）和 npm。

```bash
cd saas
npm ci
npm start
```

打开 http://localhost:8788。创建账号后，每个账号都会得到独立的设备空间。密码至少 12 个字符，本地开发默认开放注册。

### 启用 Google 账号登录

登录页已提供「使用 Google 账号登录」。未配置客户端时按钮禁用，并显示原因；邮箱／密码登录仍可使用。

1. 在 Google Cloud 控制台创建或选择项目，配置 OAuth 同意屏幕。若应用仍处于测试阶段，将要测试的 Google 账号加入允许的测试用户。
2. 创建 OAuth 客户端，应用类型选择 **Web application / Web 应用**。
3. 在授权重定向地址中添加以下完整地址，路径和端口必须一致：

   ```text
   http://localhost:8788/api/auth/google/callback
   ```

   公网部署则登记 `https://你的域名/api/auth/google/callback`，并让 `PUBLIC_URL` 与该站点一致。

4. 在 `saas` 目录创建本地配置：

   ```bash
   cp .env.example .env
   chmod 600 .env
   ```

   在 `.env` 中填写 Google 提供的两项值：

   ```dotenv
   GOOGLE_CLIENT_ID=你的Web客户端ID
   GOOGLE_CLIENT_SECRET=你的客户端密钥
   ```

5. 重启 `npm start`，刷新页面后即可点击 Google 登录。服务自动读取 `saas/.env`，已有进程环境变量优先；`.env` 不进入 Git 或容器镜像。

容器版本也从 `saas/.env` 读取这两个配置。修改后重新创建 Hub 容器使环境生效，例如在 `saas` 目录执行 `docker compose -f compose.local.yml up -d --force-recreate hub`。公网模板仍由 `DOMAIN` 决定站点地址。可选 `.env` 文件格式需要 Docker Compose 2.24+。

**账号规则：** 新 Google 用户在开放注册时获得独立设备空间；关闭注册后，已有 Google 账号仍能登录。已有密码账号请先用原密码登录，再点击账号区的「关联 Google 登录」，这样保留原有设备和授权。系统不会仅凭相同邮箱自动合并账号，也不会自动替换已关联的 Google 身份。

使用服务端授权码流程，只请求 `openid email`。Client Secret 仅保留在服务端，Google 的 access token／refresh token 不保存、不发给浏览器。回调使用一次性 state、浏览器绑定 Cookie、PKCE S256 和 nonce；身份令牌的签名、发行方、受众和有效期由 Google 官方库校验。Google-only 账号不自动生成可用密码。

Google 登录需要用户浏览器和 Hub 都能访问相应 Google 服务；设备网关的连接不依赖 Google。2026-10-26 已在本机创建 `MeshMind Local Web` 客户端，并完成真实 Google 授权、回调和设备空间登录验证；凭据仅在本机 `.env` 中，其他部署仍需自行配置。自动化测试使用模拟网络响应与真实签名校验。

当前本地客户端位于已有的 `ai-buzzwords-distribute` Google Cloud 项目中，因此 Google 授权页显示该项目已有的应用名称「AI Buzzwords Distribute」。项目仍处于 Testing，当前账号已列为测试用户。正式上线前应为 MeshMind 配置独立项目及品牌信息，并登记正式 HTTPS 回调地址。

### 三分钟模拟演示

1. 在「连接网关」创建网关，下载一次性 `enrollment.json`，10 分钟内使用。
2. 在另一个终端的 `saas` 目录运行：

   ```bash
   npm run gateway -- --config gateway.simulator.example.json --enroll /absolute/path/enrollment.json
   ```

3. 刷新「设备总览」，看到清楚标记为模拟设备的 X1C，读取状态。
4. 在「用户与 Agent」选择它，签发只包含 `status` 的短期凭证，下载 `meshmind-token.txt`。
5. 将凭证交给另一个用户在登录页进入，或为 Codex 安装 MCP：

   ```bash
   npm run setup-codex -- --hub http://localhost:8788 --token-file /absolute/path/meshmind-token.txt
   ```

   此命令会验证凭证、收紧文件权限，再调用本机 `codex mcp add`，更改本机 Codex 配置。它不会把凭证正文写进 Codex 配置。重新开启 Codex 会话后，可以要求：

   > 使用 MeshMind 列出我获授权的设备，查看 X1C 的打印进度、温度和剩余时间。报告状态是否过期。不要申请控制操作。

6. 测试审批时，另签发包含 `pause` 的凭证。Agent 使用 `request_printer_action` 后，所有者在「操作审批」批准；模拟器状态才会变成暂停。
7. 撤销凭证后，原 Agent 下一次请求得到 401；撤销网关后，活动连接关闭，其设备不再出现在目录中。

首次入网后身份存入 `data/gateway.json`（0600）。重启可不带 `--enroll`。每个网关实例使用独立的 `--state` 文件；不要把同一身份复制到多个地点。Hub 地址会固定在此身份文件中，换 Hub 时需重新入网。

## MeshMind Connect for Mac

线上「连接网关」页面提供 [Apple Silicon 安装包](https://mesh.xiaopingfeng.com/downloads/MeshMind-Connect-macOS-arm64-0.1.1.zip) 与 [SHA-256 校验文件](https://mesh.xiaopingfeng.com/downloads/MeshMind-Connect-macOS-arm64-0.1.1.zip.sha256)。要求 macOS 14 或更新版本。程序内置 Node 网关运行时，不要求用户安装仓库依赖。

1. 下载并解压，将 `MeshMind Connect.app` 放到「应用程序」文件夹。当前是 **开发预览版**，只有 ad-hoc 签名，尚无 Apple Developer ID 签名和公证；macOS 首次运行可能需要在「系统设置 → 隐私与安全性」中选择「仍要打开」。公开正式版必须补齐签名、公证与自动更新。
2. 打开程序，添加这台 Mac 能访问的设备。同一个 Mac 网关可以添加多台设备，无需给每台设备创建网关。
3. 在 MeshMind 网站的「连接网关」生成一次性入网文件，并在十分钟内通过程序导入。程序把网关身份和本地设备配置保存到当前用户的 `~/Library/Application Support/MeshMind Connect/`，权限限制为当前用户；入网成功后删除一次性文件。可选「登录 Mac 后自动启动」。
4. 网页「设备总览」显示在线设备后，在「用户与 Agent」分别签发范围受限的访问凭证。`device_status` MCP 工具读取 ESP32 或 Home Assistant 状态。

ADB 只连接界面中选择、且已通过本机 USB 调试授权的设备；读取界面与结构化输入分别需要在本地开启，并由网站按设备、Agent、能力和有效期授权。已授予 `adb_input` 后，输入操作直接执行并留下审计记录，不再逐次审批。打印机控制仍需所有者逐次审批。ESP32 使用 `/dev/cu.*` 串口，固件每行输出一个 UTF-8 值或 `{"state":"online","value":"23.5","unit":"°C"}`；60 秒没有新数据就拒绝提供新状态。Home Assistant 使用本地填写的 URL、长期令牌与单个实体 ID，通过 `/api/states/<entity_id>` 读取。**ESP32 与 Home Assistant 当前只读**，不提供任意串口写入、HA service call 或局域网代理。实体令牌保存在本机当前用户可读的配置文件中，不上传 Hub。

已经在同一台 Mac 上运行命令行网关时，直接再创建新网关会让同一个实体出现两次。迁移前应先规划停用旧网关，并为新设备 ID 重新签发 Agent 凭证；当前 Mac 程序还不自动接管旧命令行网关身份。程序源码、构建脚本和图标位于 `saas/macos/`；运行 `./macos/build.sh` 后用 `npm run mac:smoke` 验证打包后的运行时。

## 接入本机 ADB 设备

在连接 Android 设备的电脑上安装 Android Platform Tools，打开设备的 USB 调试并在手机上确认这台电脑的授权。运行 `adb devices -l`，只复制状态为 `device` 的那一行序列号。网关会固定使用该序列号和本机 `127.0.0.1:5037` ADB 服务，不会让 Hub 或 Agent 选择其他设备。

在此电脑的 `saas` 目录中执行：

```bash
cp gateway.adb.example.json gateway.adb.json
# 在 gateway.adb.json 中把 adbSerial 换成 adb devices -l 显示的序列号
npm run gateway -- --config gateway.adb.json --enroll /absolute/path/enrollment.json --state data/adb-gateway.json
```

入网文件在 [MeshMind 网页](https://mesh.xiaopingfeng.com/)「连接网关」中生成。网关连接公网 Hub 使用出站 WSS，不向公网开放 ADB 5037 端口。ADB 网关应直接运行在连接设备的电脑上；现有网关容器模板没有映射 USB 设备或宿主机 ADB 服务。本地 `gateway.adb.json` 和身份文件被 Git 忽略；若 `adb` 不在 `PATH`，可在配置中填本机 `adbPath` 绝对路径。

默认只公开 `adb_status`：读取已授权设备的在线状态、型号和 Android 版本。需要让 Agent 理解当前界面时，在本地设置 `allowUiDump: true` 并重启网关，再为该设备单独授予 `adb_ui`；界面 XML 可能包含个人信息，只有获授权主体可以读取。需要控制时设置 `allowControl: true`，单独授予 `adb_input`。Agent 可在凭证授权的设备与有效期内直接执行点击、滑动、常用按键和限定字符输入；Hub 会在发送前记录输入，并保存执行结果。勿用文本输入密码或其他秘密。

在「用户与 Agent」选择该 ADB 设备、权限和短有效期，下载独立访问凭证。Agent 连接下方 MCP 地址后，可先调用 `list_devices`、`adb_status`、`adb_ui`，再调用 `request_adb_input`。例如 `{"deviceId":"dev_...","input":{"kind":"tap","x":100,"y":200}}`。Hub 不接受任意 ADB shell、安装 APK、文件传输或原始端口代理。当前没有屏幕截图工具；`adb_ui` 返回的是 Android 界面结构，具体设备可能不支持或未展示全部内容。

## 接入真实 X1 Carbon

网关运行在与 X1C 可互相访问的电脑、NAS 或小主机上。X1C 不需要安装软件，也不用设置路由器端口映射。

```bash
cp gateway.x1c.example.json gateway.x1c.json
chmod 600 gateway.x1c.json
```

只在本地文件中填写打印机 IP、序列号和 LAN 访问码。确认打印机固件允许 LAN 接口；不同固件的 LAN／开发者模式限制可能不同。**不要把这些字段发给 Hub、Codex 或第三方 Agent。**

连接器使用局域网 MQTT over TLS，端口 8883。它订阅报告并请求完整状态，归一化进度、温度、剩余时间和任务名称。Hub 只保存经过筛选的设备清单；状态按需读取，不保存原始 MQTT 报文。

### 固定打印机证书

`caFile` 必填。连接器验证证书链，并核对本地固定证书的 SHA-256 指纹，没有跳过 TLS 验证的开关。

在可信局域网中，从你确认的打印机 IP 获取证书。例如：

```bash
openssl s_client -connect PRINTER_IP:8883 -showcerts </dev/null 2>/dev/null \
  | openssl x509 -outform PEM > printer-certificate.pem
openssl x509 -in printer-certificate.pem -noout -fingerprint -sha256
```

首次证书固定需要你信任采集时的局域网和设备地址；采集本身不能证明设备身份。将证书在本地核对并保存。固件更换证书时应人工核对后更新，不要自动接受新证书。若真实打印机的证书链或有效期不满足验证要求，需要先解决证书兼容性，不能关闭验证来绕过。

然后运行：

```bash
npm run gateway -- --config gateway.x1c.json --enroll /absolute/path/enrollment.json --state data/x1c-gateway.json
```

默认 `allowControl: false`。读取状态验证通过后，只有所有者在本地将它改成 `true` 并重启，才会声明暂停、恢复、停止能力。Hub 无法仅靠远程配置打开它。

目前不支持启动打印、文件上传、摄像头转发、拓竹云账号登录。真实 MQTT 控制返回 `delivery: published, deviceAcknowledged: false`，表示指令已发布，不能当成设备执行成功。

## Codex / 其他 MCP 客户端

Agent 也可以直接使用 JSON CLI 和版本化 HTTP API，无需 MCP 客户端；参见 [Agent CLI 与 API 指南](../docs/AGENT-API.md)。网页「用户与 Agent」提供 CLI 下载和 OpenAPI 入口。

MCP 使用官方 SDK，同时提供直接连接的 Streamable HTTP 入口和本地 stdio 桥接。两种方式共用以下八个工具及同一套权限、审批和审计规则：

| 工具 | 行为 |
|---|---|
| `list_devices` | 仅列出该凭证获授权的设备 |
| `printer_status` | 读取状态，包含 `observedAt` 和 `stale` |
| `device_status` | 读取 ESP32 串口或 Home Assistant 实体状态 |
| `request_printer_action` | 申请暂停、恢复、停止；必须所有者批准 |
| `list_action_requests` | 查询此凭证提交的审批或直接操作记录与结果 |
| `adb_status` | 读取获授权 Android 设备的连接状态 |
| `adb_ui` | 读取当前界面 XML；本地和主体需分别启用 |
| `request_adb_input` | 在 `adb_input` 授权范围内直接执行结构化输入并记录结果 |

### 直接连接（无需下载本项目）

在「用户与 Agent」签发范围受限的凭证，下载为 `meshmind-token.txt`。页面会显示 MCP 地址及 Codex 配置命令。本地入口为 `http://localhost:8788/mcp`；公网部署后为 `https://你的域名/mcp`。

在启动 Codex CLI 的终端中执行，将文件路径和服务地址替换成实际值：

```bash
chmod 600 /absolute/path/meshmind-token.txt
export MESHMIND_TOKEN="$(cat /absolute/path/meshmind-token.txt)"
codex mcp add meshmind --url http://localhost:8788/mcp --bearer-token-env-var MESHMIND_TOKEN
codex
```

该命令只把服务地址和环境变量名写入 Codex 配置。凭证保存在本地文件，启动时加载到环境变量，撤销或到期后，已经初始化的客户端下一次调用也会失效。Codex 桌面应用如果无法继承终端的环境变量，使用下方本地 stdio 方式和 `npm run setup-codex`。

其他支持 Streamable HTTP 的 MCP 客户端使用同一地址，认证头为 `Authorization: Bearer <独立访问凭证>`；请通过客户端的密钥配置填写，不能把凭证放入 URL。Google 账号登录是所有者管理入口，不能替代 Agent 的独立凭证。

`localhost` 只供同一电脑上的 Agent 使用。不同网络或云端 Agent 需要能访问 Hub 的正式 HTTPS 域名；无需让 Agent 访问打印机的局域网端口。线上已部署到 `https://mesh.xiaopingfeng.com`，MCP 地址为 `https://mesh.xiaopingfeng.com/mcp`。

入口采用无状态 POST，响应为 JSON，不提供持续的 GET/SSE 订阅或自动 OAuth 客户端注册。每个请求验证 Host、可选的 Origin、凭证与权限；限制请求大小、请求速率及并发数，不接受 JSON-RPC 批量请求。反向代理需保留与 `PUBLIC_URL` 一致的原始 Host。

### 本地 stdio 桥接

此方式需要本项目，适合通过凭证文件连接的桌面 Agent。其他 MCP 客户端可使用以下配置，将所有路径替换成实际绝对路径：

```json
{
  "mcpServers": {
    "meshmind": {
      "command": "node",
      "args": ["/absolute/path/saas/node_modules/tsx/dist/cli.mjs", "/absolute/path/saas/src/mcp.ts"],
      "env": {
        "MESHMIND_HUB": "https://your-hub.example",
        "MESHMIND_TOKEN_FILE": "/absolute/path/meshmind-token.txt"
      }
    }
  }
}
```

MCP 进程只有 Agent 的范围受限凭证，不持有所有者会话或打印机 LAN 密钥。MCP 工具描述不是权限边界，Hub 和网关会再次验证。作业名称等设备返回文本是不可信数据，不应被 Agent 当作指令。

## Cloudflare 公网部署

访问 [mesh.xiaopingfeng.com](https://mesh.xiaopingfeng.com/) 使用线上设备空间。更新、存储、Secrets 及验证说明见 [Cloudflare 部署文档](../docs/CLOUDFLARE-DEPLOYMENT.md)。本地数据库与线上独立，网关需在对应空间重新入网。Google 公网回调已加入现有客户端，本地回调保留。

## 容器

### 本机演示

在 `saas` 目录：

```bash
docker compose -f compose.local.yml up --build -d
```

仅向本机暴露 `127.0.0.1:8788`，SQLite 使用命名卷。网关可先在宿主机运行，连接本机 Hub。

### 公网 Hub 模板

```bash
DOMAIN=mesh.example.com ALLOW_SIGNUP=true docker compose -f compose.public.yml up --build -d
```

需先配置域名、DNS、服务器及入口可达性。Caddy 终止 HTTPS/WSS，Hub 不直接映射公网端口。生产默认 `ALLOW_SIGNUP=false`；上面的 `true` 是显式开放注册。关闭注册不会禁用已有账号登录。

这是部署模板，不是已经上线的 SaaS。当前只支持单个 Hub 实例与 SQLite 本地持久化；不能将多个实例各自连接独立数据库后当作同一个集群运行。正式公开运营前还需身份验证与找回流程、MFA、注册反滥用、配额与计费、备份恢复演练、监控及独立安全评估。

### 地点网关容器

在 `saas/local-gateway/` 准备本地 `gateway.json`、`enrollment.json`、证书；`caFile` 使用容器内 `/config/printer-certificate.pem`。入网文件必须指向 HTTPS Hub。

```bash
mkdir -p local-gateway local-gateway-state
chmod 700 local-gateway local-gateway-state
GATEWAY_UID=$(id -u) GATEWAY_GID=$(id -g) docker compose -f compose.gateway.yml up --build -d
```

网关不开放入站端口。配置目录只读，身份目录独立持久化。操作系统、容器主机和网关本地管理员属于可信边界；不要把整个家庭网段或打印机访问码交给受邀用户。

## 权限与故障语义

- 每个请求从已验证的会话／凭证获取租户身份，客户端不能指定租户 ID。
- 密码使用带随机盐的 scrypt；会话、入网令牌、网关 bearer、共享令牌在 Hub 只存 SHA-256 摘要。
- 共享凭证绑定明确设备集合、明确操作集合和到期时间；没有跨租户通配符或共享管理员令牌。
- 网关每次重连须响应新挑战，并签名完整设备清单。未验签的连接不能心跳上线或返回任务结果。
- 结果绑定原始网关会话，其他网关知道任务 ID 也不能提交结果。
- 控制需同时通过本地配置与共享凭证范围。ADB 结构化输入在授权有效期内直接执行并审计；打印机控制仍需所有者逐次审批，审批 5 分钟到期。执行前重新检查凭证和设备能力。
- 不排队执行离线控制，不自动重试未知结果。重启时未完成的控制标记 `unknown`。
- 撤销阻止后续访问；已发到实体设备的操作无法撤回。远程 Hub 仍是可信服务，本地能力上限可以限制它。
- 这版按设备能力跨网络接入，**未实现通用 TCP/UDP 隧道、虚拟 IP、远程桌面或整个局域网的互通**。后续应通过独立成熟传输组件接入；不把通用端口访问包装成“只读打印机”。

## 验证

```bash
npm run typecheck
npm test
```

集成测试启动真实 HTTP/WSS 服务、两个租户与两个模拟网关，并使用 MCP SDK 客户端完成工具调用。真实 X1C 的协议和固件兼容性仍需硬件验证。

本次验证结果和未验证范围见 [../docs/SAAS-VERIFICATION.md](../docs/SAAS-VERIFICATION.md)。
