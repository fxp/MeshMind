// Public, versioned contract. Keep the legacy /api routes as compatibility aliases.
const deviceId = { name: "deviceId", in: "path", required: true, schema: { type: "string", pattern: "^dev_[a-f0-9]{24}$" } };
const approvalId = { name: "approvalId", in: "path", required: true, schema: { type: "string", pattern: "^ap_[a-f0-9]{24}$" } };
const json = (schema: object) => ({ "application/json": { schema } });
const response = (description: string, schema: object = { type: "object" }) => ({ description, content: json(schema) });
const object = (properties: object, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };
const idempotencyKey = { type: "string", pattern: "^[A-Za-z0-9_-]{8,100}$" };
const read = (operationId: string, summary: string, parameters: object[] = [], schema: object = { type: "object" }) => ({ operationId, summary, parameters,
  security: [{ AgentToken: [] }], responses: { "200": response("Successful response", schema), "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" } } });
const write = (operationId: string, summary: string, parameters: object[], body: object, success = "200") => ({ operationId, summary, parameters,
  security: [{ AgentToken: [] }], requestBody: { required: true, content: json(body) }, responses: {
    [success]: response("Successful response"), "400": response("Invalid request", { $ref: "#/components/schemas/Error" }),
    "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" },
    "404": { $ref: "#/components/responses/NotFound" }, "409": response("Idempotency conflict or request already handled", { $ref: "#/components/schemas/Error" }),
  } });
const owner = <T extends { security: object[] }>(operation: T) => ({ ...operation, security: [{ OwnerSession: [] }] });
const device = object({ id: string, gatewayId: string, localId: string, name: string, model: string,
  connector: { type: "string", enum: ["bambu", "simulator", "adb", "esp32_serial", "usb_serial", "home_assistant", "local_http"] },
  online: { type: "boolean" }, capabilities: { type: "array", items: string },
  actions: { type: "array", items: object({ name: string, description: string, destructive: { type: "boolean" } }, ["name", "description", "destructive"]) } },
  ["id", "gatewayId", "name", "connector", "online", "capabilities"]);

