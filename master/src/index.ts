// MeshMind 主 Agent — P0 监听器
//
// 订阅设备注册与心跳，维护内存注册表，周期打印在线设备表。
// 这是 P0 的验证目标：「主机能看到设备在线 + 能力清单」。
//
// 运行: NATS_URL=nats://localhost:4222 npm run start
import { connect, JSONCodec, type NatsConnection, type Subscription } from "nats";
import { createServer } from "node:http";
import { Registry, type Manifest } from "./registry.ts";
import { Orchestrator } from "./orchestrator.ts";
import { Enrollment } from "./enroll.ts";
import { natsDisplayUrl, natsOptions } from "./nats-options.ts";

const ENROLL_PORT = Number(process.env.ENROLL_PORT ?? 7700);
const jc = JSONCodec();
const registry = new Registry();
const enrollment = new Enrollment();

function deviceIdFromSubject(subject: string): string {
  // device.<id>.<verb>
  return subject.split(".")[1] ?? "?";
}

interface RegisterEnvelope {
  manifest_json: string;
  sig: string;
}

async function handleRegistrations(sub: Subscription) {
  for await (const msg of sub) {
    const env = jc.decode(msg.data) as RegisterEnvelope;
    let m: Manifest;
    try {
      m = JSON.parse(env.manifest_json) as Manifest;
    } catch {
      msg.respond(jc.encode({ ok: false, error: "manifest_json 解析失败" }));
      continue;
    }

    // 已入网设备必须验签通过（防冒充）；未入网设备走 dev 模式接受但标记 unverified。
    const enrolled = enrollment.isEnrolled(m.device_id);
    let verified = false;
    if (enrolled) {
      verified = enrollment.verifyRegister(m.device_id, env.manifest_json, env.sig);
      if (!verified) {
        console.log(`\n[register] ✗ ${m.device_id} 验签失败 — 拒绝`);
        msg.respond(jc.encode({ ok: false, verified: false, error: "签名验证失败" }));
        continue;
      }
    }

    const state = registry.register(m);
    const isNew = state.registeredAt.getTime() === state.lastSeen.getTime();
    const badge = enrolled ? (verified ? "✓signed" : "?") : "dev/unverified";
    console.log(
      `\n[register] ${m.device_id} (${m.os}/${m.arch}) ${isNew ? "NEW" : "re-register"} [${badge}] ` +
        `— shell:${m.capabilities.shell.allow.length} fs.read:${m.capabilities.fs.read.length}`,
    );
    msg.respond(
      jc.encode({
        ok: true,
        verified,
        registered_at: state.registeredAt.toISOString(),
        server_time: new Date().toISOString(),
      }),
    );
  }
}

// control.enroll.new — CLI 请求主 Agent 签发一次性入网令牌。
async function handleEnrollMint(sub: Subscription) {
  for await (const msg of sub) {
    const { name, caps, tsAuthKey } = jc.decode(msg.data) as {
      name: string;
      caps: string[];
      tsAuthKey?: string;
    };
    const token = enrollment.mint({ name, caps, tsAuthKey });
    console.log(`\n[enroll] 签发令牌 name=${name} caps=${caps.join(",")}`);
    msg.respond(jc.encode(token));
  }
}

// 入网 HTTP 端点（部署时应置于 mesh 内网 + TLS）。
function startEnrollServer() {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/enroll") {
      res.writeHead(404).end("not found");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { enroll_secret, public_key, manifest } = JSON.parse(body);
        const result = enrollment.redeem({
          enroll_secret,
          public_key,
          deviceId: manifest?.device_id ?? "",
        });
        res.writeHead(result.ok ? 200 : 403, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        console.log(
          result.ok
            ? `[enroll] ✅ 设备入网 device_id=${result.device_id}`
            : `[enroll] ✗ 拒绝: ${result.error}`,
        );
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
  });
  server.listen(ENROLL_PORT, () => {
    console.log(`[master] 注册端点 http://localhost:${ENROLL_PORT}/enroll`);
  });
  return server;
}

async function handleHeartbeats(sub: Subscription) {
  for await (const msg of sub) {
    registry.heartbeat(deviceIdFromSubject(msg.subject));
  }
}

// control.goal — 编排入口。CLI 发来一个目标，主 Agent 规划+多设备调度+汇聚后回报告。
async function handleGoals(sub: Subscription, orch: Orchestrator) {
  for await (const msg of sub) {
    const { goal } = jc.decode(msg.data) as { goal: string };
    console.log(`\n[goal] 收到: "${goal}"`);
    try {
      const report = await orch.run(goal);
      console.log(`[goal] 完成: ${report.succeeded}/${report.dispatched} 成功`);
      msg.respond(jc.encode(report));
    } catch (e) {
      msg.respond(jc.encode({ error: (e as Error).message }));
    }
  }
}

function printTable() {
  const rows = registry.snapshot();
  const stamp = new Date().toLocaleTimeString();
  if (rows.length === 0) {
    console.log(`\n[${stamp}] 在线设备表 — 暂无设备。启动子 Agent 即可上线。`);
    return;
  }
  console.log(`\n[${stamp}] 在线设备表 (${rows.length})`);
  console.log("  " + "DEVICE".padEnd(18) + "OS/ARCH".padEnd(16) + "STATUS".padEnd(10) + "LAST SEEN");
  for (const d of rows) {
    const dot = d.status === "online" ? "🟢" : d.status === "stale" ? "🟡" : "🔴";
    console.log(
      "  " +
        d.manifest.device_id.padEnd(18) +
        `${d.manifest.os}/${d.manifest.arch}`.padEnd(16) +
        `${dot} ${d.status}`.padEnd(10) +
        d.lastSeen.toLocaleTimeString(),
    );
  }
}

async function main() {
  let nc: NatsConnection;
  try {
    nc = await connect(natsOptions("meshmind-master"));
  } catch (err) {
    console.error(`无法连接 NATS @ ${natsDisplayUrl()}。先启动基础设施：`);
    console.error("  ./infra/init-local-env.sh && docker compose --env-file infra/.env -f infra/docker-compose.yml up -d");
    throw err;
  }
  console.log(`[master] connected to ${natsDisplayUrl()}`);
  console.log("[master] 订阅 device.*.register / device.*.heartbeat ...");

  const orchestrator = new Orchestrator(nc, registry);
  handleRegistrations(nc.subscribe("device.*.register")).catch(console.error);
  handleHeartbeats(nc.subscribe("device.*.heartbeat")).catch(console.error);
  handleGoals(nc.subscribe("control.goal"), orchestrator).catch(console.error);
  handleEnrollMint(nc.subscribe("control.enroll.new")).catch(console.error);
  console.log("[master] 编排入口就绪: control.goal / control.enroll.new");

  const enrollServer = startEnrollServer();
  const timer = setInterval(printTable, 5_000);
  printTable();

  const shutdown = async () => {
    clearInterval(timer);
    enrollServer.close();
    console.log("\n[master] draining...");
    await nc.drain();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
