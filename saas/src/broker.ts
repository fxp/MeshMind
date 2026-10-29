import { createPublicKey, verify, randomBytes } from "node:crypto";
export interface GatewaySocket {
  readonly readyState: number;
  on(event: "message", listener: (data: { toString(): string }) => void): unknown;
  on(event: "error", listener: () => void): unknown;
  on(event: "close", listener: (code?: number) => void): unknown;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}
import { z } from "zod";
import { Store } from "./store.ts";
import { id } from "./auth.ts";
import { deviceManifest, printerStatus, adbStatus, adbUi, genericStatus, gatewayLogFrame, HttpError, type PrinterStatus } from "./schema.ts";
import { safeErrorId, silentSystemLogger, type SystemLogger } from "./system-log.ts";

interface Connection { ws: GatewaySocket; tenant: string; gateway: string; verified: boolean; challenge: string; lastSeen: number; frameCount: number; frameWindow: number; logCount: number; logWindow: number; }
interface Pending { connection: Connection; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; action: string; startedAt: number; taskId: string; }

const registration = z.object({ kind: z.literal("register"), signature: z.string().max(200), manifestJson: z.string().max(32768) }).strict();
const result = z.object({ kind: z.literal("result"), taskId: z.string().max(80), ok: z.boolean(), value: z.unknown().optional(), error: z.string().max(200).optional() }).strict();

export class Broker {
  private connections = new Map<string, Connection>();
  private sockets = new Set<Connection>();
  private pending = new Map<string, Pending>();
  private ticker: NodeJS.Timeout;
  constructor(private store: Store, private logger: SystemLogger = silentSystemLogger) {
    this.ticker = setInterval(() => {
      const now = Date.now();
      for (const c of this.sockets) {
        const gateway = this.store.gateway(c.gateway);
        if (!gateway || gateway.revoked) c.ws.close(4001, "revoked");
        else if (now - c.lastSeen > (c.verified ? 30_000 : 10_000)) c.ws.close(4004, "heartbeat timeout");
      }
    }, 2000);
    this.ticker.unref();
  }

  connect(ws: GatewaySocket, gateway: string) {
    if ([...this.sockets].filter(c => c.gateway === gateway).length >= 3) {
      this.logger.event("warn", "gateway", "connection.rejected", { gatewayId: gateway, outcome: "too_many_connections" });
      ws.close(4008, "too many connections"); return;
    }
    const row = this.store.gateway(gateway);
    if (!row || row.revoked || !row.public_key) {
      this.logger.event("warn", "gateway", "connection.rejected", { gatewayId: gateway, outcome: "unauthorized" });
      ws.close(4001, "unauthorized"); return;
    }
    const c: Connection = { ws, tenant: row.tenant_id, gateway, verified: false, challenge: randomBytes(32).toString("base64url"), lastSeen: Date.now(), frameCount: 0, frameWindow: Date.now(), logCount: 0, logWindow: Date.now() };
    this.sockets.add(c);
    this.logger.event("info", "gateway", "connection.opened", { tenantId: c.tenant, gatewayId: gateway });
    ws.on("message", data => {
      try {
        if (Date.now() - c.frameWindow > 1000) { c.frameWindow = Date.now(); c.frameCount = 0; }
        if (++c.frameCount > 30) { ws.close(4008, "rate limited"); return; }
        this.message(c, JSON.parse(data.toString()));
      }
      catch (error) {
        // Never log frame contents: registration and task frames may carry sensitive data.
        this.logger.event("warn", "gateway", "frame.rejected", { tenantId: c.tenant, gatewayId: gateway, errorId: safeErrorId(error) });
        ws.close(4002, "invalid frame");
      }
    });
    ws.on("error", () => {
      this.logger.event("warn", "gateway", "connection.error", { tenantId: c.tenant, gatewayId: gateway });
      ws.close();
    });
    ws.on("close", code => {
      this.sockets.delete(c);
      if (this.connections.get(gateway) === c) this.connections.delete(gateway);
      this.logger.event("info", "gateway", "connection.closed", { tenantId: c.tenant, gatewayId: gateway, ...(code === undefined ? {} : { closeCode: code }) });
      for (const [task, p] of this.pending) if (p.connection === c) {
        clearTimeout(p.timer); this.pending.delete(task);
        this.logger.event("warn", "device", "task.interrupted", { tenantId: c.tenant, gatewayId: gateway, taskId: p.taskId, action: p.action, durationMs: Date.now() - p.startedAt });
        p.reject(new HttpError(503, "网关连接中断，未自动重试"));
      }
    });
    ws.send(JSON.stringify({ kind: "challenge", challenge: c.challenge, gatewayId: gateway }));
  }

