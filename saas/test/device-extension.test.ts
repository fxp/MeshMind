import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createReservation } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.ts";
import { startGateway, localConfig } from "../src/gateway.ts";
import { seedOwner } from "./support/owner.ts";

const unpack = (reply: any) => JSON.parse(reply.content[0].text);

test("a LAN device exposes only predeclared actions through scoped MCP and owner approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meshmind-device-extension-"));
  const requests: Array<{ method?: string; url?: string; authorization?: string; body: string }> = [];
  const deviceServer = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url === "/status" ? JSON.stringify({ state: "ready", value: 21, unit: "°C" }) : JSON.stringify({ accepted: true }));
    });
  });
  deviceServer.listen(0, "127.0.0.1"); await once(deviceServer, "listening");
  const deviceUrl = `http://127.0.0.1:${(deviceServer.address() as { port: number }).port}`;
  const reservation = createReservation(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const base = `http://127.0.0.1:${(reservation.address() as { port: number }).port}`;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const app = createApp({ database: join(dir, "hub.sqlite"), publicUrl: base, allowSignup: true });
  app.server.listen(Number(new URL(base).port), "127.0.0.1"); await once(app.server, "listening");
  const api = async (path: string, value?: unknown, auth?: string) => {
    const response = await fetch(base + path, { method: value === undefined ? "GET" : "POST",
      headers: { origin: base, "content-type": "application/json",
        ...(auth?.startsWith("meshmind_session=") ? { cookie: auth } : auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: response.status, value: await response.json() as any };
  };
  const clients: Client[] = [];
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  const connect = async (token: string) => {
    const client = new Client({ name: "device-extension-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  };
  try {
    const owner = seedOwner(app.store, "device-extension@example.test");
    const enrollment = (await api("/api/gateways", { name: "LAN lab" }, owner)).value;
    gateway = await startGateway({ stateFile: join(dir, "gateway.json"), enrollment: { ...enrollment.enrollment, hub: base },
      config: localConfig.parse({ devices: [{ localId: "lab_relay", name: "Lab relay", model: "HTTP relay", connector: "local_http",
        httpUrl: deviceUrl, httpStatusPath: "/status", httpToken: "local-secret-token",
        httpActions: [{ name: "power_on", description: "Turn the relay on", method: "POST", path: "/power", body: { power: "on" }, destructive: true }] }] }) });
    const deadline = Date.now() + 5000;
    while (!app.broker.online(enrollment.gatewayId)) { if (Date.now() > deadline) throw new Error("Gateway did not connect"); await new Promise(r => setTimeout(r, 20)); }
    const device = (await api("/api/devices", undefined, owner)).value.devices[0];
    assert.deepEqual(device.actions, [{ name: "power_on", description: "Turn the relay on", destructive: true }]);
    assert.equal(JSON.stringify(device).includes(deviceUrl), false);
    assert.equal(JSON.stringify(device).includes("local-secret-token"), false);
    assert.equal(JSON.stringify(device).includes("/power"), false);

    const readGrant = (await api("/api/principals", { name: "Status agent", kind: "agent", devices: [device.id], permissions: ["status"] }, owner)).value;
    const actionGrant = (await api("/api/principals", { name: "Action agent", kind: "agent", devices: [device.id], permissions: ["status", "device_invoke"] }, owner)).value;
    const reader = await connect(readGrant.token), actor = await connect(actionGrant.token);
    const readDevice = unpack(await reader.callTool({ name: "list_devices" })).devices[0];
    assert.equal(readDevice.actions, undefined);
    const actionDevice = unpack(await actor.callTool({ name: "list_devices" })).devices[0];
    assert.deepEqual(actionDevice.actions, device.actions);
    const status = unpack(await reader.callTool({ name: "device_status", arguments: { deviceId: device.id } }));
    assert.equal(status.status.value, "21"); assert.equal(status.status.unit, "°C");
    assert.equal((await reader.callTool({ name: "invoke_device_action", arguments: { deviceId: device.id, action: "power_on", idempotencyKey: "read-denied-001" } })).isError, true);
    assert.equal((await actor.callTool({ name: "invoke_device_action", arguments: { deviceId: device.id, action: "arbitrary", idempotencyKey: "bad-action-001" } })).isError, true);

    const requested = await actor.callTool({ name: "invoke_device_action", arguments: { deviceId: device.id, action: "power_on", idempotencyKey: "power-on-001" } });
    assert.equal(requested.isError, false);
    const approval = unpack(requested).approval;
    assert.equal(approval.state, "pending");
    assert.equal(requests.filter(request => request.url === "/power").length, 0);
    const approved = await api(`/api/approvals/${approval.id}/approve`, {}, owner);
    assert.equal(approved.status, 200); assert.equal(approved.value.state, "completed");
    assert.deepEqual(requests.find(request => request.url === "/power"), {
      method: "POST", url: "/power", authorization: "Bearer local-secret-token", body: JSON.stringify({ power: "on" }),
    });
    const audit = JSON.stringify((await api("/api/audit", undefined, owner)).value);
    assert.equal(audit.includes("local-secret-token"), false); assert.equal(audit.includes(deviceUrl), false);
  } finally {
    for (const client of clients) await client.close();
    gateway?.stop(); await app.close(); deviceServer.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("generic device configuration rejects dynamic commands and unsafe paths", () => {
  const base = { localId: "usb", name: "USB", model: "serial", connector: "usb_serial" as const, serialPort: "/dev/cu.usbserial-1", baudRate: 115200 };
  assert.equal(localConfig.safeParse({ devices: [{ ...base, serialActions: [{ name: "run", description: "Run", command: "GO\nSTOP" }] }] }).success, false);
  assert.equal(localConfig.safeParse({ devices: [{ localId: "lan", name: "LAN", model: "HTTP", connector: "local_http", httpUrl: "http://192.168.1.2", httpStatusPath: "/status",
    httpActions: [{ name: "run", description: "Run", path: "/../admin" }] }] }).success, false);
});
