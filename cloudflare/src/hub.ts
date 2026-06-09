// Hub Durable Object —— MeshMind 控制平面的核心。
// 职责：持有所有设备 WS 连接（Hibernation）、注册表、入网、编排、离线信箱、ed25519 验签。
import { verifyEd25519, randomToken } from "./crypto.ts";
import { rulePlan, type DeviceInfo, type PlannedTask, type TaskRequest } from "./planner.ts";

interface Env {
  HUB: DurableObjectNamespace;
}

interface PendingEnroll {
  caps: string[];
  name: string;
  exp: number;
  used: boolean;
}

interface DeviceRecord {
  deviceId: string;
  pubkey: string;
  caps: string[];
  manifest?: DeviceInfo;
  lastSeen: number;
}

const HEARTBEAT_STALE_MS = 12_000;

export class Hub {
  // 进行中的任务等待者（在单次 /goal 请求生命周期内有效，DO 不会中途休眠）
  private pending = new Map<string, (r: TaskResult) => void>();

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  // ---- 路由（Worker 把所有请求转发到这里）----
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/admin/enroll/new" && req.method === "POST") return this.enrollNew(req, url);
      if (path === "/enroll" && req.method === "POST") return this.enroll(req, url);
      if (path === "/goal" && req.method === "POST") return this.runGoal(req);
      if (path === "/devices") return this.devicesJson();
      if (path.startsWith("/agent/")) return this.connectAgent(req, decodeURIComponent(path.slice(7)));
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  }

  // ---- 入网：签发一次性令牌 ----
  private async enrollNew(req: Request, url: URL): Promise<Response> {
    const { name, caps } = (await req.json()) as { name: string; caps: string[] };
    if (!name) return Response.json({ ok: false, error: "缺少 name" }, { status: 400 });
    const secret = randomToken(24);
    const exp = Date.now() + 60 * 60 * 1000;
    await this.state.storage.put<PendingEnroll>(`pending:${secret}`, {
      caps: caps ?? ["shell", "fs"],
      name,
      exp,
      used: false,
    });
    const httpBase = `${url.protocol}//${url.host}`;
    const token = {
      enroll_url: `${httpBase}/enroll`,
      enroll_secret: secret,
      granted_caps: caps ?? ["shell", "fs"],
      name_hint: name,
      expires_at: new Date(exp).toISOString(),
      ts_authkey: "", // CF 版不需要
    };
    return Response.json({ ok: true, token, encoded: btoa(JSON.stringify(token)) });
  }

  // ---- 入网：设备兑换令牌 ----
  private async enroll(req: Request, url: URL): Promise<Response> {
    const body = (await req.json()) as {
      enroll_secret: string;
      public_key: string;
      manifest: { device_id: string };
    };
    const p = await this.state.storage.get<PendingEnroll>(`pending:${body.enroll_secret}`);
    if (!p) return Response.json({ ok: false, error: "未知或已失效的 enroll_secret" }, { status: 403 });
    if (p.used) return Response.json({ ok: false, error: "令牌已被使用" }, { status: 403 });
    if (Date.now() > p.exp) return Response.json({ ok: false, error: "令牌已过期" }, { status: 403 });

    p.used = true;
    await this.state.storage.put(`pending:${body.enroll_secret}`, p);

    const deviceId = p.name || body.manifest?.device_id;
    const bearer = randomToken(32);
    await this.state.storage.put(`bearer:${bearer}`, deviceId);
    await this.state.storage.put<DeviceRecord>(`device:${deviceId}`, {
      deviceId,
      pubkey: body.public_key,
      caps: p.caps,
      lastSeen: 0,
    });

    const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
    return Response.json({
      ok: true,
      device_id: deviceId,
      ws_url: `${wsScheme}//${url.host}/agent/${encodeURIComponent(deviceId)}`,
      bearer,
      granted_caps: p.caps,
    });
  }

  // ---- WebSocket：设备连接（Hibernation）----
  private async connectAgent(req: Request, deviceId: string): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const url = new URL(req.url);
    const token = url.searchParams.get("token") ?? req.headers.get("x-meshmind-bearer") ?? "";
    const owner = await this.state.storage.get<string>(`bearer:${token}`);
    if (!owner || owner !== deviceId) {
      return new Response("unauthorized", { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernation：用 tag=deviceId，便于 getWebSockets(deviceId) 定向发送
    this.state.acceptWebSocket(server, [deviceId]);
    server.serializeAttachment({ deviceId });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- WS 消息处理（Hibernation 回调）----
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = (ws.deserializeAttachment() ?? {}) as { deviceId?: string };
    const deviceId = att.deviceId ?? "?";
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    switch (msg.kind) {
      case "register": {
        const ok = await this.onRegister(deviceId, msg.manifest_json as string, msg.sig as string);
        ws.send(JSON.stringify({ kind: "register_ack", ok: ok.ok, verified: ok.verified, error: ok.error }));
        if (ok.ok) await this.flushMailbox(deviceId, ws);
        break;
      }
      case "heartbeat":
        await this.touch(deviceId);
        break;
      case "result": {
        const w = this.pending.get(msg.task_id as string);
        if (w) {
          this.pending.delete(msg.task_id as string);
          w(msg as unknown as TaskResult);
        }
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = (ws.deserializeAttachment() ?? {}) as { deviceId?: string };
    if (att.deviceId) {
      const rec = await this.state.storage.get<DeviceRecord>(`device:${att.deviceId}`);
      if (rec) {
        rec.lastSeen = 0; // 标记离线
        await this.state.storage.put(`device:${att.deviceId}`, rec);
      }
    }
  }

  // ---- 注册：验签 ----
  private async onRegister(
    deviceId: string,
    manifestJson: string,
    sig: string,
  ): Promise<{ ok: boolean; verified: boolean; error?: string }> {
    const rec = await this.state.storage.get<DeviceRecord>(`device:${deviceId}`);
    if (!rec) return { ok: false, verified: false, error: "设备未入网" };
    const verified = await verifyEd25519(rec.pubkey, manifestJson, sig);
    if (!verified) return { ok: false, verified: false, error: "签名验证失败" };
    rec.manifest = { ...(JSON.parse(manifestJson) as DeviceInfo), status: "online" };
    rec.lastSeen = Date.now();
    await this.state.storage.put(`device:${deviceId}`, rec);
    return { ok: true, verified: true };
  }

  private async touch(deviceId: string): Promise<void> {
    const rec = await this.state.storage.get<DeviceRecord>(`device:${deviceId}`);
    if (rec) {
      rec.lastSeen = Date.now();
      await this.state.storage.put(`device:${deviceId}`, rec);
    }
  }

  // ---- 设备列表 ----
  private async listDevices(): Promise<DeviceInfo[]> {
    const map = await this.state.storage.list<DeviceRecord>({ prefix: "device:" });
    const now = Date.now();
    const out: DeviceInfo[] = [];
    for (const rec of map.values()) {
      const online = now - rec.lastSeen < HEARTBEAT_STALE_MS && this.state.getWebSockets(rec.deviceId).length > 0;
      const m = rec.manifest;
      out.push({
        deviceId: rec.deviceId,
        os: m?.os ?? "?",
        arch: m?.arch ?? "?",
        status: online ? "online" : "offline",
        capabilities: m?.capabilities ?? {
          shell: { allow: [], deny_destructive: true },
          fs: { read: [], write: [] },
          gpu: { available: false },
          sensors: [],
        },
      });
    }
    return out;
  }

  private async devicesJson(): Promise<Response> {
    return Response.json({ devices: await this.listDevices() });
  }

  // ---- 编排：规划 → 并行下发 → 汇聚 ----
  private async runGoal(req: Request): Promise<Response> {
    const { goal } = (await req.json()) as { goal: string };
    const devices = await this.listDevices();
    let plan: PlannedTask[];
    try {
      plan = rulePlan(goal, devices);
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
    }
    const outcomes = await Promise.all(plan.map((p) => this.dispatch(p)));
    const succeeded = outcomes.filter((o) => o.ok).length;
    return Response.json({
      ok: true,
      goal,
      planner: "rule",
      dispatched: outcomes.length,
      succeeded,
      failed: outcomes.length - succeeded,
      outcomes,
    });
  }

  private async dispatch(p: PlannedTask): Promise<Outcome> {
    const sockets = this.state.getWebSockets(p.deviceId);
    if (sockets.length === 0) {
      await this.enqueueMailbox(p.deviceId, p.task);
      return { deviceId: p.deviceId, rationale: p.rationale, ok: false, error: "设备离线 → 已入信箱", queued: true, took_ms: 0 };
    }
    const ws = sockets[0];
    const result = await new Promise<TaskResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(p.task.task_id);
        resolve({ task_id: p.task.task_id, ok: false, error: "timeout", took_ms: (p.task.deadline_sec + 5) * 1000 });
      }, (p.task.deadline_sec + 5) * 1000);
      this.pending.set(p.task.task_id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      ws.send(JSON.stringify({ kind: "task", ...p.task }));
    });
    return {
      deviceId: p.deviceId,
      rationale: p.rationale,
      ok: result.ok,
      result: result.result,
      error: result.error ?? null,
      took_ms: result.took_ms ?? 0,
    };
  }

  // ---- 离线信箱 ----
  private async enqueueMailbox(deviceId: string, task: TaskRequest): Promise<void> {
    const key = `mailbox:${deviceId}`;
    const box = (await this.state.storage.get<TaskRequest[]>(key)) ?? [];
    box.push(task);
    await this.state.storage.put(key, box);
  }

  private async flushMailbox(deviceId: string, ws: WebSocket): Promise<void> {
    const key = `mailbox:${deviceId}`;
    const box = await this.state.storage.get<TaskRequest[]>(key);
    if (!box || box.length === 0) return;
    for (const task of box) ws.send(JSON.stringify({ kind: "task", ...task }));
    await this.state.storage.delete(key);
  }
}

interface TaskResult {
  task_id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string | null;
  took_ms?: number;
}

interface Outcome {
  deviceId: string;
  rationale?: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error: string | null;
  took_ms: number;
  queued?: boolean;
}
