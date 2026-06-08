// 给主 Agent 下发一个编排目标，打印汇聚报告。
//
// 用法:
//   npm run goal -- shell-all uname -a
//   npm run goal -- echo-all "ping all devices"
//   npm run goal -- shell-on mac-studio du -sh .
import { connect, JSONCodec } from "nats";
import type { GoalReport } from "./orchestrator.ts";

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";
const jc = JSONCodec();

function printReport(r: GoalReport) {
  console.log(`\n目标: "${r.goal}"  规划器: ${r.planner}`);
  console.log(`结果: ${r.succeeded}/${r.dispatched} 成功, ${r.failed} 失败\n`);
  for (const o of r.outcomes) {
    const mark = o.ok ? "✅" : "❌";
    console.log(`${mark} ${o.deviceId}  (${o.took_ms}ms)${o.rationale ? "  · " + o.rationale : ""}`);
    if (o.ok && o.result) {
      const out = (o.result.stdout as string) ?? (o.result.text as string) ?? JSON.stringify(o.result);
      const trimmed = out.length > 600 ? out.slice(0, 600) + " …(truncated)" : out;
      console.log(
        trimmed
          .split("\n")
          .filter(Boolean)
          .map((l) => "     " + l)
          .join("\n"),
      );
    } else if (!o.ok) {
      console.log("     error: " + o.error);
    }
  }
}

async function main() {
  const goal = process.argv.slice(2).join(" ");
  if (!goal) {
    console.error("用法: npm run goal -- shell-all uname -a");
    process.exit(1);
  }
  const nc = await connect({ servers: NATS_URL, name: "meshmind-goal" });
  try {
    const reply = await nc.request("control.goal", jc.encode({ goal }), { timeout: 60_000 });
    const r = jc.decode(reply.data) as GoalReport & { error?: string };
    if (r.error) {
      console.error("✗ 编排失败:", r.error);
    } else {
      printReport(r);
    }
  } catch (e) {
    console.error("✗ 主 Agent 无响应（master 在跑吗？）:", (e as Error).message);
  } finally {
    await nc.drain();
  }
}

main();
