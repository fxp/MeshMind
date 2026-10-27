import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.ts";
import { seedOwner } from "./support/owner.ts";
import { startGateway, localConfig } from "../src/gateway.ts";

const unpack = (result: any) => JSON.parse(result.content[0].text);

test("remote MCP controls only the configured local ADB device within granted scope", async t => {
  const dir = await mkdtemp(join(tmpdir(), "meshmind-adb-"));
  const executable = join(dir, "fake-adb.mjs"), log = join(dir, "calls.jsonl"), failUi = join(dir, "fail-ui");
  const gatewayLogs: string[] = [];
  const fakeUiNode = '<node index="0" text="Example" resource-id="" class="android.widget.TextView" package="example.package" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][10,10]"/>';
  assert.ok(Buffer.byteLength(`<?xml version="1.0"?><hierarchy rotation="0">${fakeUiNode.repeat(300)}</hierarchy>`) > 65536);
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (JSON.stringify(args.slice(0, 6)) !== JSON.stringify(["-H","127.0.0.1","-P","5037","-s","USB-ONLY-123"])) process.exit(2);
const command = args.slice(6);
if (command[0] === "get-state") process.stdout.write("device\\n");
else if (command[0] === "shell" && command[1] === "getprop") process.stdout.write(command[2] === "ro.product.model" ? "Pixel Test\\n" : "15\\n");
else if (command[0] === "exec-out" && command[1] === "uiautomator" && existsSync(${JSON.stringify(failUi)})) { process.stderr.write("private device detail\\n"); process.exit(7); }
else if (command[0] === "exec-out" && command[1] === "uiautomator") {
  const node = ${JSON.stringify(fakeUiNode)};
  process.stdout.write('<?xml version="1.0"?><hierarchy rotation="0">' + node.repeat(300) + '</hierarchy>\\n');
}
else if (command[0] === "shell" && command[1] === "input") process.exit(0);
else process.exit(3);
`);
  await chmod(executable, 0o700);
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const base = `http://127.0.0.1:${(reservation.address() as { port: number }).port}`;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const server = createApp({ database: join(dir, "hub.sqlite"), publicUrl: base, allowSignup: true });
  server.server.listen(Number(new URL(base).port), "127.0.0.1"); await once(server.server, "listening");
  const api = async (path: string, value?: unknown, auth?: string, method?: string) => {
    const response = await fetch(base + path, { method: method ?? (value === undefined ? "GET" : "POST"),
      headers: { origin: base, "content-type": "application/json", ...(auth?.startsWith("meshmind_session=") ? { cookie: auth } : auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: response.status, value: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  const clients: Client[] = [];
  const connect = async (token: string) => {
    const client = new Client({ name: "adb-agent-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  };
  try {
    const owner = seedOwner(server.store, "adb-owner@example.test");
    const other = seedOwner(server.store, "adb-other@example.test");
    const enrollment = (await api("/api/gateways", { name: "Local ADB" }, owner)).value;
    gateway = await startGateway({ stateFile: join(dir, "gateway.json"), enrollment: { ...enrollment.enrollment, hub: base },
      config: localConfig.parse({ devices: [{ localId: "android", name: "USB Pixel", model: "Android", connector: "adb", adbSerial: "USB-ONLY-123", adbPath: executable, allowUiDump: true, allowControl: true }] }),
      log: message => gatewayLogs.push(message) });
    const deadline = Date.now() + 5000;
    while (!server.broker.online(enrollment.gatewayId)) { if (Date.now() > deadline) throw new Error("Gateway did not connect"); await new Promise(r => setTimeout(r, 20)); }
    const device = (await api("/api/devices", undefined, owner)).value.devices[0];
    assert.deepEqual(device.capabilities, ["status", "adb_ui", "adb_input"]);
    const read = (await api("/api/principals", { name: "ADB read", kind: "agent", devices: [device.id], permissions: ["status"] }, owner)).value;
    const control = (await api("/api/principals", { name: "ADB control", kind: "agent", devices: [device.id], permissions: ["status", "adb_ui", "adb_input"] }, owner)).value;
    const reader = await connect(read.token), controller = await connect(control.token);
    await t.test("status uses only configured serial, and printer tools cannot read ADB", async () => {
      const result = unpack(await reader.callTool({ name: "adb_status", arguments: { deviceId: device.id } }));
      assert.equal(result.status.model, "Pixel Test"); assert.equal(result.status.androidVersion, "15");
      assert.equal((await reader.callTool({ name: "adb_ui", arguments: { deviceId: device.id } })).isError, true);
      const xml = unpack(await controller.callTool({ name: "adb_ui", arguments: { deviceId: device.id } })).ui.xml;
      assert.ok(Buffer.byteLength(xml) < 32768); assert.match(xml, /Example/);
      assert.match(xml, /class="TextView"/); assert.doesNotMatch(xml, /checkable=|package=/);
      assert.equal((xml.match(/<node\b/g) ?? []).length, (xml.match(/\/>/g) ?? []).length);
      assert.equal((await reader.callTool({ name: "printer_status", arguments: { deviceId: device.id } })).isError, true);
      assert.equal((await api(`/api/devices/${device.id}/adb-status`, undefined, other)).status, 404);
      assert.equal((await api("/api/principals", { name: "bad", kind: "agent", devices: [device.id], permissions: ["status", "pause"] }, owner)).status, 400);
    });
    await t.test("read token and malformed input cannot execute ADB", async () => {
      assert.equal((await reader.callTool({ name: "request_adb_input", arguments: { deviceId: device.id, input: { kind: "tap", x: 100, y: 200 } } })).isError, true);
      assert.equal((await api(`/api/devices/${device.id}/adb-actions`, { input: { kind: "text", text: "hi;rm -rf /" }, idempotencyKey: "malformed-001" }, control.token)).status, 400);
      assert.equal((await api(`/api/devices/${device.id}/adb-actions`, { input: { kind: "tap", x: 1, y: 1 }, idempotencyKey: "wrong-tenant-001" }, other)).status, 400);
      assert.equal((await readFile(log, "utf8")).includes('"input"'), false);
    });
    await t.test("authorized input executes directly, records exact input, and executes once", async () => {
      const args = { deviceId: device.id, input: { kind: "tap", x: 100, y: 200 }, idempotencyKey: "tap-once-001" };
      const first = unpack(await controller.callTool({ name: "request_adb_input", arguments: args }));
      assert.equal(first.approval.state, "completed"); assert.deepEqual(first.approval.input, args.input);
      assert.equal(first.approval.result.delivery, "executed");
      const again = unpack(await controller.callTool({ name: "request_adb_input", arguments: args }));
      assert.equal(again.approval.id, first.approval.id);
      assert.equal((await api(`/api/devices/${device.id}/adb-actions`, { input: { kind: "tap", x: 101, y: 200 }, idempotencyKey: args.idempotencyKey }, control.token)).status, 409);
      const recorded = (await api("/api/approvals", undefined, owner)).value.approvals.find((a: any) => a.id === first.approval.id);
      assert.deepEqual(recorded.input, args.input);
      assert.equal(recorded.state, "completed");
      assert.equal((await api(`/api/approvals/${first.approval.id}/approve`, {}, owner)).status, 409);
      const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
      assert.equal(calls.filter(a => a.includes("input")).length, 1);
      assert.deepEqual(calls.find(a => a.includes("input"))?.slice(6), ["shell", "input", "tap", "100", "200"]);
    });
    await t.test("gateway logs safe device error identifiers without stderr contents", async () => {
      await writeFile(failUi, "fail");
      assert.equal((await controller.callTool({ name: "adb_ui", arguments: { deviceId: device.id } })).isError, true);
      assert.ok(gatewayLogs.some(message => message.includes("设备操作失败（adb_ui，Error/7）")));
      assert.equal(gatewayLogs.some(message => message.includes("private device detail")), false);
    });
    await t.test("revocation applies to initialized MCP client", async () => {
      await api(`/api/principals/${control.id}`, undefined, owner, "DELETE");
      await assert.rejects(controller.callTool({ name: "adb_status", arguments: { deviceId: device.id } }));
    });
  } finally {
    for (const client of clients) await client.close();
    gateway?.stop(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});
