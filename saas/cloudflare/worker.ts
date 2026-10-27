import { DurableObject } from "cloudflare:workers";
import { handleAsNodeRequest } from "cloudflare:node";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { createApp } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { HttpError } from "../src/schema.ts";
import type { GatewaySocket } from "../src/broker.ts";
import { DurableSqlite } from "./sqlite.ts";
import { apiContract, discovery } from "../src/api-contract.ts";

class NativeSocket extends EventEmitter implements GatewaySocket {
  constructor(private socket: WebSocket) {
    super();
    socket.addEventListener("message", event => {
      const bytes = typeof event.data === "string" ? Buffer.from(event.data) : Buffer.from(event.data);
      if (bytes.length > 65536) { this.close(4002, "frame too large"); return; }
      this.emit("message", bytes);
    });
    socket.addEventListener("error", () => this.emit("error"));
    socket.addEventListener("close", () => this.emit("close"));
  }
  get readyState() { return this.socket.readyState; }
  send(data: string, callback?: (error?: Error) => void) {
    try { this.socket.send(data); callback?.(); } catch { callback?.(new Error("gateway unavailable")); }
  }
  close(code = 1000, reason = "") { this.socket.close(code, reason); }
  terminate() { this.close(4004, "reconnect"); }
}

export class SaasHub extends DurableObject<Env> {
  private app: ReturnType<typeof createApp>;
  private ready: Promise<number>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const store = new Store(":memory:", new DurableSqlite(ctx.storage));
    this.app = createApp({ database: ":memory:", store, publicUrl: env.PUBLIC_URL, allowSignup: env.ALLOW_SIGNUP === "true",
      nativeWebSockets: false, serveStatic: false,
      google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? {clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET} : undefined });
    this.ready = new Promise((resolve, reject) => {
      this.app.server.once("error", reject);
      this.app.server.listen(0, () => {
        const address = this.app.server.address();
        if (!address || typeof address === "string") { reject(new Error("HTTP adapter unavailable")); return; }
        resolve(address.port);
      });
    });
  }
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      let row;
      try {
        row = this.app.authenticateGateway({url:request.url,authorization:request.headers.get("authorization") ?? undefined,
          origin:request.headers.get("origin") ?? undefined,ip:request.headers.get("cf-connecting-ip") ?? "unknown"});
      } catch (error) { return Response.json({error:"Gateway authentication rejected"},{status:error instanceof HttpError ? error.status : 401}); }
      const pair = new WebSocketPair();
      pair[1].accept();
      this.app.broker.connect(new NativeSocket(pair[1]), row.id);
      return new Response(null, {status:101,webSocket:pair[0]});
    }
    return handleAsNodeRequest(await this.ready, request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== new URL(env.PUBLIC_URL).origin) return new Response("Unknown site",{status:404});
    // Public contract and version routing live at the edge. Long-lived gateway WebSockets
    // can keep an older Durable Object isolate alive during rollout; the existing /api
    // endpoints remain the authority for authentication, authorization and audit.
    if (request.method === "GET" && ["/.well-known/meshmind.json", "/api/v1/openapi.json"].includes(url.pathname)) {
      return Response.json(url.pathname.startsWith("/.well-known") ? discovery(url.origin) : apiContract, {
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "strict-transport-security": "max-age=31536000" },
      });
    }
    if (url.pathname.startsWith("/api/v1/")) {
      const legacyPath = "/api/" + url.pathname.slice("/api/v1/".length);
      const state = /^\/api\/devices\/(dev_[a-f0-9]{24})\/state$/.exec(legacyPath);
      if (state && request.method === "GET") {
        const catalogUrl = new URL("/api/devices", url.origin);
        const catalogResponse = await env.SAAS_HUB.getByName("meshmind-v3").fetch(new Request(catalogUrl, request));
        if (!catalogResponse.ok) return catalogResponse;
        const catalog = await catalogResponse.json() as { devices?: Array<{ id: string; connector: string }> };
        const device = catalog.devices?.find(item => item.id === state[1]);
        if (!device) return Response.json({ error: "设备不存在" }, { status: 404 });
        const route = device.connector === "adb" ? "adb-status"
          : ["esp32_serial", "home_assistant"].includes(device.connector) ? "device-status" : "status";
        const stateUrl = new URL(`/api/devices/${state[1]}/${route}`, url.origin);
        const result = await env.SAAS_HUB.getByName("meshmind-v3").fetch(new Request(stateUrl, request));
        if (!result.ok) return result;
        return Response.json({ connector: device.connector, ...await result.json() as object }, {
          headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "strict-transport-security": "max-age=31536000" },
        });
      }
      const legacyUrl = new URL(request.url);
      legacyUrl.pathname = legacyPath;
      return env.SAAS_HUB.getByName("meshmind-v3").fetch(new Request(legacyUrl, request));
    }
    const releases = ["MeshMind-Connect-macOS-arm64-0.1.0.zip", "MeshMind-Connect-macOS-arm64-0.1.1.zip"];
    if ((request.method === "GET" || request.method === "HEAD") &&
        releases.some(archive => [archive, archive + ".sha256"].includes(url.pathname.slice("/downloads/".length))) &&
        url.pathname.startsWith("/downloads/")) {
      const key = url.pathname.slice("/downloads/".length);
      const wantsRange = request.method === "GET" && request.headers.has("range");
      const object = await env.RELEASES.get(key, wantsRange ? { range: request.headers } : undefined);
      if (!object) return new Response("Release unavailable",{status:404});
      const headers = new Headers({
        "content-type": key.endsWith(".zip") ? "application/zip" : "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${key}"`,
        "content-length": String(object.size),
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "strict-transport-security": "max-age=31536000",
      });
      headers.set("etag", object.httpEtag);
      let status = 200;
      if (wantsRange && object.range && "offset" in object.range && object.range.offset !== undefined &&
          "length" in object.range && object.range.length !== undefined) {
        status = 206;
        headers.set("content-range", `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
        headers.set("content-length", String(object.range.length));
      }
      return new Response(request.method === "HEAD" ? null : object.body, {status,headers});
    }
    if ((request.method === "GET" || request.method === "HEAD") && ["/","/docs/agent-api","/app.js","/app.css","/meshmind-cli.mjs","/favicon.ico"].includes(url.pathname)) {
      if (url.pathname === "/favicon.ico") return new Response(null,{status:204});
      // Static Assets canonicalizes *.html to extensionless URLs.
      const assetUrl = url.pathname === "/docs/agent-api" ? new URL("/agent-api", url.origin) : url;
      const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
      const response = new Response(asset.body,asset);
      response.headers.set("cache-control","no-store");
      response.headers.set("x-content-type-options","nosniff");
      response.headers.set("referrer-policy","no-referrer");
      response.headers.set("strict-transport-security","max-age=31536000");
      response.headers.set("content-security-policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      return response;
    }
    return env.SAAS_HUB.getByName("meshmind-v3").fetch(request);
  },
} satisfies ExportedHandler<Env>;
