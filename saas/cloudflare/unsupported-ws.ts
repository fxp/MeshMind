// The Worker upgrades WebSockets through WebSocketPair, never through node:http.
export class WebSocketServer {
  constructor() { throw new Error("Use the Cloudflare WebSocket transport"); }
}
