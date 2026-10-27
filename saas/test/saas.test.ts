import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { WebSocket } from "ws";
import { createApp } from "../src/server.ts";
import { startGateway, localConfig, validateHub } from "../src/gateway.ts";
import { normalizeReport } from "../src/connectors.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn: () => Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(20); }
  throw new Error("condition timed out");
}

test("SaaS tenant, gateway, delegation, approval and MCP boundaries", async t => {
  const dir = await mkdtemp(join(tmpdir(), "meshmind-test-"));
  const app = createApp({ database: join(dir, "hub.sqlite"), publicUrl: "http://localhost", allowSignup: true });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const clients: { stop(): void }[] = [];
  const call = async (path: string, body?: unknown, auth?: string, method?: string) => {
    const headers: Record<string, string> = { origin: "http://localhost", "content-type": "application/json" };
    if (auth) headers[auth.startsWith("meshmind_session=") ? "cookie" : "authorization"] = auth.startsWith("meshmind_session=") ? auth : `Bearer ${auth}`;
    const response = await fetch(base + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const config = localConfig.parse({ devices: [{ localId: "x1c", name: "Studio X1C", model: "Bambu X1C (simulated)", connector: "simulator", allowControl: true }] });
  try {
    const a = await call("/api/register", { email: "owner-a@example.test", password: "long-test-password-A" });
    const b = await call("/api/register", { email: "owner-b@example.test", password: "long-test-password-B" });
    assert.equal(a.status, 201); assert.equal(b.status, 201); assert.ok(a.cookie); assert.ok(b.cookie);
    const owner = a.cookie!, other = b.cookie!;
    const grant = await call("/api/gateways", { name: "Studio gateway" }, owner);
    assert.equal(grant.status, 201);
    clients.push(await startGateway({ config, stateFile: join(dir, "gw-a.json"), enrollment: { ...grant.body.enrollment, hub: base } }));
    await until(async () => (await call("/api/devices", undefined, owner)).body.devices.length === 1);
    const device = (await call("/api/devices", undefined, owner)).body.devices[0];
    await t.test("versioned Agent API exposes a public contract and scoped unified state", async () => {
      const guide = await fetch(base + "/docs/agent-api");
      assert.equal(guide.status, 200);
      assert.match(await guide.text(), /MeshMind CLI/);
      const landing = await fetch(base + "/");
      assert.match(await landing.text(), /href="\/docs\/agent-api"/);
      const discovery = await call("/.well-known/meshmind.json");
      assert.equal(discovery.status, 200);
      assert.equal(discovery.body.apiVersion, "v1");
      assert.equal(discovery.body.safety.adbInput, "immediate_when_granted");
      const spec = await call("/api/v1/openapi.json");
      assert.equal(spec.status, 200);
      assert.equal(spec.body.openapi, "3.1.0");
      assert.ok(spec.body.paths["/devices/{deviceId}/state"]);
      assert.equal((await call("/api/v1/devices")).status, 401);
      const state = await call(`/api/v1/devices/${device.id}/state`, undefined, owner);
      assert.equal(state.status, 200);
      assert.equal(state.body.connector, "simulator");
      assert.equal(state.body.status.progress, 42);
      assert.equal((await call(`/api/v1/devices/${device.id}/state`, undefined, other)).status, 404);
    });
    await t.test("transient connection expiry reconnects with the same device identity", async () => {
      // Inject the same wire-level close as a heartbeat timeout without waiting 30 seconds.
      const connections = (app.broker as unknown as { connections: Map<string, { ws: WebSocket }> }).connections;
      connections.get(grant.body.gatewayId)!.ws.close(4004, "heartbeat timeout");
      await until(async () => !app.broker.online(grant.body.gatewayId));
      await until(async () => app.broker.online(grant.body.gatewayId));
      const after = (await call("/api/devices", undefined, owner)).body.devices;
      assert.equal(after.length, 1); assert.equal(after[0].id, device.id);
    });
    const grantB = await call("/api/gateways", { name: "Other tenant gateway" }, other);
    clients.push(await startGateway({ config, stateFile: join(dir, "gw-b.json"), enrollment: { ...grantB.body.enrollment, hub: base } }));
    await until(async () => (await call("/api/devices", undefined, other)).body.devices.length === 1);
    const otherDevice = (await call("/api/devices", undefined, other)).body.devices[0];
    assert.notEqual(device.id, otherDevice.id);

    await t.test("tenant isolation covers enumeration, direct ids, credentials and gateway revocation", async () => {
      assert.equal((await call(`/api/devices/${device.id}/status`, undefined, other)).status, 404);
      assert.equal((await call(`/api/gateways/${grant.body.gatewayId}`, undefined, other, "DELETE")).status, 404);
      assert.equal((await call("/api/principals", { name: "bad", kind: "agent", devices: [device.id], permissions: ["status"] }, other)).status, 404);
      assert.equal((await call("/api/devices", undefined, owner)).body.devices.length, 1);
      assert.equal((await call("/api/audit", undefined, other)).body.events.some((e: any) => e.resource === device.id), false);
    });

    const scoped = await call("/api/principals", { name: "Codex read only", kind: "agent", devices: [device.id], permissions: ["status"], expiresInHours: 1 }, owner);
    assert.equal(scoped.status, 201);
    const readToken = scoped.body.token;
    await t.test("scoped agent reads via outbound gateway but cannot control, administer or see other devices", async () => {
      assert.equal((await call("/api/devices", undefined, readToken)).body.devices[0].id, device.id);
      const status = await call(`/api/devices/${device.id}/status`, undefined, readToken);
      assert.equal(status.status, 200); assert.equal(status.body.status.progress, 42); assert.equal(status.body.stale, false);
      assert.equal((await call(`/api/devices/${otherDevice.id}/status`, undefined, readToken)).status, 404);
      assert.equal((await call(`/api/devices/${device.id}/actions`, { action: "stop", idempotencyKey: "read-only-stop" }, readToken)).status, 403);
      for (const path of ["/api/gateways", "/api/principals", "/api/audit"]) assert.equal((await call(path, undefined, readToken)).status, 403);
    });

    const control = await call("/api/principals", { name: "Codex control requests", kind: "agent", devices: [device.id], permissions: ["status", "pause", "resume", "stop"] }, owner);
    const controlToken = control.body.token;
    await t.test("control requires owner approval, is bound to tenant and supports idempotency", async () => {
      const request = { action: "pause", idempotencyKey: "pause-request-001" };
      const first = await call(`/api/devices/${device.id}/actions`, request, controlToken);
      assert.equal(first.status, 202); assert.equal(first.body.approval.state, "pending");
      const repeated = await call(`/api/devices/${device.id}/actions`, request, controlToken);
      assert.equal(repeated.body.approval.id, first.body.approval.id);
      assert.equal((await call(`/api/devices/${device.id}/actions`, { ...request, action: "stop" }, controlToken)).status, 409);
      assert.equal((await call(`/api/devices/${device.id}/status`, undefined, readToken)).body.status.state, "RUNNING");
      const url = `/api/approvals/${first.body.approval.id}/approve`;
      assert.equal((await call(url, {}, controlToken)).status, 403);
      assert.equal((await call(url, {}, other)).status, 404);
      const approved = await call(url, {}, owner);
      assert.equal(approved.body.state, "completed");
      assert.equal((await call(`/api/devices/${device.id}/status`, undefined, readToken)).body.status.state, "PAUSE");
      assert.equal((await call(url, {}, owner)).status, 409);
    });

    await t.test("revocation and expiry invalidate both access and pending physical operations", async () => {
      const requested = await call(`/api/devices/${device.id}/actions`, { action: "resume", idempotencyKey: "resume-request-001" }, controlToken);
      assert.equal((await call(`/api/principals/${control.body.id}`, undefined, owner, "DELETE")).status, 200);
      assert.equal((await call(`/api/devices/${device.id}/status`, undefined, controlToken)).status, 401);
      assert.equal((await call(`/api/approvals/${requested.body.approval.id}/approve`, {}, owner)).status, 409);
      const expired = await call("/api/principals", { name: "Expired", kind: "user", devices: [device.id], permissions: ["status"] }, owner);
      app.store.db.prepare("UPDATE principals SET expires_at=? WHERE id=?").run(Date.now() - 1, expired.body.id);
      assert.equal((await call("/api/devices", undefined, expired.body.token)).status, 401);
    });

    await t.test("CSRF and invalid bearer never gain owner access through a cookie", async () => {
      const crossSite = await fetch(base + "/api/gateways", { method: "POST", headers: { cookie: owner, origin: "https://attacker.test", "content-type": "application/json" }, body: JSON.stringify({ name: "evil" }) });
      assert.equal(crossSite.status, 403);
      const invalidBearer = await fetch(base + "/api/gateways", { headers: { cookie: owner, authorization: "Bearer invalid" } });
      assert.equal(invalidBearer.status, 401);
      assert.equal((await call("/api/devices")).status, 401);
      assert.equal((await call("/api/login", { email: "owner-a@example.test", password: "incorrect-long-password" })).status, 401);
    });

    await t.test("enrollment is one use and persistent credentials contain only hashes in Hub", async () => {
      const keys = generateKeyPairSync("ed25519");
      const replay = await call("/api/gateways/enroll", { publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) }, grant.body.enrollment.token);
      assert.equal(replay.status, 401);
      const state = JSON.parse(await readFile(join(dir, "gw-a.json"), "utf8"));
      assert.equal((await stat(join(dir, "gw-a.json"))).mode & 0o777, 0o600);
      const row = app.store.gateway(grant.body.gatewayId)!;
      assert.notEqual(row.bearer_hash, state.token); assert.equal(row.enroll_hash, null);
      const audit = JSON.stringify((await call("/api/audit", undefined, owner)).body);
      assert.equal(audit.includes(readToken), false); assert.equal(audit.includes(state.token), false);
      const oldManifest = JSON.stringify(app.store.db.prepare("SELECT * FROM devices").all());
      assert.equal(oldManifest.includes("accessCode"), false);
    });

    await t.test("Codex-compatible MCP SDK handshake, tools listing and status call", async () => {
      const tokenFile = join(dir, "agent-token.txt"); await writeFile(tokenFile, readToken, { mode: 0o600 });
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)), fileURLToPath(new URL("../src/mcp.ts", import.meta.url))],
        env: { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")), MESHMIND_HUB: base, MESHMIND_TOKEN_FILE: tokenFile }, stderr: "pipe" });
      const client = new Client({ name: "codex-showcase-test", version: "1.0.0" });
      try {
        await client.connect(transport);
        assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ["adb_status", "adb_ui", "device_status", "list_action_requests", "list_devices", "printer_status", "request_adb_input", "request_printer_action"]);
        const answer = await client.callTool({ name: "printer_status", arguments: { deviceId: device.id } });
        assert.equal(answer.isError, false);
        assert.equal(JSON.parse((answer.content as { text: string }[])[0].text).status.state, "PAUSE");
        const denied = await client.callTool({ name: "request_printer_action", arguments: { deviceId: device.id, action: "stop" } }); assert.equal(denied.isError, true);
      } finally { await client.close(); }
    });

    await t.test("challenge signatures are required and a heartbeat cannot bypass registration", async () => {
      const enrollment = await call("/api/gateways", { name: "Unverified gateway" }, owner);
      const keys = generateKeyPairSync("ed25519");
      const enrolled = await call("/api/gateways/enroll", { publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) }, enrollment.body.enrollment.token);
      const ws = new WebSocket(base.replace("http", "ws") + `/api/gateways/${enrolled.body.gatewayId}/connect`, { headers: { authorization: "Bearer " + enrolled.body.token } });
      await once(ws, "message");
      const closed = once(ws, "close");
      ws.send(JSON.stringify({ kind: "heartbeat" }));
      await closed;
      assert.equal(app.broker.online(enrolled.body.gatewayId), false);
      const ws2 = new WebSocket(base.replace("http", "ws") + `/api/gateways/${enrolled.body.gatewayId}/connect`, { headers: { authorization: "Bearer " + enrolled.body.token } });
      const [challenge] = await once(ws2, "message");
      const msg = JSON.parse(challenge.toString());
      const otherKeys = generateKeyPairSync("ed25519");
      const manifestJson = JSON.stringify([{ localId: "fake", name: "Fake", model: "X1C", connector: "simulator", capabilities: ["status"] }]);
      const closed2 = once(ws2, "close");
      ws2.send(JSON.stringify({ kind: "register", manifestJson, signature: sign(null, Buffer.from(`${msg.challenge}\n${enrolled.body.gatewayId}\n${manifestJson}`), otherKeys.privateKey).toString("base64") }));
      await closed2;
      assert.equal(app.broker.online(enrolled.body.gatewayId), false);
      assert.equal((await call("/api/devices", undefined, owner)).body.devices.some((d: any) => d.name === "Fake"), false);
    });

    await t.test("a second gateway cannot forge a result even with the correct task id", async () => {
      const manual = async (cookie: string, name: string) => {
        const minted = await call("/api/gateways", { name }, cookie);
        const keys = generateKeyPairSync("ed25519");
        const enrolled = await call("/api/gateways/enroll", { publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) }, minted.body.enrollment.token);
        const ws = new WebSocket(base.replace("http", "ws") + `/api/gateways/${enrolled.body.gatewayId}/connect`, { headers: { authorization: "Bearer " + enrolled.body.token } });
        const [bytes] = await once(ws, "message"); const challenge = JSON.parse(bytes.toString()).challenge;
        const manifestJson = JSON.stringify([{ localId: "manual", name, model: "X1C", connector: "simulator", capabilities: ["status"] }]);
        const ack = once(ws, "message");
        ws.send(JSON.stringify({ kind: "register", manifestJson, signature: sign(null, Buffer.from(`${challenge}\n${enrolled.body.gatewayId}\n${manifestJson}`), keys.privateKey).toString("base64") }));
        await ack;
        return { ws, gateway: app.store.gateway(enrolled.body.gatewayId)! };
      };
      const first = await manual(owner, "Result owner"), second = await manual(other, "Forging gateway");
      try {
        const taskFrame = once(first.ws, "message");
        let finished = false;
        const pending = app.broker.status(first.gateway.tenant_id, first.gateway.id, "manual").then(value => { finished = true; return value; });
        const [bytes] = await taskFrame; const taskId = JSON.parse(bytes.toString()).taskId;
        const value = normalizeReport({ gcode_state: "RUNNING", mc_percent: 12 });
        second.ws.send(JSON.stringify({ kind: "result", taskId, ok: true, value: { ...value, progress: 99 } }));
        await delay(30); assert.equal(finished, false);
        first.ws.send(JSON.stringify({ kind: "result", taskId, ok: true, value }));
        assert.equal((await pending).progress, 12);
      } finally { first.ws.terminate(); second.ws.terminate(); }
    });

    await t.test("revoking gateway disconnects it and removes its devices from all catalogs", async () => {
      assert.equal((await call(`/api/gateways/${grant.body.gatewayId}`, undefined, owner, "DELETE")).status, 200);
      await until(async () => !app.broker.online(grant.body.gatewayId));
      assert.equal((await call("/api/devices", undefined, readToken)).body.devices.length, 0);
      assert.equal((await call(`/api/devices/${device.id}/status`, undefined, readToken)).status, 404);
    });

    await t.test("a local read-only policy remains authoritative even if Hub attempts control", async () => {
      const minted = await call("/api/gateways", { name: "Read-only local policy" }, owner);
      const readOnly = localConfig.parse({ devices: [{ localId: "read-only", name: "Read-only X1C", model: "X1C", connector: "simulator" }] });
      clients.push(await startGateway({ config: readOnly, stateFile: join(dir, "read-only.json"), enrollment: { ...minted.body.enrollment, hub: base } }));
      await until(async () => app.broker.online(minted.body.gatewayId));
      const localDevice = (await call("/api/devices", undefined, owner)).body.devices.find((d: any) => d.localId === "read-only");
      assert.deepEqual(localDevice.capabilities, ["status"]);
      const denied = await call("/api/principals", { name: "Invalid capability", kind: "agent", devices: [localDevice.id], permissions: ["status", "pause"] }, owner);
      assert.equal(denied.status, 400);
      const gateway = app.store.gateway(minted.body.gatewayId)!;
      await assert.rejects(app.broker.call(gateway.tenant_id, gateway.id, "read-only", "pause"), /设备操作失败/);
      assert.equal((await call(`/api/devices/${localDevice.id}/status`, undefined, owner)).body.status.state, "RUNNING");
    });
  } finally {
    for (const client of clients) client.stop(); await app.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("report normalization is partial-update aware and does not export LAN metadata", () => {
  const first = normalizeReport({ gcode_state: "RUNNING", mc_percent: 25, nozzle_temper: 220, accessCode: "secret", lan_ip: "192.168.1.2" });
  const second = normalizeReport({ mc_percent: 26 }, first);
  assert.equal(second.state, "RUNNING"); assert.equal(second.nozzleTemperature, 220); assert.equal(second.progress, 26);
  assert.equal("accessCode" in second, false); assert.equal("lan_ip" in second, false);
  assert.equal(normalizeReport({ mc_percent: Infinity }).progress, null);
  assert.throws(() => validateHub("http://external.example"));
  assert.throws(() => validateHub("https://trusted.example@attacker.example"));
  assert.throws(() => localConfig.parse({ devices: [{ localId: "x1c", name: "X1C", model: "X1C", connector: "bambu" }] }));
});
