import assert from "node:assert/strict";
import { test } from "node:test";
import { createSystemLogger, normalizedRoute, safeErrorId, type SystemLogEntry } from "../src/system-log.ts";
import { gatewayLogFrame } from "../src/schema.ts";

test("structured system logs retain diagnostic fields without accepting secret-shaped values", () => {
  const entries: SystemLogEntry[] = [];
  const logger = createSystemLogger({ service: "meshmind-test", sink: entry => entries.push(entry), clock: () => new Date(0) });
  logger.event("error", "gateway", "device.task.failed", {
    gatewayId: "gw_0123456789abcdef01234567", action: "status", errorId: "Error/ECONNRESET",
    requestId: "Bearer this-must-never-be-logged",
  });
  assert.deepEqual(entries, [{
    timestamp: "1970-01-01T00:00:00.000Z", level: "error", service: "meshmind-test", component: "gateway",
    event: "device.task.failed", gatewayId: "gw_0123456789abcdef01234567", action: "status", errorId: "Error/ECONNRESET",
  }]);
});

test("log helpers normalize resource identifiers and errors", () => {
  assert.equal(normalizedRoute("/api/devices/dev_0123456789abcdef01234567/status"), "/api/devices/:id/status");
  assert.equal(normalizedRoute("/api/principals/pr_0123456789abcdef01234567"), "/api/principals/:id");
  const error = Object.assign(new Error("contains a private device response"), { code: "ECONNRESET" });
  assert.equal(safeErrorId(error), "Error/ECONNRESET");
  assert.equal(safeErrorId("secret error text"), "UnknownError");
});

test("a gateway can report only predefined structured events, never arbitrary text", () => {
  assert.equal(gatewayLogFrame.safeParse({ kind: "log", level: "info", event: "gateway.ready", fields: { deviceCount: 2 } }).success, true);
  assert.equal(gatewayLogFrame.safeParse({ kind: "log", level: "info", event: "gateway.ready", fields: { message: "Bearer secret" } }).success, false);
  assert.equal(gatewayLogFrame.safeParse({ kind: "log", level: "error", event: "arbitrary.event", fields: {} }).success, false);
});
