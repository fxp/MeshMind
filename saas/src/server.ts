import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { createPublicKey } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDeviceMcp } from "./mcp-tools.ts";
import { WebSocketServer } from "ws";
import { Store, manifest, type DeviceRow, type PrincipalRow, type ApprovalRow } from "./store.ts";
import { Broker } from "./broker.ts";
import { authenticate, canUse, requireOwner, hash, secret, id, bearer, parseBearer, passwordHash, passwordMatches, RateLimiter, type Actor } from "./auth.ts";
import { HttpError, validate, permission, controlAction, adbInput } from "./schema.ts";
import { GoogleLogin, GoogleLoginError, type GoogleOptions, type GoogleProvider } from "./google.ts";
import { apiContract, discovery } from "./api-contract.ts";

export interface AppOptions {
  database: string;
  publicUrl: string;
  allowSignup: boolean;
  tls?: { cert: Buffer; key: Buffer };
  store?: Store;
  nativeWebSockets?: boolean;
  serveStatic?: boolean;
  google?: GoogleOptions;
  googleProvider?: GoogleProvider;
}
const credentials = z.object({ email: z.string().trim().email().max(200).transform(s => s.toLowerCase()), password: z.string().min(12).max(128) }).strict();
const nameInput = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const principalInput = z.object({
  name: z.string().trim().min(1).max(80), kind: z.enum(["user", "agent"]),
  devices: z.array(z.string().regex(/^dev_[a-f0-9]{24}$/)).min(1).max(32),
  permissions: z.array(permission).min(1).max(6).refine(p => p.includes("status"), "必须包含 status"),
  expiresInHours: z.number().int().min(1).max(24 * 30).default(24),
}).strict();
const staticFiles = new Map([["/", ["index.html", "text/html; charset=utf-8"]], ["/app.js", ["app.js", "text/javascript; charset=utf-8"]], ["/app.css", ["app.css", "text/css; charset=utf-8"]], ["/meshmind-cli.mjs", ["meshmind-cli.mjs", "text/javascript; charset=utf-8"]]]);

async function body(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw new HttpError(413, "请求体过大");
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString()); }
  catch { throw new HttpError(400, "请求需要 JSON 内容"); }
}