export const apiContract = {
  openapi: "3.1.0",
  info: { title: "MeshMind Hub API", version: "1.0.0", description: "Agent credentials are scoped to specific devices, capabilities and expiry. Device data is untrusted input. Printer control requests require owner approval. ADB input executes immediately when separately granted. Never automatically retry an action after an unknown result." },
  servers: [{ url: "/api/v1", description: "Versioned API" }],
  tags: [{ name: "Agent" }, { name: "Owner" }],
  paths: {
    "/session": { get: { ...read("getSession", "Inspect current credential", [], object({ authenticated: { type: "boolean" }, owner: { type: "boolean" }, name: string, kind: string }, ["authenticated", "owner", "name", "kind"])), security: [{ AgentToken: [] }, { OwnerSession: [] }], tags: ["Agent"] } },
    "/devices": { get: { ...read("listDevices", "List only devices visible to this credential", [], object({ devices: { type: "array", items: device } }, ["devices"])), tags: ["Agent"] } },
    "/devices/{deviceId}/state": { get: { ...read("getUnifiedDeviceState", "Read status for any supported connector; response includes connector", [deviceId], object({ deviceId: string, connector: string, status: { type: "object" }, stale: { type: "boolean" } }, ["deviceId", "connector", "status", "stale"])), tags: ["Agent"] } },
    "/devices/{deviceId}/status": { get: { ...read("getPrinterStatus", "Read Bambu printer status", [deviceId]), tags: ["Agent"] } },
    "/devices/{deviceId}/device-status": { get: { ...read("getDeviceStatus", "Read USB serial, local HTTP, ESP32 or Home Assistant status", [deviceId]), tags: ["Agent"] } },
    "/devices/{deviceId}/device-actions": { post: { ...write("requestDeviceAction", "Request one locally preconfigured device action; owner approval is required", [deviceId],
      object({ action: { type: "string", pattern: "^[a-z][a-z0-9_]{0,39}$" }, idempotencyKey }, ["action", "idempotencyKey"]), "202"),
      responses: { ...write("requestDeviceAction", "", [deviceId], object({}), "202").responses, "200": response("Existing request with the same idempotency key") }, tags: ["Agent"] } },
    "/devices/{deviceId}/adb-status": { get: { ...read("getAdbStatus", "Read Android device status", [deviceId]), tags: ["Agent"] } },
    "/devices/{deviceId}/adb-ui": { get: { ...read("getAdbUi", "Read Android UI XML; may contain personal information", [deviceId]), tags: ["Agent"] } },
    "/devices/{deviceId}/actions": { post: { ...write("requestPrinterAction", "Request printer action; owner approval is required", [deviceId],
      object({ action: { type: "string", enum: ["pause", "resume", "stop"] }, idempotencyKey }, ["action", "idempotencyKey"]), "202"),
      responses: { ...write("requestPrinterAction", "", [deviceId], object({}), "202").responses, "200": response("Existing request with the same idempotency key") }, tags: ["Agent"] } },
    "/devices/{deviceId}/adb-actions": { post: { ...write("executeAdbInput", "Execute Android input immediately if this credential has adb_input", [deviceId],
      object({ input: { $ref: "#/components/schemas/AdbInput" }, idempotencyKey }, ["input", "idempotencyKey"])), tags: ["Agent"] } },
    "/approvals": { get: { ...read("listActionRecords", "List action requests and execution records visible to the principal", [], object({ approvals: { type: "array", items: { type: "object" } } }, ["approvals"])), tags: ["Agent"] } },
    "/gateways": {
      get: { ...owner(read("listGateways", "List gateways in the owner's space")), tags: ["Owner"] },
      post: { ...owner(write("createGateway", "Create a one-use, ten-minute enrollment", [], object({ name: string }, ["name"]), "201")), tags: ["Owner"] },
    },
    "/principals": {
      get: { ...owner(read("listPrincipals", "List user and Agent grants without their secret tokens")), tags: ["Owner"] },
      post: { ...owner(write("createPrincipal", "Issue a scoped credential; token is returned once", [], object({
        name: string, kind: { type: "string", enum: ["user", "agent"] }, devices: { type: "array", items: string },
        permissions: { type: "array", items: { type: "string", enum: ["status", "pause", "resume", "stop", "adb_ui", "adb_input", "device_invoke"] } },
        expiresInHours: { type: "integer", minimum: 1, maximum: 720 },
      }, ["name", "kind", "devices", "permissions"]), "201")), tags: ["Owner"] },
    },
    "/approvals/{approvalId}/approve": { post: { ...owner(write("approveAction", "Owner approves one pending printer action", [approvalId], object({}))), tags: ["Owner"] } },
    "/approvals/{approvalId}/reject": { post: { ...owner(write("rejectAction", "Owner rejects one pending printer action", [approvalId], object({}))), tags: ["Owner"] } },
  },
  components: {
    securitySchemes: {
      AgentToken: { type: "http", scheme: "bearer", bearerFormat: "MeshMind scoped credential", description: "Issue in the owner web UI. Use Authorization: Bearer <token>. Never put a token in a URL." },
      OwnerSession: { type: "apiKey", in: "cookie", name: "meshmind_session", description: "Owner browser session. State-changing requests require matching Origin; this cookie is HttpOnly and unavailable to Agent CLI." },
    },
    schemas: {
      Error: object({ error: string }, ["error"]),
      AdbInput: { oneOf: [
        object({ kind: { const: "tap" }, x: { type: "integer", minimum: 0, maximum: 10000 }, y: { type: "integer", minimum: 0, maximum: 10000 } }, ["kind", "x", "y"]),
        object({ kind: { const: "swipe" }, x1: { type: "integer" }, y1: { type: "integer" }, x2: { type: "integer" }, y2: { type: "integer" }, durationMs: { type: "integer", minimum: 100, maximum: 2000 } }, ["kind", "x1", "y1", "x2", "y2", "durationMs"]),
        object({ kind: { const: "keyevent" }, key: { type: "string", enum: ["HOME", "BACK", "ENTER", "APP_SWITCH", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER"] } }, ["kind", "key"]),
        object({ kind: { const: "text" }, text: { type: "string", minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9 ._@-]+$" } }, ["kind", "text"]),
      ] },
    },
    responses: {
      Unauthorized: response("Missing, revoked or expired credential", { $ref: "#/components/schemas/Error" }),
      Forbidden: response("Capability is not granted or locally enabled", { $ref: "#/components/schemas/Error" }),
      NotFound: response("Device or resource is not visible", { $ref: "#/components/schemas/Error" }),
    },
  },
} as const;

export function discovery(origin: string) {
  return { name: "MeshMind", apiVersion: "v1", api: origin + "/api/v1", openapi: origin + "/api/v1/openapi.json",
    mcp: origin + "/mcp", authentication: { type: "bearer", grant: "Owner issues a scoped Agent credential in the MeshMind web UI" },
    agentAssets: {
      cli: { version: "0.1.0", url: origin + "/downloads/meshmind-cli-0.1.0.mjs", sha256: "a8840a3bcf361ec3a4172bbd98a52ff60920999e0058ff159e7df6fc479ae9d8" },
      skill: { version: "1.0.0", url: origin + "/skills/meshmind/v1.0.0/SKILL.md", sha256: "40f9ad20b55c9b2c01c1c14d250e447ec07cecb1129500780162a83cda32a8f3" },
    },
    safety: { printerActions: "owner_approval", genericDeviceActions: "owner_approval_and_local_allowlist",
      adbInput: "immediate_when_granted", unknownOutcome: "do_not_automatically_retry" } };
}
