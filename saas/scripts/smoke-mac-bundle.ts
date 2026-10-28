import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createApp } from "../src/server.ts";
import { seedOwner } from "../test/support/owner.ts";

const dir = await mkdtemp(join(tmpdir(), "meshmind-mac-bundle-"));
const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
const base = `http://127.0.0.1:${(reservation.address() as {port:number}).port}`;
await new Promise<void>(done => reservation.close(() => done()));
const app = createApp({ database: join(dir, "hub.sqlite"), publicUrl: base, allowSignup: true });
app.server.listen(Number(new URL(base).port), "127.0.0.1"); await once(app.server, "listening");
const resources = resolve("macos/build/MeshMind Connect.app/Contents/Resources");
const api = async (path: string, value?: unknown, cookie?: string) => {
  const response = await fetch(base + path, { method: value === undefined ? "GET" : "POST",
    headers: { origin: base, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: response.status, value: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
};
let child: ReturnType<typeof spawn> | undefined;
try {
  const owner = seedOwner(app.store, "mac-bundle@example.test");
  const enrollment = (await api("/api/gateways", { name: "Mac bundle smoke" }, owner)).value;
  await writeFile(join(dir, "gateway.json"), JSON.stringify({ devices: [
    { localId: "demo", name: "Bundled simulator", model: "X1C", connector: "simulator" }] }), { mode: 0o600 });
  await writeFile(join(dir, "enrollment.json"), JSON.stringify({ ...enrollment.enrollment, hub: base }), { mode: 0o600 });
  child = spawn(join(resources, "node"), [join(resources, "gateway.cjs"), "--config", join(dir, "gateway.json"),
    "--enroll", join(dir, "enrollment.json"), "--state", join(dir, "state.json")],
    { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, MESHMIND_DIAGNOSTICS: "1" } });
  const deadline = Date.now() + 8000;
  while (!app.broker.online(enrollment.gatewayId)) {
    if (child.exitCode !== null) throw new Error("Bundled gateway exited before connecting");
    if (Date.now() > deadline) throw new Error("Bundled gateway did not connect");
    await new Promise(r => setTimeout(r, 50));
  }
  const device = (await api("/api/devices", undefined, owner)).value.devices[0];
  const status = await api(`/api/devices/${device.id}/status`, undefined, owner);
  assert.equal(status.status, 200);
  assert.equal(status.value.status.progress, 42);
  console.log("PASS packaged Mac runtime connects and reports device status");
} finally {
  child?.kill("SIGTERM"); app.broker.close(); app.server.close(); await rm(dir, { recursive: true, force: true });
}