  private message(c: Connection, raw: unknown) {
    if (!raw || typeof raw !== "object" || !("kind" in raw)) throw new Error("bad frame");
    if (this.store.gateway(c.gateway)?.revoked) { c.ws.close(4001, "revoked"); return; }
    if (raw.kind === "register") {
      if (c.verified) throw new Error("already registered");
      const msg = registration.parse(raw);
      const row = this.store.gateway(c.gateway)!;
      const key = createPublicKey(row.public_key!);
      if (!verify(null, Buffer.from(`${c.challenge}\n${c.gateway}\n${msg.manifestJson}`), key, Buffer.from(msg.signature, "base64"))) {
        c.ws.close(4003, "invalid signature"); return;
      }
      const devices = z.array(deviceManifest).min(1).max(32).parse(JSON.parse(msg.manifestJson));
      if (new Set(devices.map(d => d.localId)).size !== devices.length) throw new Error("duplicate device");
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE devices SET active=0 WHERE gateway_id=?").run(c.gateway);
        for (const manifest of devices) {
          this.store.db.prepare(`INSERT INTO devices(id,tenant_id,gateway_id,local_id,manifest) VALUES(?,?,?,?,?)
            ON CONFLICT(gateway_id,local_id) DO UPDATE SET manifest=excluded.manifest, active=1`)
            .run(id("dev_"), c.tenant, c.gateway, manifest.localId, JSON.stringify(manifest));
        }
      });
      const old = this.connections.get(c.gateway);
      c.verified = true; c.challenge = ""; c.lastSeen = Date.now();
      this.connections.set(c.gateway, c);
      if (old && old !== c) old.ws.close(4000, "replaced");
      this.store.audit(c.tenant, c.gateway, "gateway.connected", c.gateway, "verified");
      this.logger.event("info", "gateway", "connection.verified", { tenantId: c.tenant, gatewayId: c.gateway, deviceCount: devices.length });
      c.ws.send(JSON.stringify({ kind: "registered" }));
      return;
    }
    if (!c.verified || this.connections.get(c.gateway) !== c) throw new Error("registration required");
    if (raw.kind === "heartbeat") { c.lastSeen = Date.now(); return; }
    if (raw.kind === "log") {
      if (Date.now() - c.logWindow > 60_000) { c.logWindow = Date.now(); c.logCount = 0; }
      if (++c.logCount > 120) return;
      const msg = gatewayLogFrame.parse(raw);
      this.logger.event(msg.level, "local-gateway", msg.event, { tenantId: c.tenant, gatewayId: c.gateway, ...msg.fields });
      return;
    }
    if (raw.kind === "result") {
      const msg = result.parse(raw);
      const p = this.pending.get(msg.taskId);
      // Task ids alone are insufficient; results must come from the exact authenticated session.
      if (!p || p.connection !== c) return;
      clearTimeout(p.timer); this.pending.delete(msg.taskId);
      this.logger.event(msg.ok ? "info" : "warn", "device", "task.result", {
        tenantId: c.tenant, gatewayId: c.gateway, taskId: msg.taskId, action: p.action,
        outcome: msg.ok ? "completed" : "failed", durationMs: Date.now() - p.startedAt,
      });
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new HttpError(502, "设备操作失败；详情请在本地网关检查"));
      return;
    }
    throw new Error("unknown frame");
  }

  online(gateway: string) {
    const c = this.connections.get(gateway);
    return !!c && c.verified && c.ws.readyState === 1 && Date.now() - c.lastSeen < 30_000;
  }

  async call(tenant: string, gateway: string, localId: string, action: string, input?: unknown): Promise<unknown> {
    const c = this.connections.get(gateway);
    if (!c || c.tenant !== tenant || !this.online(gateway) || this.store.gateway(gateway)?.revoked) throw new HttpError(503, "网关离线，请在设备所在网络启动网关");
    if ([...this.pending.values()].filter(p => p.connection === c).length >= 8) throw new HttpError(429, "网关任务过多");
    const taskId = id("task_");
    const startedAt = Date.now();
    this.logger.event("info", "device", "task.dispatched", { tenantId: tenant, gatewayId: gateway, taskId, action });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(taskId);
        this.logger.event("warn", "device", "task.timeout", { tenantId: tenant, gatewayId: gateway, taskId, action, durationMs: Date.now() - startedAt });
        reject(new HttpError(504, "设备响应超时；不会自动重试"));
      }, 12_000);
      this.pending.set(taskId, { connection: c, resolve, reject, timer, action, startedAt, taskId });
      c.ws.send(JSON.stringify({ kind: "task", taskId, localId, action, ...(input === undefined ? {} : { input }), expiresAt: Date.now() + 10_000 }), err => {
        if (err && this.pending.has(taskId)) {
          clearTimeout(timer); this.pending.delete(taskId);
          this.logger.event("warn", "device", "task.send_failed", { tenantId: tenant, gatewayId: gateway, taskId, action, errorId: safeErrorId(err) });
          reject(new HttpError(503, "无法发送到网关"));
        }
      });
    });
  }

  async status(tenant: string, gateway: string, localId: string): Promise<PrinterStatus> {
    const status = printerStatus.parse(await this.call(tenant, gateway, localId, "status"));
    if (status.observedAt > Date.now() + 5000) throw new HttpError(502, "网关报告的时间无效");
    return status;
  }
  async androidStatus(tenant: string, gateway: string, localId: string) {
    const status = adbStatus.parse(await this.call(tenant, gateway, localId, "status"));
    if (status.observedAt > Date.now() + 5000) throw new HttpError(502, "网关报告的时间无效");
    return status;
  }
  async androidUi(tenant: string, gateway: string, localId: string) {
    const ui = adbUi.parse(await this.call(tenant, gateway, localId, "adb_ui"));
    if (ui.observedAt > Date.now() + 5000) throw new HttpError(502, "网关报告的时间无效");
    return ui;
  }
  async deviceStatus(tenant: string, gateway: string, localId: string) {
    const status = genericStatus.parse(await this.call(tenant, gateway, localId, "status"));
    if (status.observedAt > Date.now() + 5000) throw new HttpError(502, "网关报告的时间无效");
    return status;
  }
  revoke(gateway: string) { for (const c of this.sockets) if (c.gateway === gateway) c.ws.close(4001, "revoked"); }
  close() { clearInterval(this.ticker); for (const c of this.sockets) c.ws.terminate(); }
}
