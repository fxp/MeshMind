// 签发一次性入网令牌（向运行中的主 Agent 请求）。
//
// 用法:
//   npm run enroll -- new --name mac-studio --caps shell,fs
//   # 部署层可附带 --ts-authkey <tailscale auth key>
import { connect, JSONCodec } from "nats";
import type { EnrollToken } from "./enroll.ts";
import { natsOptions } from "./nats-options.ts";

const jc = JSONCodec();

function flag(name: string, def = ""): string {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const sub = process.argv[2];
  if (sub !== "new") {
    console.error("用法: npm run enroll -- new --name <name> --caps shell,fs [--ts-authkey <key>]");
    process.exit(1);
  }
  const name = flag("name");
  const caps = flag("caps", "shell,fs").split(",").map((s) => s.trim()).filter(Boolean);
  const tsAuthKey = flag("ts-authkey");
  if (!name) {
    console.error("缺少 --name");
    process.exit(1);
  }

  const nc = await connect(natsOptions("meshmind-enroll-cli"));
  try {
    const reply = await nc.request(
      "control.enroll.new",
      jc.encode({ name, caps, tsAuthKey }),
      { timeout: 10_000 },
    );
    const token = jc.decode(reply.data) as EnrollToken;
    const encoded = Buffer.from(JSON.stringify(token)).toString("base64");

    console.log(`\n✅ 已为 "${name}" 签发一次性入网令牌（${caps.join(",")}，1 小时有效）\n`);
    console.log("在目标设备上运行：\n");
    console.log(`  meshmind-agent join --token ${encoded}`);
    console.log(`  # 本机联调（不入 tailscale）追加 --skip-network\n`);
    if (!token.ts_authkey) {
      console.log("提示: 令牌未含 tailscale auth key（部署层用 --ts-authkey 注入）。\n");
    }
  } catch (e) {
    console.error("✗ 主 Agent 无响应（master 在跑吗？）:", (e as Error).message);
  } finally {
    await nc.drain();
  }
}

main();
