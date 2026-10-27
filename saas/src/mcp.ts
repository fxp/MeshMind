import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDeviceMcp } from "./mcp-tools.ts";
import { validateHub } from "./gateway.ts";

const hub = validateHub(process.env.MESHMIND_HUB ?? "http://localhost:8788");
const token = process.env.MESHMIND_TOKEN_FILE ? (await readFile(process.env.MESHMIND_TOKEN_FILE, "utf8")).trim() : process.env.MESHMIND_TOKEN;
if (!token) throw new Error("请配置 MESHMIND_TOKEN_FILE，使用所有者签发的范围受限凭证");
async function request(path: string, body?: unknown) {
  const response = await fetch(hub + path, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const data = await response.json();
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], isError: !response.ok };
}
const server = createDeviceMcp(request);
await server.connect(new StdioServerTransport());
