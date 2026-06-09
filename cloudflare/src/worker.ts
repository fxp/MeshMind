// MeshMind Hub —— Cloudflare Worker 入口。
// 所有请求转发到单个 Hub Durable Object（个人规模一个 Hub 足够；量大再按设备分片）。
//
// 鉴权分层：
//   /health           公开
//   /enroll           设备面，由一次性 enroll_secret 自鉴权
//   /agent/<id> (WS)  设备面，由 per-device bearer 鉴权
//   /admin/* /goal /devices  管理面，需 ADMIN_TOKEN（Authorization: Bearer 或 x-meshmind-admin）
import { Hub } from "./hub.ts";

export { Hub };

interface Env {
  HUB: DurableObjectNamespace;
  ADMIN_TOKEN?: string;
}

function needsAdmin(path: string): boolean {
  return path === "/goal" || path === "/devices" || path.startsWith("/admin/");
}

/** 常数时间比较（比对 SHA-256 摘要，避免长度/时序泄露）。 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function authorizedAdmin(req: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false; // 未配置 → 拒绝所有管理操作（安全默认）
  const header = req.headers.get("authorization") ?? "";
  const got = header.replace(/^Bearer\s+/i, "") || req.headers.get("x-meshmind-admin") || "";
  if (!got) return false;
  return safeEqual(got, env.ADMIN_TOKEN);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ ok: true, service: "meshmind-hub" });
    }
    if (needsAdmin(url.pathname) && !(await authorizedAdmin(req, env))) {
      return Response.json({ ok: false, error: "unauthorized (need admin token)" }, { status: 401 });
    }
    const id = env.HUB.idFromName("hub");
    const stub = env.HUB.get(id);
    return stub.fetch(req);
  },
};
