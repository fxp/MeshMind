# Headscale（网络平面）— 远程设备阶段启用

P0 本机单机验证**不需要** Headscale：子 Agent 和主机都连 `localhost:4222` 的 NATS。
当设备开始异地分布时，再按本目录启用 Tailscale 虚拟网，让 NATS / 设备间直传跑在私有网上。

## 启用步骤（远程阶段）

1. 在 VPS 上跑 Headscale（协调面）：

   ```yaml
   # 追加到 infra/docker-compose.yml 的 services:
   headscale:
     image: headscale/headscale:0.23
     command: serve
     ports: ["8080:8080", "9090:9090"]
     volumes:
       - ./headscale/config:/etc/headscale
       - hs-data:/var/lib/headscale
   ```

2. 创建用户 + 预授权 key：

   ```bash
   headscale users create mesh
   headscale preauthkeys create --user mesh --reusable --expiration 720h
   ```

3. 每台设备装 Tailscale 客户端并加入：

   ```bash
   tailscale up --login-server https://<vps>:8080 --authkey <preauthkey>
   ```

4. 之后子 Agent 的 `NATS_URL` 改为主机的 MagicDNS 名，例如
   `nats://vps.mesh:4222`，全部流量走 WireGuard。

## ACL（P4 安全治理时填充）

`config/acl.hujson` 表达「谁能用什么能力访问哪台设备」，与子 Agent 的能力作用域镜像。
