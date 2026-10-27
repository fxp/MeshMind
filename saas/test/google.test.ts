import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { createApp } from "../src/server.ts";
import { GoogleIdentityProvider } from "../src/google.ts";
import { seedOwner } from "./support/owner.ts";

const config = { clientId: "test-client.apps.googleusercontent.com", clientSecret: "synthetic-test-client-secret" };
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const malicious = generateKeyPairSync("rsa", { modulusLength: 2048 });
type Claims = Record<string, unknown>;
function signedJwt(claims: Claims, wrongKey = false) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = header + "." + payload;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), (wrongKey ? malicious : keys).privateKey).toString("base64url");
}

async function fixture(allowSignup = true, googleEnabled = true, secure = false, trustedClientIpHeader = false) {
  const codes = new Map<string, { claims: Claims; verifier: string; badSignature: boolean }>();
  const client = new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: "http://localhost/api/auth/google/callback" });
  let exchanges = 0;
  // Stub only Google's network endpoints. Its real SDK still verifies signed ID tokens.
  Object.defineProperty(client, "getToken", { value: async (input: { code: string; codeVerifier: string }) => {
    exchanges++;
    const code = codes.get(input.code);
    if (!code || code.verifier !== input.codeVerifier) throw new Error("invalid grant");
    codes.delete(input.code);
    return { tokens: { id_token: signedJwt(code.claims, code.badSignature), access_token: "must-not-be-stored", refresh_token: "must-not-be-stored-either" }, res: null };
  } });
  Object.defineProperty(client, "getFederatedSignonCertsAsync", { value: async () => ({ certs: { "test-key": keys.publicKey.export({ type: "spki", format: "pem" }) }, format: "PEM" }) });
  const origin = secure ? "https://mesh.example.test" : "http://localhost";
  const app = createApp({ database: ":memory:", publicUrl: origin, allowSignup, trustedClientIpHeader,
    google: googleEnabled ? config : undefined, googleProvider: new GoogleIdentityProvider(config, origin + "/api/auth/google/callback", client) });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = async (path: string, options: { cookie?: string; body?: unknown; method?: string; origin?: string; authorization?: string; clientIp?: string } = {}) => {
    const headers: Record<string, string> = { origin: options.origin ?? origin, "content-type": "application/json" };
    if (options.cookie) headers.cookie = options.cookie;
    if (options.authorization) headers.authorization = options.authorization;
    if (options.clientIp) headers["x-meshmind-client-ip"] = options.clientIp;
    return fetch(base + path, { method: options.method ?? (options.body === undefined ? "GET" : "POST"), headers, redirect: "manual", body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  };
  const cookie = (res: Response, name: string) => res.headers.getSetCookie().find(c => c.startsWith(name + "="))?.split(";")[0];
  const begin = async (owner?: string) => {
    const response = await call(owner ? "/api/auth/google/link" : "/api/auth/google", owner ? { cookie: owner, body: {} } : {});
    const location = owner ? (await response.json() as { url: string }).url : response.headers.get("location")!;
    const authUrl = new URL(location);
    const state = authUrl.searchParams.get("state")!;
    const record = app.store.db.prepare("SELECT verifier FROM oauth_attempts WHERE state_hash=?")
      .get(createHash("sha256").update(state).digest("hex")) as { verifier: string };
    return { response, authUrl, state, verifier: record.verifier, cookie: cookie(response, "meshmind_google")! };
  };
  const issue = (flow: Awaited<ReturnType<typeof begin>>, overrides: Claims = {}, badSignature = false) => {
    const code = "test-code-" + codes.size + "-" + Math.random();
    const now = Math.floor(Date.now() / 1000);
    codes.set(code, { claims: { iss: "https://accounts.google.com", aud: config.clientId, sub: "google-user-1", email: "google-user@example.test", email_verified: true,
      nonce: flow.authUrl.searchParams.get("nonce"), iat: now, exp: now + 3600, ...overrides }, verifier: flow.verifier, badSignature });
    return `/api/auth/google/callback?state=${encodeURIComponent(flow.state)}&code=${encodeURIComponent(code)}`;
  };
  return { app, call, begin, issue, cookie, exchanges: () => exchanges };
}

test("Google OIDC authorization, account identity and replay protection", async t => {
  const f = await fixture();
  try {
    await t.test("start uses minimal scopes, PKCE S256 and browser-bound Lax HttpOnly cookie", async () => {
      const flow = await f.begin();
      assert.equal(flow.response.status, 303);
      assert.equal(flow.authUrl.hostname, "accounts.google.com");
      assert.equal(flow.authUrl.searchParams.get("scope"), "openid email");
      assert.equal(flow.authUrl.searchParams.get("code_challenge_method"), "S256");
      assert.equal(flow.authUrl.searchParams.get("code_challenge"), createHash("sha256").update(flow.verifier).digest("base64url"));
      assert.match(flow.response.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/);
      assert.equal(flow.authUrl.toString().includes(config.clientSecret), false);
      assert.equal(flow.authUrl.toString().includes(flow.verifier), false);
      const production = new GoogleIdentityProvider(config, "https://mesh.example.test/api/auth/google/callback");
      assert.equal(new URL(production.authorizationUrl({ state: "state", nonce: "nonce", challenge: "challenge" })).searchParams.get("redirect_uri"), "https://mesh.example.test/api/auth/google/callback");
    });
    let ownerCookie = "", accountId = "";
    await t.test("verified Google identity creates an isolated account and a normal owner session", async () => {
      const flow = await f.begin(), callback = f.issue(flow);
      const response = await f.call(callback, { cookie: flow.cookie });
      assert.equal(response.status, 303); assert.equal(response.headers.get("location"), "/");
      ownerCookie = f.cookie(response, "meshmind_session")!;
      assert.ok(ownerCookie); assert.match(response.headers.getSetCookie().find(c => c.startsWith("meshmind_session="))!, /SameSite=Strict/);
      assert.match(response.headers.getSetCookie().find(c => c.startsWith("meshmind_google="))!, /Max-Age=0/);
      const session = await (await f.call("/api/session", { cookie: ownerCookie })).json() as any;
      assert.equal(session.owner, true); assert.equal(session.googleLinked, true);
      const row = f.app.store.db.prepare("SELECT * FROM accounts WHERE email=?").get("google-user@example.test") as { id: string; password: string };
      accountId = row.id; assert.equal(row.password, "!google-only");
      assert.equal((await f.call("/api/login", { body: { email: "google-user@example.test", password: "some-made-up-password" } })).status, 410);
      const replay = await f.call(callback, { cookie: flow.cookie });
      assert.equal(replay.headers.get("location"), "/?auth_error=google_invalid_state");
      assert.equal(f.cookie(replay, "meshmind_session"), undefined);
    });
    await t.test("login uses Google's stable subject even if the Google email changes", async () => {
      const flow = await f.begin();
      const response = await f.call(f.issue(flow, { email: "changed-google-email@example.test" }), { cookie: flow.cookie });
      assert.equal(response.headers.get("location"), "/");
      assert.equal((f.app.store.db.prepare("SELECT count(*) AS n FROM accounts").get() as { n: number }).n, 1);
      assert.equal((f.app.store.db.prepare("SELECT account_id FROM account_identities WHERE subject=?").get("google-user-1") as { account_id: string }).account_id, accountId);
    });
    await t.test("missing or incorrect browser binding does not consume someone else's state", async () => {
      const flow = await f.begin(), callback = f.issue(flow);
      const before = f.exchanges();
      for (const cookie of [undefined, "meshmind_google=incorrect-browser-binding-value"]) {
        const response = await f.call(callback, { cookie });
        assert.equal(response.headers.get("location"), "/?auth_error=google_invalid_state");
        assert.equal(f.cookie(response, "meshmind_session"), undefined);
      }
      assert.equal(f.exchanges(), before);
      assert.equal((await f.call(callback, { cookie: flow.cookie })).headers.get("location"), "/");
    });
    await t.test("expired state and cancellation cannot create sessions", async () => {
      const expired = await f.begin();
      f.app.store.db.prepare("UPDATE oauth_attempts SET expires_at=0 WHERE state_hash=?").run(createHash("sha256").update(expired.state).digest("hex"));
      assert.equal((await f.call(f.issue(expired), { cookie: expired.cookie })).headers.get("location"), "/?auth_error=google_invalid_state");
      const cancelled = await f.begin();
      const response = await f.call(`/api/auth/google/callback?state=${cancelled.state}&error=access_denied`, { cookie: cancelled.cookie });
      assert.equal(response.headers.get("location"), "/?auth_error=google_cancelled");
      assert.equal(f.cookie(response, "meshmind_session"), undefined);
    });
    await t.test("bad signature, issuer, audience, expiry, nonce or unverified email are rejected", async () => {
      const cases: [Claims, boolean, string][] = [
        [{}, true, "google_failed"], [{ iss: "https://attacker.test" }, false, "google_failed"],
        [{ aud: "another-client" }, false, "google_failed"], [{ exp: Math.floor(Date.now()/1000)-1000 }, false, "google_failed"],
        [{ nonce: "nonce-from-another-browser-session" }, false, "google_invalid_state"],
        [{ email_verified: false }, false, "google_email_unverified"],
      ];
      for (const [overrides, badSignature, code] of cases) {
        const flow = await f.begin();
        const response = await f.call(f.issue(flow, overrides, badSignature), { cookie: flow.cookie });
        assert.equal(response.headers.get("location"), "/?auth_error=" + code);
        assert.equal(f.cookie(response, "meshmind_session"), undefined);
      }
    });
    await t.test("Google access and refresh tokens are not retained in database or audit", () => {
      for (const table of ["accounts", "account_identities", "audit", "sessions", "oauth_attempts"]) {
        const data = JSON.stringify(f.app.store.db.prepare("SELECT * FROM " + table).all());
        assert.equal(data.includes("must-not-be-stored"), false); assert.equal(data.includes(config.clientSecret), false);
      }
    });
  } finally { await f.app.close(); }
});

test("existing local accounts require explicit Google linking", async t => {
  const f = await fixture();
  try {
    const ownerCookie = seedOwner(f.app.store, "local@example.test");
    const localAccount = f.app.store.db.prepare("SELECT id FROM accounts WHERE email='local@example.test'").get() as { id: string };
    await t.test("matching email never automatically merges an unverified local account", async () => {
      const flow = await f.begin();
      const response = await f.call(f.issue(flow, { email: "local@example.test" }), { cookie: flow.cookie });
      assert.equal(response.headers.get("location"), "/?auth_error=google_account_exists");
      assert.equal(f.cookie(response, "meshmind_session"), undefined);
      assert.equal(f.app.store.db.prepare("SELECT * FROM account_identities").get(), undefined);
    });
    await t.test("link initiation requires the current owner and a same-origin POST", async () => {
      assert.equal((await f.call("/api/auth/google/link", { body: {} })).status, 401);
      assert.equal((await f.call("/api/auth/google/link", { body: {}, cookie: ownerCookie, origin: "https://attacker.test" })).status, 403);
    });
    await t.test("the initiating owner can explicitly link and keep their existing device space", async () => {
      const gateway = await (await f.call("/api/gateways", { cookie: ownerCookie, body: { name: "Existing devices stay here" } })).json() as { gatewayId: string };
      const flow = await f.begin(ownerCookie);
      // The Strict owner cookie is deliberately absent from the cross-site callback.
      const response = await f.call(f.issue(flow, { email: "local@example.test" }), { cookie: flow.cookie });
      assert.equal(response.headers.get("location"), "/?auth_success=google_linked");
      const after = await (await f.call("/api/gateways", { cookie: f.cookie(response, "meshmind_session") })).json() as { gateways: { id: string }[] };
      assert.equal(after.gateways[0].id, gateway.gatewayId);
      assert.equal((f.app.store.db.prepare("SELECT account_id FROM account_identities").get() as { account_id: string }).account_id, localAccount.id);
      const flow2 = await f.begin();
      assert.equal((await f.call(f.issue(flow2, { email: "local@example.test" }), { cookie: flow2.cookie })).headers.get("location"), "/");
      assert.equal((f.app.store.db.prepare("SELECT count(*) AS n FROM accounts").get() as { n: number }).n, 1);
    });
    await t.test("a different Google identity cannot silently replace the linked identity", async () => {
      const flow = await f.begin(ownerCookie);
      const response = await f.call(f.issue(flow, { sub: "another-google-subject", email: "another@example.test" }), { cookie: flow.cookie });
      assert.equal(response.headers.get("location"), "/?auth_error=google_link_conflict");
    });
    await t.test("a Google identity cannot be linked into a second tenant", async () => {
      const second = seedOwner(f.app.store, "another-owner@example.test");
      const flow = await f.begin(second);
      const response = await f.call(f.issue(flow), { cookie: flow.cookie });
      assert.equal(response.headers.get("location"), "/?auth_error=google_link_conflict");
      assert.equal((f.app.store.db.prepare("SELECT account_id FROM account_identities WHERE subject='google-user-1'").get() as { account_id: string }).account_id, localAccount.id);
    });
    await t.test("logging out the initiating session invalidates an in-flight account link", async () => {
      const flow = await f.begin(ownerCookie);
      await f.call("/api/logout", { cookie: ownerCookie, body: {} });
      const response = await f.call(f.issue(flow, { email: "local@example.test" }), { cookie: flow.cookie });
      assert.equal(response.headers.get("location"), "/?auth_error=google_link_expired");
    });
  } finally { await f.app.close(); }
});

test("Google login respects deployment settings and secure cookie flags", async () => {
  const disabled = await fixture(true, false);
  try { assert.deepEqual(await (await disabled.call("/api/auth/providers")).json(), { google: false }); assert.equal((await disabled.call("/api/auth/google")).status, 503); }
  finally { await disabled.app.close(); }
  const closed = await fixture(false, true, true);
  try {
    const flow = await closed.begin();
    assert.match(flow.response.headers.get("set-cookie")!, /; Secure/);
    const response = await closed.call(closed.issue(flow), { cookie: flow.cookie });
    assert.equal(response.headers.get("location"), "/?auth_error=google_signup_closed");
    assert.equal(closed.cookie(response, "meshmind_session"), undefined);
    closed.app.store.db.prepare("INSERT INTO accounts(id,email,password,created_at) VALUES('existing-owner','existing@example.test','!google-only',?)").run(Date.now());
    closed.app.store.db.prepare("INSERT INTO account_identities(provider,subject,account_id,email) VALUES('google','google-user-1','existing-owner','existing@example.test')").run();
    const existing = await closed.begin();
    const login = await closed.call(closed.issue(existing), { cookie: existing.cookie });
    assert.equal(login.headers.get("location"), "/");
    assert.match(login.headers.getSetCookie().find(c => c.startsWith("meshmind_session="))!, /; Secure/);
  } finally { await closed.app.close(); }
});

test("Google start rate limits use a trusted edge address, never a visitor-supplied header on local Hub", async () => {
  const local = await fixture();
  try {
    for (let n = 0; n < 20; n++) assert.equal((await local.call("/api/auth/google", { clientIp: `192.0.2.${n + 1}` })).status, 303);
    assert.equal((await local.call("/api/auth/google", { clientIp: "192.0.2.250" })).status, 429);
  } finally { await local.app.close(); }
  const edge = await fixture(true, true, false, true);
  try {
    for (let n = 0; n < 20; n++) assert.equal((await edge.call("/api/auth/google", { clientIp: "192.0.2.1" })).status, 303);
    assert.equal((await edge.call("/api/auth/google", { clientIp: "192.0.2.1" })).status, 429);
    assert.equal((await edge.call("/api/auth/google", { clientIp: "192.0.2.2" })).status, 303);
  } finally { await edge.app.close(); }
});
