import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { validateHub } from "./gateway.ts";

const { values } = parseArgs({ options: { hub: { type: "string" }, "token-file": { type: "string" }, name: { type: "string", default: "meshmind" } } });
if (!values.hub || !values["token-file"]) throw new Error("用法：npm run setup-codex -- --hub https://your-hub --token-file /path/to/meshmind-token.txt");
const hub = validateHub(values.hub), tokenFile = resolve(values["token-file"]);
const token = (await readFile(tokenFile, "utf8")).trim();
const response = await fetch(hub + "/api/devices", { headers: { authorization: "Bearer " + token }, redirect: "error", signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error("凭证不可用，请在管理页面重新签发");
await chmod(tokenFile, 0o600);
const result = spawnSync("codex", ["mcp", "add", values.name!, "--env", "MESHMIND_HUB=" + hub, "--env", "MESHMIND_TOKEN_FILE=" + tokenFile,
  "--", process.execPath, fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)), fileURLToPath(new URL("./mcp.ts", import.meta.url))], { stdio: "inherit" });
if (result.error || result.status !== 0) { console.error("无法配置 Codex。请确认已安装 Codex CLI，并查看 saas/README.md 中的手动配置。"); process.exitCode = 1; }
else console.log("已添加 MeshMind MCP。请在新的 Codex 会话中使用 list_devices，再按设备类型调用 printer_status 或 adb_status。");
