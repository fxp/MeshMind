// 模拟设备：enroll → 生成 ed25519 → WS 连接 → 签名注册 → 执行任务。
// 仅用于本地验证 Hub（真实设备用 Go 子 Agent）。
import crypto from "node:crypto";
import { execFile } from "node:child_process";

const BASE = process.env.BASE ?? "http://localhost:8787";
const NAME = process.env.NAME ?? "mac-studio";
const ADMIN = process.env.ADMIN_TOKEN ?? "local-dev-admin-secret-change-me";
const ALLOW = ["ls", "echo", "uname", "pwd", "stat", "du"];
const DESTRUCTIVE = new Set(["rm", "rmdir", "dd", "mkfs", "kill", "shutdown", "reboot"]);

const manifest = {
  device_id: NAME,
  hostname: "test-host",
  os: process.platform,
  arch: process.arch,
  agent_version: "0.0.1",
  capabilities: {
    shell: { allow: ALLOW, deny_destructive: true },
    fs: { read: ["/tmp"], write: [] },
    gpu: { available: false },
    sensors: [],
  },
};

function runShell(cmd, args) {
  return new Promise((resolve) => {
    const base = cmd.split("/").pop();
    if (DESTRUCTIVE.has(base) && manifest.capabilities.shell.deny_destructive)
      return resolve({ ok: false, error: `refused: destructive command '${base}'` });
    if (!ALLOW.includes(base))
      return resolve({ ok: false, error: `refused: '${base}' not in allowlist` });
    execFile(cmd, args ?? [], { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, result: { stdout, stderr, exit_code: err?.code ?? 0 } });
    });
  });
}

async function main() {
  // 1. 签发令牌
  const mintRes = await fetch(`${BASE}/admin/enroll/new`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ name: NAME, caps: ["shell", "fs"] }),
  });
  const mint = await mintRes.json();
  const token = JSON.parse(atob(mint.encoded));
  console.log(`[client] 令牌已签发 name=${NAME}`);

  // 2. 生成 ed25519 密钥对
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubB64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");

  // 3. 兑换令牌
  const enroll = await (
    await fetch(token.enroll_url, {
      method: "POST",
      body: JSON.stringify({ enroll_secret: token.enroll_secret, public_key: pubB64, manifest }),
    })
  ).json();
  console.log(`[client] enroll →`, JSON.stringify(enroll));
  if (!enroll.ok) process.exit(1);

  // 4. WS 连接
  const ws = new WebSocket(`${enroll.ws_url}?token=${enroll.bearer}`);
  ws.addEventListener("open", () => {
    const manifestJson = JSON.stringify(manifest);
    const sig = crypto.sign(null, Buffer.from(manifestJson), privateKey).toString("base64");
    ws.send(JSON.stringify({ kind: "register", manifest_json: manifestJson, sig }));
    setInterval(() => ws.send(JSON.stringify({ kind: "heartbeat", ts: Date.now() })), 5000);
  });
  ws.addEventListener("message", async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.kind === "register_ack") {
      console.log(`[client] register_ack ok=${msg.ok} verified=${msg.verified} ${msg.error ?? ""}`);
    } else if (msg.kind === "task") {
      let out = { ok: true, result: {} };
      if (msg.type === "echo") out = { ok: true, result: { text: msg.payload.text } };
      else if (msg.type === "shell.run") out = await runShell(msg.payload.cmd, msg.payload.args);
      ws.send(JSON.stringify({ kind: "result", task_id: msg.task_id, ...out, took_ms: 1 }));
    }
  });
  ws.addEventListener("close", () => console.log("[client] ws closed"));
  ws.addEventListener("error", (e) => console.log("[client] ws error", e.message ?? e));
}
main();
