export type SystemLogLevel = "debug" | "info" | "warn" | "error";

export type SystemLogFields = Partial<{
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  tenantId: string;
  actorId: string;
  gatewayId: string;
  deviceId: string;
  connector: string;
  action: string;
  outcome: string;
  taskId: string;
  deviceCount: number;
  errorId: string;
  closeCode: number;
}>;

export interface SystemLogEntry extends SystemLogFields {
  timestamp: string;
  level: SystemLogLevel;
  service: string;
  component: string;
  event: string;
}

export interface SystemLogger {
  event(level: SystemLogLevel, component: string, event: string, fields?: SystemLogFields): void;
}

const safeName = /^[a-z][a-z0-9_.-]{0,63}$/;
const safeString = /^[A-Za-z0-9_./:@ -]{1,160}$/;
const fieldNames = new Set<keyof SystemLogFields>([
  "requestId", "method", "route", "status", "durationMs", "tenantId", "actorId", "gatewayId", "deviceId",
  "connector", "action", "outcome", "taskId", "deviceCount", "errorId", "closeCode",
]);

function sanitizeFields(fields: SystemLogFields): SystemLogFields {
  const clean: SystemLogFields = {};
  for (const [rawName, value] of Object.entries(fields)) {
    const name = rawName as keyof SystemLogFields;
    if (!fieldNames.has(name) || value === undefined) continue;
    if (typeof value === "number") {
      if (Number.isFinite(value)) (clean as Record<string, unknown>)[name] = value;
      continue;
    }
    if (typeof value === "string" && safeString.test(value) && !/bearer|token|secret|password|cookie|private.?key/i.test(value))
      (clean as Record<string, unknown>)[name] = value;
  }
  return clean;
}

export function safeErrorId(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : "UnknownError";
  const code = typeof error === "object" && error !== null && "code" in error
    && ["string", "number"].includes(typeof error.code) ? String(error.code) : "";
  return code && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? `${name}/${code}` : name;
}

export function createSystemLogger(options: {
  service: string;
  sink?: (entry: SystemLogEntry) => void;
  clock?: () => Date;
}): SystemLogger {
  if (!safeName.test(options.service)) throw new Error("invalid log service name");
  const sink = options.sink ?? (entry => {
    const method = entry.level === "error" ? console.error : entry.level === "warn" ? console.warn : console.log;
    method(entry);
  });
  const clock = options.clock ?? (() => new Date());
  return {
    event(level, component, event, fields = {}) {
      if (!safeName.test(component) || !safeName.test(event)) throw new Error("invalid structured log name");
      sink({ timestamp: clock().toISOString(), level, service: options.service, component, event, ...sanitizeFields(fields) });
    },
  };
}

export const silentSystemLogger: SystemLogger = { event() {} };

export function normalizedRoute(pathname: string): string {
  return pathname
    .replace(/\/(?:dev|gw|ap|pr|task)_[a-f0-9]{24}(?=\/|$)/g, "/:id")
    .replace(/\/{2,}/g, "/")
    .slice(0, 160);
}