export function createApp(options: AppOptions) {
  const origin = new URL(options.publicUrl).origin;
  const secure = origin.startsWith("https:");
  const store = options.store ?? new Store(options.database);
  const google = options.google ? new GoogleLogin(store, origin, options.google, options.allowSignup, options.googleProvider) : undefined;
  const broker = new Broker(store);
  const limiter = new RateLimiter();
  let passwordWork = 0;
  async function passwordJob<T>(fn: () => Promise<T>): Promise<T> {
    if (passwordWork >= 4) throw new HttpError(429, "登录请求繁忙，请稍后再试");
    passwordWork++;
    try { return await fn(); } finally { passwordWork--; }
  }
  const wss = options.nativeWebSockets === false ? undefined : new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const publicDir = options.serveStatic === false ? "" : fileURLToPath(new URL("../public/", import.meta.url));

  function json(res: ServerResponse, value: unknown, status = 200) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }
  function deviceFor(actor: Actor, deviceId: string, action: string) {
    const device = store.device(actor.tenant, deviceId);
    if (!device || store.gateway(device.gateway_id)?.revoked) throw new HttpError(404, "设备不存在");
    if (!canUse(actor, device.id, action)) {
      store.audit(actor.tenant, actor.id, action, deviceId, "denied");
      throw new HttpError(403, "没有此设备操作的权限");
    }
    if (!manifest(device).capabilities.includes(action as z.infer<typeof permission>)) throw new HttpError(403, "本地网关未启用此操作");
    return device;
  }
  function session(res: ServerResponse, tenant: string) {
    const token = secret("s_");
    store.db.prepare("INSERT INTO sessions(hash,tenant_id,expires_at) VALUES(?,?,?)").run(hash(token), tenant, Date.now() + 7 * 86400_000);
    const cookie = `meshmind_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? "; Secure" : ""}`;
    const existing = res.getHeader("set-cookie");
    res.setHeader("set-cookie", existing ? [...(Array.isArray(existing) ? existing : [String(existing)]), cookie] : cookie);
  }

  function listDevices(actor: Actor) {
    const rows = store.db.prepare("SELECT d.* FROM devices d JOIN gateways g ON g.id=d.gateway_id WHERE d.tenant_id=? AND d.active=1 AND g.revoked=0").all(actor.tenant) as unknown as DeviceRow[];
    return { devices: rows.filter(d => canUse(actor, d.id, "status")).map(d => ({
      id: d.id, gatewayId: d.gateway_id, ...manifest(d), online: broker.online(d.gateway_id),
      capabilities: manifest(d).capabilities.filter(p => canUse(actor, d.id, p)),
    })) };
  }
  async function readStatus(actor: Actor, deviceId: string) {
    const d = deviceFor(actor, deviceId, "status");
    if (manifest(d).connector === "adb") throw new HttpError(400, "ADB 设备请使用 adb_status");
    if (["esp32_serial", "home_assistant"].includes(manifest(d).connector)) throw new HttpError(400, "此设备请使用 device_status");
    const status = await broker.status(actor.tenant, d.gateway_id, d.local_id);
    store.audit(actor.tenant, actor.id, "status", deviceId, "ok");
    return { deviceId, status, stale: Date.now() - status.observedAt > 60_000 };
  }
  async function readAdbStatus(actor: Actor, deviceId: string) {
    const d = deviceFor(actor, deviceId, "status");
    if (manifest(d).connector !== "adb") throw new HttpError(400, "此设备不是 ADB 连接器");
    const status = await broker.androidStatus(actor.tenant, d.gateway_id, d.local_id);
    store.audit(actor.tenant, actor.id, "adb.status", deviceId, "ok");
    return { deviceId, status, stale: Date.now() - status.observedAt > 60_000 };
  }
  async function readDeviceStatus(actor: Actor, deviceId: string) {
    const d = deviceFor(actor, deviceId, "status");
    if (!["esp32_serial", "home_assistant"].includes(manifest(d).connector)) throw new HttpError(400, "此设备不是通用设备连接器");
    const status = await broker.deviceStatus(actor.tenant, d.gateway_id, d.local_id);
    store.audit(actor.tenant, actor.id, "device.status", deviceId, "ok");
    return { deviceId, status, stale: Date.now() - status.observedAt > 60_000 };
  }
  async function readUnifiedStatus(actor: Actor, deviceId: string) {
    const d = deviceFor(actor, deviceId, "status");
    const connector = manifest(d).connector;
    const result = connector === "adb" ? await readAdbStatus(actor, deviceId)
      : ["esp32_serial", "home_assistant"].includes(connector) ? await readDeviceStatus(actor, deviceId)
      : await readStatus(actor, deviceId);
    return { connector, ...result };
  }
  async function readAdbUi(actor: Actor, deviceId: string) {
    const d = deviceFor(actor, deviceId, "adb_ui");
    if (manifest(d).connector !== "adb") throw new HttpError(400, "此设备不是 ADB 连接器");
    const ui = await broker.androidUi(actor.tenant, d.gateway_id, d.local_id);
    store.audit(actor.tenant, actor.id, "adb.ui", deviceId, "ok");
    return { deviceId, ui };
  }
  function requestAction(actor: Actor, deviceId: string, value: unknown) {
    if (actor.owner) throw new HttpError(400, "请使用共享凭证提交操作请求，再由所有者审批");
    const input = validate(z.object({ action: controlAction, idempotencyKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/) }).strict(), value);
    const d = deviceFor(actor, deviceId, input.action);
    if (manifest(d).connector === "adb") throw new HttpError(400, "此设备不是打印机");
    const existing = store.db.prepare("SELECT * FROM approvals WHERE principal_id=? AND idempotency_key=?").get(actor.id, input.idempotencyKey) as ApprovalRow | undefined;
    if (existing) {
      if (existing.device_id !== deviceId || existing.action !== input.action) throw new HttpError(409, "同一幂等键不能用于不同操作");
      return { value: { approval: approvalView(existing) }, status: 200 };
    }
    const count = store.db.prepare("SELECT count(*) AS n FROM approvals WHERE principal_id=? AND state='pending' AND expires_at>?").get(actor.id, Date.now()) as { n: number };
    if (count.n >= 20) throw new HttpError(429, "待审批操作过多，请先处理已有申请");
    const approval = id("ap_");
    store.db.prepare("INSERT INTO approvals(id,tenant_id,principal_id,device_id,action,idempotency_key,state,expires_at,created_at) VALUES(?,?,?,?,?,?,'pending',?,?)")
      .run(approval, actor.tenant, actor.id, deviceId, input.action, input.idempotencyKey, Math.min(actor.principal.expires_at, Date.now() + 5 * 60_000), Date.now());
    store.audit(actor.tenant, actor.id, input.action, deviceId, "approval_requested");
    return { value: { approval: approvalView(store.db.prepare("SELECT * FROM approvals WHERE id=?").get(approval) as unknown as ApprovalRow) }, status: 202 };
  }
  async function requestAdbInput(actor: Actor, deviceId: string, value: unknown) {
    if (actor.owner) throw new HttpError(400, "请使用已授予 adb_input 权限的共享凭证执行操作");
    const input = validate(z.object({ input: adbInput, idempotencyKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/) }).strict(), value);
    const d = deviceFor(actor, deviceId, "adb_input");
    if (manifest(d).connector !== "adb") throw new HttpError(400, "此设备不是 ADB 连接器");
    const serialized = JSON.stringify(input.input);
    const existing = store.db.prepare("SELECT * FROM approvals WHERE principal_id=? AND idempotency_key=?").get(actor.id, input.idempotencyKey) as ApprovalRow | undefined;
    if (existing) {
      const saved = store.db.prepare("SELECT payload FROM approval_payloads WHERE approval_id=?").get(existing.id) as { payload: string } | undefined;
      if (existing.device_id !== deviceId || existing.action !== "adb_input" || saved?.payload !== serialized) throw new HttpError(409, "同一幂等键不能用于不同操作");
      return { value: { approval: approvalView(existing, input.input) }, status: 200 };
    }
    if (!broker.online(d.gateway_id)) {
      store.audit(actor.tenant, actor.id, "adb_input", deviceId, "gateway_offline");
      throw new HttpError(503, "网关离线；没有排队执行此操作");
    }
    const approval = id("ap_");
    store.transaction(() => {
      store.db.prepare("INSERT INTO approvals(id,tenant_id,principal_id,device_id,action,idempotency_key,state,expires_at,created_at) VALUES(?,?,?,?,?,?,'executing',?,?)")
        .run(approval, actor.tenant, actor.id, deviceId, "adb_input", input.idempotencyKey, actor.principal.expires_at, Date.now());
      store.db.prepare("INSERT INTO approval_payloads(approval_id,payload) VALUES(?,?)").run(approval, serialized);
    });
    store.audit(actor.tenant, actor.id, "adb_input", deviceId, "scope_authorized");
    try {
      const result = validate(z.object({ delivery: z.enum(["published", "simulated", "executed"]), deviceAcknowledged: z.boolean() }).strict(),
        await broker.call(actor.tenant, d.gateway_id, d.local_id, "adb_input", input.input));
      const state = result.deviceAcknowledged ? "completed" : "delivered";
      store.db.prepare("UPDATE approvals SET state=?,result=? WHERE id=?").run(state, JSON.stringify(result), approval);
      store.audit(actor.tenant, actor.id, "adb_input", deviceId, state);
      const row = store.db.prepare("SELECT * FROM approvals WHERE id=?").get(approval) as unknown as ApprovalRow;
      return { value: { approval: approvalView(row, input.input) }, status: 200 };
    } catch (err) {
      store.db.prepare("UPDATE approvals SET state='unknown',result=? WHERE id=?")
        .run(JSON.stringify({ error: "执行结果未知，请检查设备；不会自动重试" }), approval);
      store.audit(actor.tenant, actor.id, "adb_input", deviceId, "unknown");
      throw err;
    }
  }
  function payloadFor(row: ApprovalRow): unknown {
    const saved = store.db.prepare("SELECT payload FROM approval_payloads WHERE approval_id=?").get(row.id) as { payload: string } | undefined;
    return saved ? JSON.parse(saved.payload) : undefined;
  }
  function listApprovals(actor: Actor) {
    store.db.prepare("UPDATE approvals SET state='expired' WHERE tenant_id=? AND state='pending' AND expires_at<=?").run(actor.tenant, Date.now());
    const query = actor.owner ? "SELECT * FROM approvals WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100" : "SELECT * FROM approvals WHERE tenant_id=? AND principal_id=? ORDER BY created_at DESC LIMIT 100";
    const rows = store.db.prepare(query).all(...(actor.owner ? [actor.tenant] : [actor.tenant, actor.id])) as unknown as ApprovalRow[];
    return { approvals: rows.map(row => approvalView(row, payloadFor(row))) };
  }

  let mcpWork = 0;
  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    // MCP never authenticates with a browser owner's session or a URL token.
    if (req.headers.host !== new URL(origin).host) throw new HttpError(403, "MCP 站点地址不匹配");
    if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, "MCP 请求来源不允许");
    limiter.check("mcp-ip:" + (req.socket.remoteAddress ?? "unknown"), 300);
    if (!bearer(req)) throw new HttpError(401, "MCP 需要独立访问凭证");
    const actor = authenticate(store, req);
    limiter.check("mcp-actor:" + actor.id, 300);
    if (req.method !== "POST") { res.setHeader("allow", "POST"); throw new HttpError(405, "此 MCP 入口使用无状态 POST 请求"); }
    if (mcpWork >= 16) throw new HttpError(429, "MCP 请求繁忙，请稍后再试");
    mcpWork++;
    const mcp = createDeviceMcp(async (path, input) => {
      try {
        // Recheck the token on every tool call; no credential lives in a shared MCP session.
        const current = authenticate(store, req);
        let value: unknown;
        if (path === "/api/devices") value = listDevices(current);
        else if (path === "/api/approvals") value = listApprovals(current);
        else {
          const match = /^\/api\/devices\/(dev_[a-f0-9]{24})\/(status|device-status|actions|adb-status|adb-actions|adb-ui)$/.exec(path);
          if (!match) throw new HttpError(404, "工具不存在");
          value = match[2] === "status" ? await readStatus(current, match[1])
            : match[2] === "device-status" ? await readDeviceStatus(current, match[1])
            : match[2] === "adb-status" ? await readAdbStatus(current, match[1])
            : match[2] === "adb-ui" ? await readAdbUi(current, match[1])
            : match[2] === "adb-actions" ? (await requestAdbInput(current, match[1], input)).value : requestAction(current, match[1], input).value;
        }
        return { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof HttpError ? err.message : "设备请求未完成" }) }], isError: true };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    // Close protocol state only once the HTTP response finishes or the client disconnects.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true; mcpWork--;
      void mcp.close();
    };
    res.once("close", cleanup);
    try {
      const input = await body(req);
      // One protocol message per HTTP request keeps concurrency and rate limits meaningful.
      if (Array.isArray(input)) throw new HttpError(400, "此 MCP 入口不接受批量请求");
      await mcp.connect(transport); await transport.handleRequest(req, res, input);
    }
    catch (err) { cleanup(); throw err; }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const requestedPath = new URL(req.url ?? "/", origin).pathname;
    const path = requestedPath === "/api/v1" ? "/api" : requestedPath.startsWith("/api/v1/") ? "/api/" + requestedPath.slice("/api/v1/".length) : requestedPath;
    const method = req.method ?? "GET";
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader("strict-transport-security", "max-age=31536000");
    if (options.serveStatic !== false && method === "GET" && staticFiles.has(path)) {
      const [file, type] = staticFiles.get(path)!;
      const content = await readFile(publicDir + file);
      res.writeHead(200, { "content-type": type }); res.end(content); return;
    }
    if (path === "/health" && method === "GET") return json(res, { ok: true, service: "meshmind-saas" });
    if (path === "/.well-known/meshmind.json" && method === "GET") return json(res, discovery(origin));
    if (path === "/api/openapi.json" && method === "GET") return json(res, apiContract);
    if (path === "/favicon.ico" && method === "GET") { res.writeHead(204); res.end(); return; }
    if (path === "/api/auth/providers" && method === "GET") return json(res, { google: !!google });
    if (path === "/api/session" && method === "GET" && !req.headers.authorization && !/(?:^|;\s*)meshmind_session=/.test(req.headers.cookie ?? ""))
      return json(res, { authenticated: false });

    if (path === "/mcp") return handleMcp(req, res);

    // No cross-origin state changes through cookies, including login CSRF.
    if (!["GET", "HEAD"].includes(method) && !req.headers.authorization && req.headers.origin !== origin)
      throw new HttpError(403, "请求来源不允许");
    const ip = req.socket.remoteAddress ?? "unknown";
    if (path === "/api/auth/google" && method === "GET") {
      if (!google) throw new HttpError(503, "管理员尚未启用 Google 登录");
      limiter.check("google-start:" + ip, 20, 5 * 60_000);
      res.writeHead(303, { location: google.begin(req, res) }); res.end(); return;
    }
    if (path === "/api/auth/google/callback" && method === "GET") {
      if (!google) throw new HttpError(503, "管理员尚未启用 Google 登录");
      limiter.check("google-callback:" + ip, 60, 5 * 60_000);
      try {
        const result = await google.finish(req, res, new URL(req.url!, origin).searchParams);
        session(res, result.accountId);
        res.writeHead(303, { location: result.linked ? "/?auth_success=google_linked" : "/" }); res.end();
      } catch (err) {
        const code = err instanceof GoogleLoginError ? err.code : "google_failed";
        res.writeHead(303, { location: "/?auth_error=" + code }); res.end();
      }
      return;
    }
    if (path === "/api/register" || path === "/api/login") {
      if (method !== "POST") throw new HttpError(405, "方法不支持");
      limiter.check("auth-ip:" + ip, 100, 15 * 60_000);
      const input = validate(credentials, await body(req));
      limiter.check("auth-account:" + hash(input.email), 12, 15 * 60_000);
      if (path === "/api/register") {
        if (!options.allowSignup) throw new HttpError(403, "当前部署尚未开放注册");
        const encoded = await passwordJob(() => passwordHash(input.password));
        const tenant = id("acct_");
        try { store.db.prepare("INSERT INTO accounts(id,email,password,created_at) VALUES(?,?,?,?)").run(tenant, input.email, encoded, Date.now()); }
        catch (err) { if ((err as Error).message.includes("UNIQUE")) throw new HttpError(409, "该邮箱已注册"); throw err; }
        session(res, tenant); store.audit(tenant, tenant, "account.created", tenant, "ok");
        return json(res, { ok: true }, 201);
      }
      const account = store.db.prepare("SELECT * FROM accounts WHERE email=?").get(input.email) as { id: string; password: string } | undefined;
      const valid = await passwordJob(() => passwordMatches(input.password, account?.password ?? "00000000000000000000000000000000:" + "00".repeat(64)));
      if (!account || !valid) throw new HttpError(401, "邮箱或密码不正确");
      session(res, account.id); return json(res, { ok: true });
    }

    if (path === "/api/gateways/enroll" && method === "POST") {
      limiter.check("enroll:" + ip, 30);
      const token = bearer(req);
      const input = validate(z.object({ publicKey: z.string().max(500) }).strict(), await body(req));
      try { if (createPublicKey(input.publicKey).asymmetricKeyType !== "ed25519") throw new Error(); }
      catch { throw new HttpError(400, "需要 Ed25519 公钥"); }
      const tokenHash = token ? hash(token) : "";
      const persistentToken = secret("gw_");
      const gateway = store.transaction(() => {
        const row = store.db.prepare("SELECT id,tenant_id FROM gateways WHERE enroll_hash=? AND enroll_expires>? AND revoked=0")
          .get(tokenHash, Date.now()) as { id: string; tenant_id: string } | undefined;
        if (!row) throw new HttpError(401, "入网文件已使用、到期或被撤销，请重新创建网关");
        store.db.prepare("UPDATE gateways SET enroll_hash=NULL,public_key=?,bearer_hash=? WHERE id=?")
          .run(input.publicKey, hash(persistentToken), row.id);
        store.audit(row.tenant_id, row.id, "gateway.enrolled", row.id, "ok");
        return row;
      });
      return json(res, { gatewayId: gateway.id, token: persistentToken });
    }

    limiter.check("api-ip:" + ip, 1200);
    const actor = authenticate(store, req);
    limiter.check("api-actor:" + actor.id, 300);
    if (path === "/api/auth/google/link" && method === "POST") {
      requireOwner(actor);
      if (!google) throw new HttpError(503, "管理员尚未启用 Google 登录");
      limiter.check("google-start:" + ip, 20, 5 * 60_000);
      return json(res, { url: google.begin(req, res, actor) });
    }
    if (path === "/api/session" && method === "GET") {
      const email = actor.owner ? (store.db.prepare("SELECT email FROM accounts WHERE id=?").get(actor.tenant) as { email: string }).email : undefined;
      const googleLinked = actor.owner && !!store.db.prepare("SELECT 1 FROM account_identities WHERE provider='google' AND account_id=?").get(actor.tenant);
      return json(res, { authenticated: true, owner: actor.owner, name: actor.owner ? email : actor.principal.name, kind: actor.owner ? "owner" : actor.principal.kind, googleLinked });
    }
    if (path === "/api/logout" && method === "POST") {
      requireOwner(actor);
      const cookie = /(?:^|;\s*)meshmind_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "")?.[1];
      if (cookie) store.db.prepare("DELETE FROM sessions WHERE hash=?").run(hash(cookie));
      res.setHeader("set-cookie", `meshmind_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`);
      return json(res, { ok: true });
    }
    if (path === "/api/gateways") {
      requireOwner(actor);
      if (method === "GET") {
        const rows = store.db.prepare("SELECT id,name,revoked,created_at,public_key IS NOT NULL AS enrolled FROM gateways WHERE tenant_id=? ORDER BY created_at DESC").all(actor.tenant);
        return json(res, { gateways: rows.map(g => ({ ...g, online: broker.online(String(g.id)) })) });
      }
      if (method === "POST") {
        const { name } = validate(nameInput, await body(req));
        const count = store.db.prepare("SELECT count(*) AS n FROM gateways WHERE tenant_id=? AND revoked=0").get(actor.tenant) as { n: number };
        if (count.n >= 32) throw new HttpError(429, "此版本每个设备空间最多支持 32 个有效网关");
        const gateway = id("gw_"); const token = secret("join_");
        store.db.prepare("INSERT INTO gateways(id,tenant_id,name,enroll_hash,enroll_expires,created_at) VALUES(?,?,?,?,?,?)")
          .run(gateway, actor.tenant, name, hash(token), Date.now() + 10 * 60_000, Date.now());
        store.audit(actor.tenant, actor.id, "gateway.created", gateway, "ok");
        return json(res, { gatewayId: gateway, enrollment: { hub: origin, token }, expiresInSeconds: 600 }, 201);
      }
    }
    const gatewayMatch = /^\/api\/gateways\/(gw_[a-f0-9]{24})$/.exec(path);
    if (gatewayMatch && method === "DELETE") {
      requireOwner(actor);
      const row = store.gateway(gatewayMatch[1]);
      if (!row || row.tenant_id !== actor.tenant) throw new HttpError(404, "网关不存在");
      store.db.prepare("UPDATE gateways SET revoked=1,enroll_hash=NULL,bearer_hash=NULL WHERE id=?").run(row.id);
      broker.revoke(row.id); store.audit(actor.tenant, actor.id, "gateway.revoked", row.id, "ok");
      return json(res, { ok: true });
    }
    if (path === "/api/devices" && method === "GET") {
      return json(res, listDevices(actor));
    }
    const deviceMatch = /^\/api\/devices\/(dev_[a-f0-9]{24})\/(state|status|device-status|actions|adb-status|adb-actions|adb-ui)$/.exec(path);
    if (deviceMatch) {
      const [, deviceId, route] = deviceMatch;
      if (route === "state" && method === "GET") return json(res, await readUnifiedStatus(actor, deviceId));
      if (route === "status" && method === "GET") {
        return json(res, await readStatus(actor, deviceId));
      }
      if (route === "device-status" && method === "GET") return json(res, await readDeviceStatus(actor, deviceId));
      if (route === "actions" && method === "POST") {
        const result = requestAction(actor, deviceId, await body(req));
        return json(res, result.value, result.status);
      }
      if (route === "adb-status" && method === "GET") return json(res, await readAdbStatus(actor, deviceId));
      if (route === "adb-ui" && method === "GET") return json(res, await readAdbUi(actor, deviceId));
      if (route === "adb-actions" && method === "POST") {
        const result = await requestAdbInput(actor, deviceId, await body(req));
        return json(res, result.value, result.status);
      }
    }
    if (path === "/api/principals") {
      requireOwner(actor);
      if (method === "GET") return json(res, { principals: store.db.prepare("SELECT id,name,kind,devices,permissions,expires_at,revoked FROM principals WHERE tenant_id=? ORDER BY created_at DESC").all(actor.tenant)
        .map(p => ({ ...p, devices: JSON.parse(String(p.devices)), permissions: JSON.parse(String(p.permissions)) })) });
      if (method === "POST") {
        const input = validate(principalInput, await body(req));
        const count = store.db.prepare("SELECT count(*) AS n FROM principals WHERE tenant_id=? AND revoked=0 AND expires_at>?").get(actor.tenant, Date.now()) as { n: number };
        if (count.n >= 128) throw new HttpError(429, "此版本最多支持 128 个有效共享凭证");
        for (const deviceId of input.devices) {
          const d = deviceFor(actor, deviceId, "status");
          if (input.permissions.some(p => !manifest(d).capabilities.includes(p))) throw new HttpError(400, "授权不能超过设备本地启用的能力");
        }
        const principal = id("pr_"); const token = secret("mm_"); const expiresAt = Date.now() + input.expiresInHours * 3600_000;
        store.db.prepare("INSERT INTO principals(id,tenant_id,name,kind,hash,devices,permissions,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(principal, actor.tenant, input.name, input.kind, hash(token), JSON.stringify([...new Set(input.devices)]), JSON.stringify([...new Set(input.permissions)]), expiresAt, Date.now());
        store.audit(actor.tenant, actor.id, "principal.created", principal, "ok");
        return json(res, { id: principal, token, expiresAt }, 201);
      }
    }
    const principalMatch = /^\/api\/principals\/(pr_[a-f0-9]{24})$/.exec(path);
    if (principalMatch && method === "DELETE") {
      requireOwner(actor);
      const p = store.principal(principalMatch[1]);
      if (!p || p.tenant_id !== actor.tenant) throw new HttpError(404, "凭证不存在");
      store.transaction(() => {
        store.db.prepare("UPDATE principals SET revoked=1 WHERE id=?").run(p.id);
        store.db.prepare("UPDATE approvals SET state='revoked' WHERE principal_id=? AND state='pending'").run(p.id);
      });
      store.audit(actor.tenant, actor.id, "principal.revoked", p.id, "ok"); return json(res, { ok: true });
    }
    if (path === "/api/approvals" && method === "GET") {
      return json(res, listApprovals(actor));
    }
    const approvalMatch = /^\/api\/approvals\/(ap_[a-f0-9]{24})\/(approve|reject)$/.exec(path);
    if (approvalMatch && method === "POST") {
      requireOwner(actor);
      const row = store.db.prepare("SELECT * FROM approvals WHERE id=? AND tenant_id=?").get(approvalMatch[1], actor.tenant) as ApprovalRow | undefined;
      if (!row) throw new HttpError(404, "审批不存在");
      if (row.state !== "pending" || row.expires_at <= Date.now()) throw new HttpError(409, "审批已处理或到期");
      if (approvalMatch[2] === "reject") {
        store.db.prepare("UPDATE approvals SET state='rejected' WHERE id=? AND state='pending'").run(row.id);
        store.audit(actor.tenant, actor.id, row.action, row.device_id, "rejected"); return json(res, { ok: true });
      }
      const p = store.principal(row.principal_id);
      if (!p || p.revoked || p.expires_at <= Date.now()) throw new HttpError(403, "请求者凭证已撤销或到期");
      const d = deviceFor({ tenant: p.tenant_id, id: p.id, owner: false, principal: p }, row.device_id, row.action);
      if (!broker.online(d.gateway_id)) throw new HttpError(503, "网关离线；没有排队执行此操作");
      store.db.prepare("UPDATE approvals SET state='executing' WHERE id=? AND state='pending'").run(row.id);
      store.audit(actor.tenant, actor.id, row.action, row.device_id, "approved");
      try {
        const payload = row.action === "adb_input" ? adbInput.parse(payloadFor(row)) : undefined;
        const result = validate(z.object({ delivery: z.enum(["published", "simulated", "executed"]), deviceAcknowledged: z.boolean() }).strict(), await broker.call(actor.tenant, d.gateway_id, d.local_id, row.action, payload));
        const state = result.deviceAcknowledged ? "completed" : "delivered";
        store.db.prepare("UPDATE approvals SET state=?,result=? WHERE id=?").run(state, JSON.stringify(result), row.id);
        store.audit(actor.tenant, actor.id, row.action, row.device_id, state);
        return json(res, { state, result });
      } catch (err) {
        // A timeout/disconnect cannot prove the printer did not execute a command.
        store.db.prepare("UPDATE approvals SET state='unknown',result=? WHERE id=?").run(JSON.stringify({ error: "执行结果未知，请检查设备；不会自动重试" }), row.id);
        store.audit(actor.tenant, actor.id, row.action, row.device_id, "unknown"); throw err;
      }
    }
    if (path === "/api/audit" && method === "GET") {
      requireOwner(actor);
      return json(res, { events: store.db.prepare("SELECT actor,action,resource,outcome,ts FROM audit WHERE tenant_id=? ORDER BY seq DESC LIMIT 100").all(actor.tenant) });
    }
    throw new HttpError(404, "接口不存在");
  }

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch(err => {
      if (res.headersSent) { res.destroy(); return; }
      json(res, { error: err instanceof HttpError ? err.message : "服务暂时无法处理请求" }, err instanceof HttpError ? err.status : 500);
    });
  };
  const server = options.tls ? https.createServer(options.tls, listener) : http.createServer(listener);
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 64;
  function authenticateGateway(request: {url: string; authorization?: string; origin?: string; ip: string}) {
    limiter.check("ws:" + request.ip, 60);
    const match = /^\/api\/gateways\/(gw_[a-f0-9]{24})\/connect$/.exec(new URL(request.url, origin).pathname);
    const row = match && store.gateway(match[1]), token = parseBearer(request.authorization);
    if (!row || row.revoked || !token || row.bearer_hash !== hash(token) || (request.origin && request.origin !== origin)) throw new HttpError(401, "unauthorized");
    return row;
  }
  server.on("upgrade", (req, socket, head) => {
    try {
      const row = authenticateGateway({url:req.url ?? "",authorization:req.headers.authorization,origin:req.headers.origin,ip:req.socket.remoteAddress ?? "unknown"});
      if (!wss) throw new HttpError(503, "外部网关传输未配置");
      wss.handleUpgrade(req, socket, head, ws => broker.connect(ws, row.id));
    } catch { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); }
  });
  return { server, store, broker, authenticateGateway, async close() {
    broker.close(); wss?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); store.close();
  } };
}

function approvalView(row: ApprovalRow, input?: unknown) {
  return { id: row.id, deviceId: row.device_id, principalId: row.principal_id, action: row.action,
    state: row.state, expiresAt: row.expires_at, createdAt: row.created_at, result: row.result ? JSON.parse(row.result) : null,
    ...(input === undefined ? {} : { input }) };
}
