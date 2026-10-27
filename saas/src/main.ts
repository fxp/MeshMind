import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.ts";

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const port = Number(process.env.PORT ?? 8788);
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
const url = new URL(publicUrl);
const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("非本机部署必须配置 HTTPS PUBLIC_URL");
if (url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new Error("PUBLIC_URL 必须是无路径、无凭证的站点地址");
const tls = process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE ? {
  cert: readFileSync(process.env.TLS_CERT_FILE), key: readFileSync(process.env.TLS_KEY_FILE),
} : undefined;
if (!!process.env.TLS_CERT_FILE !== !!process.env.TLS_KEY_FILE) throw new Error("TLS_CERT_FILE 和 TLS_KEY_FILE 必须同时设置");
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim(), googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
if (!!googleClientId !== !!googleClientSecret) throw new Error("GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET 必须同时设置");
const app = createApp({ database: resolve(process.env.DATABASE ?? "data/meshmind.sqlite"), publicUrl,
  allowSignup: process.env.ALLOW_SIGNUP === "true" || (process.env.NODE_ENV !== "production" && process.env.ALLOW_SIGNUP !== "false"), tls,
  google: googleClientId && googleClientSecret ? { clientId: googleClientId, clientSecret: googleClientSecret } : undefined });
app.server.listen(port, process.env.BIND_HOST ?? "127.0.0.1", () => console.log(`MeshMind ready: ${publicUrl}`));
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (stopping) return; stopping = true;
  app.close().then(() => process.exit(0));
});
