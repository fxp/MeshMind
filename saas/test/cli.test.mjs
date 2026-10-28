import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli, CliError } from "../bin/meshmind.mjs";

const token = "mm_test_agent_token_12345678901234567890";
const env = { MESHMIND_HUB: "https://mesh.example.test", MESHMIND_TOKEN: token };
function stub(status = 200, payload = { ok: true }) {
  const calls = [];
  return { calls, fetcher: async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  } };
}

test("CLI discovers unauthenticated contract and sends bearer only to the chosen Hub", async () => {
  const s = stub();
  await runCli(["discover"], { MESHMIND_HUB: env.MESHMIND_HUB }, s.fetcher);
  assert.equal(s.calls[0].url, "https://mesh.example.test/.well-known/meshmind.json");
  assert.equal(s.calls[0].init.headers.authorization, undefined);
  await runCli(["devices", "list"], env, s.fetcher);
  assert.equal(s.calls[1].url, "https://mesh.example.test/api/v1/devices");
  assert.equal(s.calls[1].init.headers.authorization, `Bearer ${token}`);
  await assert.rejects(() => runCli(["api", "GET", "/api/v1/../principals"], env, s.fetcher), CliError);
  await assert.rejects(() => runCli(["api", "GET", "https://elsewhere.test/api/v1/devices"], env, s.fetcher), CliError);
  await assert.rejects(() => runCli(["--hub", "http://mesh.example.test", "devices", "list"], env, s.fetcher), CliError);
  assert.equal(s.calls.length, 2);
});

test("CLI distinguishes approval requests from immediate ADB execution", async () => {
  const id = "dev_" + "a".repeat(24);
  const s = stub();
  await runCli(["actions", "printer", id, "pause", "--idempotency-key", "same-action-001"], env, s.fetcher);
  assert.equal(s.calls[0].url, `https://mesh.example.test/api/v1/devices/${id}/actions`);
  assert.deepEqual(JSON.parse(s.calls[0].init.body), { action: "pause", idempotencyKey: "same-action-001" });
  await runCli(["actions", "device", id, "power_on", "--idempotency-key", "same-action-003"], env, s.fetcher);
  assert.equal(s.calls[1].url, `https://mesh.example.test/api/v1/devices/${id}/device-actions`);
  assert.deepEqual(JSON.parse(s.calls[1].init.body), { action: "power_on", idempotencyKey: "same-action-003" });
  await assert.rejects(() => runCli(["actions", "adb", id, "--input-json", '{"kind":"tap","x":1,"y":2}'], env, s.fetcher), /--execute/);
  assert.equal(s.calls.length, 2);
  await runCli(["actions", "adb", id, "--input-json", '{"kind":"tap","x":1,"y":2}', "--execute", "--idempotency-key", "same-action-002"], env, s.fetcher);
  assert.deepEqual(JSON.parse(s.calls[2].init.body), { input: { kind: "tap", x: 1, y: 2 }, idempotencyKey: "same-action-002" });
});

test("CLI preserves HTTP error status without leaking bearer", async () => {
  const s = stub(403, { error: "No permission" });
  await assert.rejects(() => runCli(["devices", "list"], env, s.fetcher), error => {
    assert.equal(error.status, 403);
    assert.equal(error.exitCode, 4);
    assert.ok(!error.message.includes(token));
    return true;
  });
});
