// 向某设备下发一条任务并打印结果。P1 端到端 RPC 验证用。
//
// 用法:
//   npm run task -- <deviceId> echo "hello world"
//   npm run task -- <deviceId> shell -- ls -la /tmp
import { connect, JSONCodec } from "nats";
import { natsOptions } from "./nats-options.ts";

const jc = JSONCodec();

function taskId() {
  return "t_" + Math.random().toString(36).slice(2, 10);
}

async function main() {
  const [deviceId, kind, ...rest] = process.argv.slice(2);
  if (!deviceId || !kind) {
    console.error('用法: npm run task -- <deviceId> echo "text"');
    console.error("      npm run task -- <deviceId> shell -- ls -la /tmp");
    process.exit(1);
  }

  let task: Record<string, unknown>;
  if (kind === "echo") {
    task = {
      task_id: taskId(),
      type: "echo",
      payload: { text: rest.join(" ") },
      granted_capabilities: [],
      deadline_sec: 10,
    };
  } else if (kind === "shell") {
    const args = rest[0] === "--" ? rest.slice(1) : rest;
    const [cmd, ...cmdArgs] = args;
    task = {
      task_id: taskId(),
      type: "shell.run",
      payload: { cmd, args: cmdArgs },
      granted_capabilities: ["shell.run"],
      deadline_sec: 30,
    };
  } else {
    console.error(`未知任务类型: ${kind}（支持 echo / shell）`);
    process.exit(1);
  }

  const nc = await connect(natsOptions("meshmind-task-sender"));
  const subject = `device.${deviceId}.task`;
  console.log(`→ ${subject}`, JSON.stringify(task));
  try {
    const reply = await nc.request(subject, jc.encode(task), { timeout: 35_000 });
    console.log("← result:", JSON.stringify(jc.decode(reply.data), null, 2));
  } catch (e) {
    console.error(`✗ 无响应（设备 ${deviceId} 在线吗？）:`, (e as Error).message);
  } finally {
    await nc.drain();
  }
}

main();
