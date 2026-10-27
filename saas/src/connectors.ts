import { createReadStream, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { ConnectionOptions } from "node:tls";
import mqtt from "mqtt";
import { z } from "zod";
import { deviceManifest, printerStatus, genericStatus, type DeviceManifest, type PrinterStatus, type ControlAction, type AdbInput } from "./schema.ts";
import { adbDevice } from "./adb.ts";

export const connectorConfig = deviceManifest.omit({ capabilities: true }).extend({
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
  haUrl: z.string().url().max(512).optional(),
  haToken: z.string().min(8).max(512).optional(),
  haEntityId: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/).optional(),
}).strict().superRefine((d, ctx) => {
  if (d.connector === "bambu" && (!d.host || !d.serial || !d.accessCode || !d.caFile))
    ctx.addIssue({ code: "custom", message: "真实拓竹连接需要 host、serial、accessCode 和 caFile" });
  if (d.connector === "adb" && !d.adbSerial)
    ctx.addIssue({ code: "custom", message: "ADB 连接需要明确指定 adbSerial" });
  if (d.connector === "esp32_serial" && (!d.serialPort || !d.baudRate))
    ctx.addIssue({ code: "custom", message: "ESP32 串口需要设备路径和波特率" });
  if (d.connector === "home_assistant") {
    let validUrl = false;
    try { validUrl = !!d.haUrl && ["http:", "https:"].includes(new URL(d.haUrl).protocol); } catch { /* Invalid URL. */ }
    if (!validUrl || !d.haToken || !d.haEntityId)
      ctx.addIssue({ code: "custom", message: "Home Assistant 需要 HTTP(S) 地址、访问令牌和实体 ID" });
  }
});
export type ConnectorConfig = z.infer<typeof connectorConfig>;
export interface Connector {
  manifest: DeviceManifest;
  status(): Promise<PrinterStatus | { state: "device"; model: string; androidVersion: string; observedAt: number } | z.infer<typeof genericStatus>>;
  ui?(): Promise<{ xml: string; observedAt: number }>;
  control(action: ControlAction | "adb_input", input?: AdbInput): Promise<{ delivery: string; deviceAcknowledged: boolean }>;
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
  return { localId: c.localId, name: c.name, model: c.model, connector: c.connector,
    capabilities: c.connector === "adb" ? ["status", ...(c.allowUiDump ? ["adb_ui"] as const : []), ...(c.allowControl ? ["adb_input"] as const : [])]
      : ["esp32_serial", "home_assistant"].includes(c.connector) ? ["status"]
      : c.allowControl ? ["status", "pause", "resume", "stop"] : ["status"] };
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
