import { generateKeyPairSync, sign, createPrivateKey } from "node:crypto";
import { readFile, writeFile, mkdir, chmod, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import { z } from "zod";
import { connectorConfig, simulatedPrinter, bambuPrinter, adbDevice, homeAssistantDevice, esp32SerialDevice, usbSerialDevice, localHttpDevice, type Connector } from "./connectors.ts";
import { adbInput, deviceActionInput } from "./schema.ts";
import { safeErrorId } from "./system-log.ts";

const gatewayState = z.object({ gatewayId: z.string(), token: z.string(), publicKey: z.string(), privateKey: z.string(), hub: z.string() }).strict();
const enrollment = z.object({ hub: z.string(), token: z.string() }).strict();
export const localConfig = z.object({ devices: z.array(connectorConfig).min(1).max(32) }).strict();
const task = z.object({ kind: z.literal("task"), taskId: z.string().max(80), localId: z.string().max(64),
  action: z.enum(["status", "pause", "resume", "stop", "adb_input", "adb_ui", "device_invoke"]),
  input: z.union([adbInput, deviceActionInput]).optional(), expiresAt: z.number().int() }).strict();

export function validateHub(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Hub 必须使用 HTTPS；仅本机联调可使用 HTTP");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Hub 地址无效");
  return url.origin;
}

async function savePrivate(filename: string, value: unknown) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, filename);
}

