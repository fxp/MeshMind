// MeshMind Hub —— Cloudflare Worker 入口。
// 所有请求转发到单个 Hub Durable Object（个人规模一个 Hub 足够；量大再按设备分片）。
import { Hub } from "./hub.ts";

export { Hub };

interface Env {
  HUB: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ ok: true, service: "meshmind-hub" });
    }
    const id = env.HUB.idFromName("hub");
    const stub = env.HUB.get(id);
    return stub.fetch(req);
  },
};
