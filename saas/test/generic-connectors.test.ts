import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createReservation } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.ts";
import { startGateway, localConfig } from "../src/gateway.ts";

test("Home Assistant entity is readable through a scoped MCP credential without exposing its local token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meshmind-ha-"));
  const haRequests: Array<{ url?: string; authorization?: string }> = [];
  const ha = createServer((request, response) => {
    haRequests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ state: "23.5", attributes: { unit_of_measurement: "°C" } }));
  });
  ha.listen(0, "127.0.0.1"); await once(ha, "listening");
  const haUrl = `http://127.0.0.1:${(ha.address() as {port:number}).port}`;
  const reservation = createReservation(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const base = `http://127.0.0.1:${(reservation.address() as {port:number}).port}`;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const app = createApp({ database: join(dir, "hub.sqlite"), publicUrl: base, allowSignup: true });
  app.server.listen(Number(new URL(base).port), "127.0.0.1"); await once(app.server, "listening");
  const api = async (path: string, value?: unknown, auth?: string) => {
    const response = await fetch(base + path, { method: value === undefined ? "GET" : "POST",
      headers: { origin: base, "content-type": "application/json",
        ...(auth?.startsWith("meshmind_session=") ? { cookie: auth } : auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: response.status, value: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  const client = new Client({ name: "ha-reader-test", version: "1.0.0" });
  try {
    const owner = (await api("/api/register", { email: "ha@example.test", password: "long-test-password" })).cookie!;
    const enrollment = (await api("/api/gateways", { name: "Home Assistant" }, owner)).value;
    gateway = await startGateway({ stateFile: join(dir, "gateway.json"), enrollment: { ...enrollment.enrollment, hub: base },
      config: localConfig.parse({ devices: [{ localId: "temperature", name: "Living room", model: "HA sensor",
        connector: "home_assistant", haUrl, haToken: "test-secret-long-lived", haEntityId: "sensor.living_room_temperature" }] }) });
    const deadline = Date.now() + 5000;
    while (!app.broker.online(enrollment.gatewayId)) { if (Date.now() > deadline) throw new Error("Gateway did not connect"); await new Promise(r => setTimeout(r, 20)); }
    const device = (await api("/api/devices", undefined, owner)).value.devices[0];
    assert.deepEqual(device.capabilities, ["status"]);
    assert.equal(JSON.stringify(device).includes("test-secret-long-lived"), false);
    assert.equal(JSON.stringify(device).includes(haUrl), false);
    const grant = (await api("/api/principals", { name: "HA reader", kind: "agent", devices: [device.id], permissions: ["status"] }, owner)).value;
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${grant.token}` } } }));
    const result = await client.callTool({ name: "device_status", arguments: { deviceId: device.id } });
    assert.equal(result.isError, false);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.equal(body.status.value, "23.5"); assert.equal(body.status.unit, "°C");
    assert.deepEqual(haRequests, [{ url: "/api/states/sensor.living_room_temperature", authorization: "Bearer test-secret-long-lived" }]);
    assert.equal((await client.callTool({ name: "printer_status", arguments: { deviceId: device.id } })).isError, true);
    assert.equal((await client.callTool({ name: "request_printer_action", arguments: { deviceId: device.id, action: "stop" } })).isError, true);
  } finally {
    await client.close(); gateway?.stop(); app.broker.close(); app.server.close(); ha.close(); await rm(dir, { recursive: true, force: true });
  }
});