export async function startGateway(options: { stateFile: string; config: z.infer<typeof localConfig>; enrollment?: z.infer<typeof enrollment>; log?: (message: string) => void }) {
  const log = options.log ?? (() => {});
  let state: z.infer<typeof gatewayState>;
  try { state = gatewayState.parse(JSON.parse(await readFile(options.stateFile, "utf8"))); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("网关身份文件无法读取，拒绝自动覆盖");
    if (!options.enrollment) throw new Error("首次启动需要入网文件");
    const hub = validateHub(options.enrollment.hub);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const response = await fetch(hub + "/api/gateways/enroll", { method: "POST", redirect: "error",
      headers: { authorization: "Bearer " + options.enrollment.token, "content-type": "application/json" },
      body: JSON.stringify({ publicKey }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("入网失败：请检查入网文件是否已使用或到期");
    const reply = z.object({ gatewayId: z.string(), token: z.string() }).parse(await response.json());
    state = { ...reply, publicKey, privateKey, hub };
    await savePrivate(options.stateFile, state);
  }
  state.hub = validateHub(state.hub);
  await chmod(options.stateFile, 0o600);
  const privateKey = createPrivateKey(state.privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("网关密钥无效");
  if (new Set(options.config.devices.map(d => d.localId)).size !== options.config.devices.length) throw new Error("本地设备标识不能重复");
  const connectors = new Map<string, Connector>();
  for (const d of options.config.devices) connectors.set(d.localId,
    d.connector === "simulator" ? simulatedPrinter(d) : d.connector === "adb" ? adbDevice(d)
    : d.connector === "home_assistant" ? homeAssistantDevice(d) : d.connector === "esp32_serial" ? esp32SerialDevice(d)
    : d.connector === "usb_serial" ? usbSerialDevice(d) : d.connector === "local_http" ? localHttpDevice(d) : bambuPrinter(d));
  const manifestJson = JSON.stringify([...connectors.values()].map(d => d.manifest));
  let stopped = false; let retry = 1000; let connection: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let heartbeats: NodeJS.Timeout | undefined;
  const work = new Set<string>();
  const completed = new Map<string, unknown>();
  const connect = () => {
    if (stopped) return;
    const endpoint = state.hub.replace(/^http/, "ws") + `/api/gateways/${state.gatewayId}/connect`;
    const ws = new WebSocket(endpoint, { headers: { authorization: "Bearer " + state.token }, maxPayload: 65536, handshakeTimeout: 10_000 });
    connection = ws;
    let registered = false;
    const registrationTimeout = setTimeout(() => { if (!registered) ws.close(4004, "registration timeout"); }, 10_000);
    const send = (value: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
    const systemLog = (level: "info" | "warn" | "error", event: "gateway.ready" | "gateway.stopping" | "device.task.started" | "device.task.completed" | "device.task.failed" | "device.task.denied", fields: Record<string, unknown>) =>
      send({ kind: "log", level, event, fields });
    ws.on("message", async bytes => {
      try {
        const frame = JSON.parse(bytes.toString());
        if (frame.kind === "challenge" && !registered) {
          const msg = z.object({ kind: z.literal("challenge"), challenge: z.string().regex(/^[A-Za-z0-9_-]{40,60}$/), gatewayId: z.literal(state.gatewayId) }).strict().parse(frame);
          send({ kind: "register", manifestJson, signature: sign(null, Buffer.from(`${msg.challenge}\n${state.gatewayId}\n${manifestJson}`), privateKey).toString("base64") });
        } else if (frame.kind === "registered" && !registered) {
          registered = true; retry = 1000; clearTimeout(registrationTimeout);
          log("网关已连接；本地设备接口可供获授权的用户使用");
          systemLog("info", "gateway.ready", { deviceCount: connectors.size });
          heartbeats = setInterval(() => send({ kind: "heartbeat" }), 5000);
        } else if (frame.kind === "task" && registered) {
          const request = task.parse(frame);
          if (request.expiresAt <= Date.now() || request.expiresAt > Date.now() + 30_000) throw new Error("expired task");
          if (completed.has(request.taskId)) { send(completed.get(request.taskId)); return; }
          if (work.has(request.taskId)) return;
          const connector = connectors.get(request.localId);
          if (!connector || !connector.manifest.capabilities.includes(request.action) || work.size >= 8) {
            systemLog("warn", "device.task.denied", { connector: connector?.manifest.connector, action: request.action, outcome: "denied" });
            send({ kind: "result", taskId: request.taskId, ok: false, error: "local policy denied" }); return;
          }
          work.add(request.taskId);
          const taskStartedAt = Date.now();
          systemLog("info", "device.task.started", { connector: connector.manifest.connector, action: request.action, outcome: "started" });
          let result: unknown;
          try {
            const value = request.action === "status" ? await connector.status()
              : request.action === "adb_ui" ? await connector.ui?.() : await connector.control(request.action, request.input);
            result = { kind: "result", taskId: request.taskId, ok: true, value };
            systemLog("info", "device.task.completed", { connector: connector.manifest.connector, action: request.action, outcome: "completed", durationMs: Date.now() - taskStartedAt });
          } catch (error) {
            log(`设备操作失败（${request.action}，${safeErrorId(error)}）`);
            systemLog("error", "device.task.failed", { connector: connector.manifest.connector, action: request.action, outcome: "failed", durationMs: Date.now() - taskStartedAt, errorId: safeErrorId(error) });
            result = { kind: "result", taskId: request.taskId, ok: false, error: "local device unavailable" };
          }
          finally { work.delete(request.taskId); }
          if (Buffer.byteLength(JSON.stringify(result)) > 60_000)
            result = { kind: "result", taskId: request.taskId, ok: false, error: "result too large" };
          completed.set(request.taskId, result);
          if (completed.size > 1024) completed.delete(completed.keys().next().value!);
          send(result);
        }
      } catch { ws.close(4002, "invalid request"); }
    });
    ws.on("error", () => log("Hub 连接不可用，请检查网络与入网凭证"));
    ws.on("close", (code, reason) => {
      clearTimeout(registrationTimeout); clearInterval(heartbeats);
      if (stopped) return;
      log(`Hub 连接已关闭（代码 ${code}，原因 ${reason.toString().slice(0, 80)}），准备检查连接状态`);
      // Revocation or invalid identity must not become an endless reconnect storm.
      if ([4001, 4003].includes(code)) { log("网关身份已失效，请由所有者重新接入"); return; }
      reconnectTimer = setTimeout(connect, retry + Math.floor(Math.random() * 500)); retry = Math.min(30_000, retry * 2);
    });
  };
  connect();
  return { stop() {
    if (connection?.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ kind: "log", level: "info", event: "gateway.stopping", fields: { outcome: "stopping" } }));
    stopped = true; clearTimeout(reconnectTimer); clearInterval(heartbeats); connection?.terminate(); for (const c of connectors.values()) c.close();
  } };
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: "string" }, enroll: { type: "string" }, state: { type: "string" } } });
  if (!values.config) throw new Error("用法：npm run gateway -- --config gateway.json [--enroll enrollment.json] [--state data/gateway.json]");
  const configFile = resolve(values.config);
  const config = localConfig.parse(JSON.parse(await readFile(configFile, "utf8")));
  // Resolve certificate paths relative to the configuration file, not the current terminal.
  for (const d of config.devices) if (d.caFile) d.caFile = resolve(dirname(configFile), d.caFile);
  const gateway = await startGateway({ config, stateFile: resolve(values.state ?? "data/gateway.json"),
    enrollment: values.enroll ? enrollment.parse(JSON.parse(await readFile(resolve(values.enroll), "utf8"))) : undefined, log: console.log });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { gateway.stop(); process.exit(0); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error("网关启动失败。请检查本地配置、证书、Hub 地址和入网文件；不会输出设备密钥。"); process.exitCode = 1;
});
