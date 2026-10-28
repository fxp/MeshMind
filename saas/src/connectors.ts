import { createReadStream, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { ConnectionOptions } from "node:tls";
import mqtt from "mqtt";
import { z } from "zod";
import { deviceManifest, printerStatus, genericStatus, deviceActionResult, type DeviceManifest, type PrinterStatus, type ControlAction, type AdbInput, type DeviceActionInput } from "./schema.ts";
import { adbDevice } from "./adb.ts";

const actionName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const actionDescription = z.string().trim().min(1).max(120);
const fixedPath = z.string().min(1).max(240).regex(/^\/(?!\/)[^?#]*$/).refine(value => !value.split("/").includes(".."), "路径不能包含 ..");
const serialAction = z.object({
  name: actionName, description: actionDescription, command: z.string().min(1).max(256).refine(value => !/[\r\n\0]/.test(value), "串口命令不能包含换行或 NUL"),
  destructive: z.boolean().default(true),
}).strict();
const httpAction = z.object({
  name: actionName, description: actionDescription, method: z.enum(["POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  path: fixedPath, body: z.json().optional(), destructive: z.boolean().default(true),
}).strict();

export const connectorConfig = deviceManifest.omit({ capabilities: true, actions: true }).extend({
  allowControl: z.boolean().default(false),
  host: z.string().max(253).optional(),
  serial: z.string().regex(/^[A-Za-z0-9_-]{4,40}$/).optional(),
  accessCode: z.string().min(6).max(64).optional(),
  caFile: z.string().min(1).optional(),
  adbSerial: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(),
  adbPath: z.string().min(1).max(512).optional(),
  allowUiDump: z.boolean().default(false),
  serialPort: z.string().regex(/^\/dev\/cu\.[A-Za-z0-9._-]+$/).optional(),
  baudRate: z.number().int().min(1200).max(921600).optional(),
  serialActions: z.array(serialAction).max(16).optional(),
  haUrl: z.string().url().max(512).optional(),
  haToken: z.string().min(8).max(512).optional(),
  haEntityId: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/).optional(),
  httpUrl: z.string().url().max(512).optional(),
  httpStatusPath: fixedPath.optional(),
  httpToken: z.string().min(8).max(512).optional(),
  httpActions: z.array(httpAction).max(16).optional(),
}).strict().superRefine((d, ctx) => {
  if (d.connector === "bambu" && (!d.host || !d.serial || !d.accessCode || !d.caFile))
    ctx.addIssue({ code: "custom", message: "真实拓竹连接需要 host、serial、accessCode 和 caFile" });
  if (d.connector === "adb" && !d.adbSerial)
    ctx.addIssue({ code: "custom", message: "ADB 连接需要明确指定 adbSerial" });
  if (["esp32_serial", "usb_serial"].includes(d.connector) && (!d.serialPort || !d.baudRate))
    ctx.addIssue({ code: "custom", message: "USB 串口需要设备路径和波特率" });
  if (d.serialActions && new Set(d.serialActions.map(action => action.name)).size !== d.serialActions.length)
    ctx.addIssue({ code: "custom", message: "串口操作名称不能重复" });
  if (d.connector === "home_assistant") {
    let validUrl = false;
    try { validUrl = !!d.haUrl && ["http:", "https:"].includes(new URL(d.haUrl).protocol); } catch { /* Invalid URL. */ }
    if (!validUrl || !d.haToken || !d.haEntityId)
      ctx.addIssue({ code: "custom", message: "Home Assistant 需要 HTTP(S) 地址、访问令牌和实体 ID" });
  }
  if (d.connector === "local_http") {
    let validUrl = false;
    try {
      const url = new URL(d.httpUrl ?? "");
      validUrl = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch { /* Invalid URL. */ }
    if (!validUrl || !d.httpStatusPath) ctx.addIssue({ code: "custom", message: "局域网 HTTP 设备需要 HTTP(S) 地址和固定状态路径" });
    if (d.httpActions && new Set(d.httpActions.map(action => action.name)).size !== d.httpActions.length)
      ctx.addIssue({ code: "custom", message: "HTTP 操作名称不能重复" });
  }
});
export type ConnectorConfig = z.infer<typeof connectorConfig>;
export interface Connector {
  manifest: DeviceManifest;
  status(): Promise<PrinterStatus | { state: "device"; model: string; androidVersion: string; observedAt: number } | z.infer<typeof genericStatus>>;
  ui?(): Promise<{ xml: string; observedAt: number }>;
  control(action: ControlAction | "adb_input" | "device_invoke", input?: AdbInput | DeviceActionInput): Promise<{ delivery: string; deviceAcknowledged: boolean; summary?: string }>;
  close(): void;
}

export function simulatedPrinter(config: ConnectorConfig): Connector {
  let state = "RUNNING";
  return {
    manifest: toManifest(config),
    async status() { return { state, progress: 42, remainingMinutes: 68, nozzleTemperature: state === "FINISH" ? 35 : 220, bedTemperature: 60, jobName: "MeshMind showcase.3mf", observedAt: Date.now() }; },
    async control(action) {
      if (!config.allowControl) throw new Error("本地策略禁止控制");
      state = action === "pause" ? "PAUSE" : action === "resume" ? "RUNNING" : "FINISH";
      return { delivery: "simulated", deviceAcknowledged: true };
    },
    close() {},
  };
}

function toManifest(c: ConnectorConfig): DeviceManifest {
  // No LAN address, access code, serial number, certificate or credentials leave the gateway.
  const actions = c.connector === "usb_serial" ? c.serialActions : c.connector === "local_http" ? c.httpActions : undefined;
  return { localId: c.localId, name: c.name, model: c.model, connector: c.connector,
    capabilities: c.connector === "adb" ? ["status", ...(c.allowUiDump ? ["adb_ui"] as const : []), ...(c.allowControl ? ["adb_input"] as const : [])]
      : ["esp32_serial", "usb_serial", "home_assistant", "local_http"].includes(c.connector)
        ? ["status", ...(actions?.length ? ["device_invoke"] as const : [])]
        : c.allowControl ? ["status", "pause", "resume", "stop"] : ["status"],
    ...(actions?.length ? { actions: actions.map(({ name, description, destructive }) => ({ name, description, destructive })) } : {}) };
}

async function boundedResponse(response: Response, limit = 65536) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("设备响应过大");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function homeAssistantDevice(config: ConnectorConfig): Connector {
  if (!config.haUrl || !config.haToken || !config.haEntityId) throw new Error("Home Assistant 配置不完整");
  const base = new URL(config.haUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new Error("Home Assistant 地址无效");
  const endpoint = new URL(`/api/states/${encodeURIComponent(config.haEntityId)}`, base);
  return {
    manifest: toManifest(config),
    async status() {
      const response = await fetch(endpoint, { redirect: "error", headers: { authorization: `Bearer ${config.haToken}`, accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("Home Assistant 状态不可用");
      const body = await response.json() as Record<string, unknown>;
      const attributes = body.attributes && typeof body.attributes === "object" && !Array.isArray(body.attributes) ? body.attributes as Record<string, unknown> : {};
      const raw = typeof body.state === "string" ? body.state : "unknown";
      return genericStatus.parse({ state: ["unknown", "unavailable"].includes(raw) ? raw : "online",
        value: raw.slice(0, 160), unit: typeof attributes.unit_of_measurement === "string" ? attributes.unit_of_measurement.slice(0, 32) : null, observedAt: Date.now() });
    },
    async control() { throw new Error("Home Assistant 控制尚未启用"); },
    close() {},
  };
}

export function esp32SerialDevice(config: ConnectorConfig): Connector {
  if (!config.serialPort || !config.baudRate) throw new Error("ESP32 串口配置不完整");
  execFileSync("/bin/stty", ["-f", config.serialPort, String(config.baudRate), "raw", "-echo"], { timeout: 3000, stdio: "ignore" });
  const stream = createReadStream(config.serialPort, { highWaterMark: 1024 });
  let pending = "", latest: z.infer<typeof genericStatus> | undefined;
  stream.on("data", chunk => {
    pending += chunk.toString("utf8");
    if (pending.length > 4096) pending = "";
    for (;;) {
      const end = pending.indexOf("\n"); if (end < 0) break;
      const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
      if (!line || line.length > 512) continue;
      try {
        const data = line.startsWith("{") ? JSON.parse(line) : { value: line };
        latest = genericStatus.parse({ state: typeof data.state === "string" ? data.state.slice(0, 40) : "online",
          value: data.value == null ? null : String(data.value).slice(0, 160),
          unit: typeof data.unit === "string" ? data.unit.slice(0, 32) : null, observedAt: Date.now() });
      } catch { /* Ignore invalid serial frames. */ }
    }
  });
  stream.on("error", () => { latest = undefined; });
  return {
    manifest: toManifest(config),
    async status() {
      if (!latest || Date.now() - latest.observedAt > 60_000) throw new Error("ESP32 串口尚未收到新鲜报告");
      return latest;
    },
    async control() { throw new Error("ESP32 串口写入尚未启用"); },
    close() { stream.destroy(); },
  };
}

export function usbSerialDevice(config: ConnectorConfig): Connector {
  const base = esp32SerialDevice(config);
  const actions = new Map((config.serialActions ?? []).map(action => [action.name, action]));
  return {
    ...base, manifest: toManifest(config),
    async control(kind, input) {
      if (kind !== "device_invoke" || !input || !("action" in input)) throw new Error("USB 串口操作无效");
      const action = actions.get(input.action);
      if (!action || !config.serialPort) throw new Error("USB 串口操作未在本机启用");
      const handle = await open(config.serialPort, "w");
      try { await handle.write(action.command + "\n", undefined, "utf8"); }
      finally { await handle.close(); }
      return deviceActionResult.parse({ delivery: "executed", deviceAcknowledged: true, summary: `已发送 ${action.name}` });
    },
  };
}

export function localHttpDevice(config: ConnectorConfig): Connector {
  if (!config.httpUrl || !config.httpStatusPath) throw new Error("局域网 HTTP 设备配置不完整");
  const base = new URL(config.httpUrl);
  const actions = new Map((config.httpActions ?? []).map(action => [action.name, action]));
  const headers = () => ({ accept: "application/json, text/plain;q=0.8", ...(config.httpToken ? { authorization: `Bearer ${config.httpToken}` } : {}) });
  return {
    manifest: toManifest(config),
    async status() {
      const response = await fetch(new URL(config.httpStatusPath!, base), { redirect: "error", headers: headers(), signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("局域网设备状态不可用");
      const text = await boundedResponse(response);
      let value: unknown = text;
      try { value = JSON.parse(text); } catch { /* Plain text status. */ }
      const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      return genericStatus.parse({
        state: typeof object.state === "string" ? object.state.slice(0, 40) : "online",
        value: typeof object.value === "string" || typeof object.value === "number" || typeof object.value === "boolean"
          ? String(object.value).slice(0, 160) : String(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 160),
        unit: typeof object.unit === "string" ? object.unit.slice(0, 32) : null,
        observedAt: Date.now(),
      });
    },
    async control(kind, input) {
      if (kind !== "device_invoke" || !input || !("action" in input)) throw new Error("局域网设备操作无效");
      const action = actions.get(input.action);
      if (!action) throw new Error("局域网设备操作未在本机启用");
      const response = await fetch(new URL(action.path, base), { method: action.method, redirect: "error",
        headers: { ...headers(), ...(action.body === undefined ? {} : { "content-type": "application/json" }) },
        body: action.body === undefined ? undefined : JSON.stringify(action.body), signal: AbortSignal.timeout(8_000) });
      const reply = await boundedResponse(response);
      if (!response.ok) throw new Error("局域网设备拒绝操作");
      return deviceActionResult.parse({ delivery: "executed", deviceAcknowledged: true,
        summary: reply.trim() ? reply.trim().slice(0, 160) : `已执行 ${action.name}` });
    },
    close() {},
  };
}

export { adbDevice };
export { toManifest };

const numberOrNull = (v: unknown, min: number, max: number): number | null => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
export function normalizeReport(report: Record<string, unknown>, previous?: PrinterStatus): PrinterStatus {
  return printerStatus.parse({
    state: typeof report.gcode_state === "string" ? report.gcode_state.slice(0, 40) : previous?.state ?? "UNKNOWN",
    progress: report.mc_percent === undefined ? previous?.progress ?? null : numberOrNull(report.mc_percent, 0, 100),
    remainingMinutes: report.mc_remaining_time === undefined ? previous?.remainingMinutes ?? null : numberOrNull(report.mc_remaining_time, 0, 100000),
    nozzleTemperature: report.nozzle_temper === undefined ? previous?.nozzleTemperature ?? null : numberOrNull(report.nozzle_temper, -50, 500),
    bedTemperature: report.bed_temper === undefined ? previous?.bedTemperature ?? null : numberOrNull(report.bed_temper, -50, 250),
    jobName: typeof report.subtask_name === "string" ? report.subtask_name.slice(0, 160) : previous?.jobName ?? null,
    observedAt: Date.now(),
  });
}

export function bambuPrinter(config: ConnectorConfig): Connector {
  if (!config.caFile || !config.host || !config.serial || !config.accessCode) throw new Error("缺少打印机本地连接配置");
  const certificate = readFileSync(config.caFile);
  const pinned = new X509Certificate(certificate).fingerprint256;
  // A locally pinned certificate is mandatory. Never disable certificate verification.
  const tlsOptions = {
    ca: certificate, rejectUnauthorized: true,
    checkServerIdentity: (_host, cert) => cert.fingerprint256 === pinned ? undefined : new Error("打印机证书与本地固定证书不一致"),
  } satisfies ConnectionOptions;
  const client = mqtt.connect({
    protocol: "mqtts", hostname: config.host, port: 8883,
    username: "bblp", password: config.accessCode,
    ...tlsOptions,
    reconnectPeriod: 5000, connectTimeout: 8000, resubscribe: true, clean: true,
  });
  let latest: PrinterStatus | undefined;
  let connected = false;
  let sequence = 0;
  const requestTopic = `device/${config.serial}/request`;
  const reportTopic = `device/${config.serial}/report`;
  const requestStatus = () => { if (connected) client.publish(requestTopic, JSON.stringify({ pushing: { sequence_id: String(++sequence), command: "pushall" } }), { qos: 0 }); };
  client.on("connect", () => {
    connected = true;
    client.subscribe(reportTopic, { qos: 0 }, err => {
      if (!err) requestStatus();
    });
  });
  client.on("close", () => { connected = false; });
  // Do not log MQTT error objects: broker URLs or credentials may be included.
  client.on("error", () => { connected = false; });
  client.on("message", (topic, bytes) => {
    if (topic !== reportTopic || bytes.length > 262144) return;
    try {
      const message = JSON.parse(bytes.toString());
      if (message.print && typeof message.print === "object" && !Array.isArray(message.print) &&
          ["gcode_state", "mc_percent", "mc_remaining_time", "nozzle_temper", "bed_temper", "subtask_name"].some(k => k in message.print))
        latest = normalizeReport(message.print, latest);
    } catch { /* Ignore malformed LAN reports. */ }
  });
  const polling = setInterval(requestStatus, 30_000);
  polling.unref();
  return {
    manifest: toManifest(config),
    async status() {
      if (!connected || !latest) throw new Error("尚未收到打印机状态，请检查 LAN 模式、证书及访问码");
      return latest;
    },
    async control(action) {
      if (!config.allowControl) throw new Error("本地策略禁止控制");
      if (!connected || !latest || Date.now() - latest.observedAt > 60_000) throw new Error("打印机状态过期，拒绝控制");
      await new Promise<void>((resolve, reject) => client.publish(requestTopic,
        JSON.stringify({ print: { sequence_id: String(++sequence), command: action } }), { qos: 0 }, err => err ? reject(err) : resolve()));
      // MQTT publication is not proof that the printer executed an operation.
      return { delivery: "published", deviceAcknowledged: false };
    },
    close() { clearInterval(polling); client.end(true); },
  };
}
