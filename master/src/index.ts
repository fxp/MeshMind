// MeshMind 主 Agent — P0 监听器
//
// 订阅设备注册与心跳，维护内存注册表，周期打印在线设备表。
// 这是 P0 的验证目标：「主机能看到设备在线 + 能力清单」。
//
// 运行: NATS_URL=nats://localhost:4222 npm run start
import { connect, JSONCodec, type NatsConnection, type Subscription } from "nats";
import { Registry, type Manifest } from "./registry.ts";

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";
const jc = JSONCodec();
const registry = new Registry();

function deviceIdFromSubject(subject: string): string {
  // device.<id>.<verb>
  return subject.split(".")[1] ?? "?";
}

async function handleRegistrations(sub: Subscription) {
  for await (const msg of sub) {
    const m = jc.decode(msg.data) as Manifest;
    const state = registry.register(m);
    const isNew = state.registeredAt.getTime() === state.lastSeen.getTime();
    console.log(
      `\n[register] ${m.device_id} (${m.os}/${m.arch}) ${isNew ? "NEW" : "re-register"} ` +
        `— shell:${m.capabilities.shell.allow.length} fs.read:${m.capabilities.fs.read.length}`,
    );
    msg.respond(
      jc.encode({
        ok: true,
        registered_at: state.registeredAt.toISOString(),
        server_time: new Date().toISOString(),
      }),
    );
  }
}

async function handleHeartbeats(sub: Subscription) {
  for await (const msg of sub) {
    registry.heartbeat(deviceIdFromSubject(msg.subject));
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
    nc = await connect({ servers: NATS_URL, name: "meshmind-master" });
  } catch (err) {
    console.error(`无法连接 NATS @ ${NATS_URL}。先启动基础设施：`);
    console.error("  docker compose -f infra/docker-compose.yml up -d");
    throw err;
  }
  console.log(`[master] connected to ${NATS_URL}`);
  console.log("[master] 订阅 device.*.register / device.*.heartbeat ...");

  handleRegistrations(nc.subscribe("device.*.register")).catch(console.error);
  handleHeartbeats(nc.subscribe("device.*.heartbeat")).catch(console.error);

  const timer = setInterval(printTable, 5_000);
  printTable();

  const shutdown = async () => {
    clearInterval(timer);
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
