import { z } from "zod";

export const MAX_ADB_UI_XML_BYTES = 32768;

export const controlAction = z.enum(["pause", "resume", "stop"]);
export type ControlAction = z.infer<typeof controlAction>;
export const permission = z.enum(["status", "pause", "resume", "stop", "adb_input", "adb_ui", "device_invoke"]);
export const deviceActionName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
export const deviceAction = z.object({
  name: deviceActionName,
  description: z.string().trim().min(1).max(120),
  destructive: z.boolean(),
}).strict();
export const deviceActionInput = z.object({ action: deviceActionName }).strict();
export type DeviceActionInput = z.infer<typeof deviceActionInput>;
export const adbInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tap"), x: z.number().int().min(0).max(10000), y: z.number().int().min(0).max(10000) }).strict(),
  z.object({ kind: z.literal("swipe"), x1: z.number().int().min(0).max(10000), y1: z.number().int().min(0).max(10000), x2: z.number().int().min(0).max(10000), y2: z.number().int().min(0).max(10000), durationMs: z.number().int().min(100).max(2000) }).strict(),
  z.object({ kind: z.literal("keyevent"), key: z.enum(["HOME", "BACK", "ENTER", "APP_SWITCH", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER"]) }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(120).regex(/^[A-Za-z0-9 ._@-]+$/, "只允许英文、数字、空格和 ._@-") }).strict(),
]);
export type AdbInput = z.infer<typeof adbInput>;
export const localId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const deviceManifest = z.object({
  localId,
  name: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(80),
  connector: z.enum(["bambu", "simulator", "adb", "esp32_serial", "usb_serial", "home_assistant", "local_http"]),
  capabilities: z.array(permission).min(1).max(7),
  actions: z.array(deviceAction).max(16).optional(),
}).strict();
export type DeviceManifest = z.infer<typeof deviceManifest>;

export const printerStatus = z.object({
  state: z.string().max(40),
  progress: z.number().min(0).max(100).nullable(),
  remainingMinutes: z.number().min(0).max(100000).nullable(),
  nozzleTemperature: z.number().min(-50).max(500).nullable(),
  bedTemperature: z.number().min(-50).max(250).nullable(),
  jobName: z.string().max(160).nullable(),
  observedAt: z.number().int().positive(),
}).strict();
export type PrinterStatus = z.infer<typeof printerStatus>;
export const adbStatus = z.object({ state: z.literal("device"), model: z.string().max(80), androidVersion: z.string().max(40), observedAt: z.number().int().positive() }).strict();
export const adbUi = z.object({ xml: z.string().min(1).max(MAX_ADB_UI_XML_BYTES), observedAt: z.number().int().positive() }).strict();
export const genericStatus = z.object({
  state: z.string().min(1).max(40),
  value: z.string().max(160).nullable(),
  unit: z.string().max(32).nullable(),
  observedAt: z.number().int().positive(),
}).strict();
export const deviceActionResult = z.object({
  delivery: z.enum(["executed", "published"]),
  deviceAcknowledged: z.boolean(),
  summary: z.string().max(160).optional(),
}).strict();

export const gatewayLogEvent = z.enum([
  "gateway.ready",
  "gateway.stopping",
  "device.task.started",
  "device.task.completed",
  "device.task.failed",
  "device.task.denied",
]);
export const gatewayLogFrame = z.object({
  kind: z.literal("log"),
  level: z.enum(["info", "warn", "error"]),
  event: gatewayLogEvent,
  fields: z.object({
    connector: z.enum(["bambu", "simulator", "adb", "esp32_serial", "usb_serial", "home_assistant", "local_http"]).optional(),
    action: z.enum(["status", "pause", "resume", "stop", "adb_input", "adb_ui", "device_invoke"]).optional(),
    outcome: z.enum(["started", "completed", "failed", "denied", "stopping"]).optional(),
    deviceCount: z.number().int().min(0).max(32).optional(),
    durationMs: z.number().int().min(0).max(120_000).optional(),
    errorId: z.string().regex(/^[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z0-9_-]{1,40})?$/).optional(),
  }).strict(),
}).strict();
export type GatewayLogFrame = z.infer<typeof gatewayLogFrame>;

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function validate<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, "输入无效：" + result.error.issues.map(i => i.path.join(".") + " " + i.message).join("；"));
  return result.data;
}
