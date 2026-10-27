import type { IncomingMessage, ServerResponse } from "node:http";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { z } from "zod";
import { Store } from "./store.ts";
import { hash, id, secret, sessionCookie, type Actor } from "./auth.ts";

export interface GoogleOptions { clientId: string; clientSecret: string; }
export interface GoogleIdentity { subject: string; email: string; nonce: string; }
export interface GoogleProvider {
  authorizationUrl(input: { state: string; nonce: string; challenge: string }): string;
  identity(code: string, verifier: string): Promise<GoogleIdentity>;
}
export class GoogleLoginError extends Error {
  constructor(public code: string) { super(code); }
}

export class GoogleIdentityProvider implements GoogleProvider {
  private client: OAuth2Client;
  constructor(private config: GoogleOptions, callback: string, client?: OAuth2Client) {
    this.client = client ?? new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: callback,
      transporterOptions: { timeout: 10_000 } });
  }
  authorizationUrl({ state, nonce, challenge }: { state: string; nonce: string; challenge: string }) {
    return this.client.generateAuthUrl({ scope: ["openid", "email"], access_type: "online", prompt: "select_account",
      state, nonce, code_challenge: challenge, code_challenge_method: CodeChallengeMethod.S256 });
  }
  async identity(code: string, verifier: string): Promise<GoogleIdentity> {
    try {
      const { tokens } = await this.client.getToken({ code, codeVerifier: verifier });
      if (!tokens.id_token) throw new GoogleLoginError("google_failed");
      // Google's official library checks signature, issuer, audience and expiry.
      const ticket = await this.client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.clientId });
      const payload = ticket.getPayload();
      if (payload?.email_verified !== true) throw new GoogleLoginError("google_email_unverified");
      const identity = z.object({ sub: z.string().min(1).max(255), email: z.string().trim().email().max(200), nonce: z.string().min(20).max(200) }).parse(payload);
      return { subject: identity.sub, email: identity.email.toLowerCase(), nonce: identity.nonce };
    } catch (err) {
      if (err instanceof GoogleLoginError) throw err;
      // SDK errors can contain authorization codes, tokens or client secrets. Never expose them.
      throw new GoogleLoginError("google_failed");
    }
  }
}

interface Attempt { state_hash: string; browser_hash: string; nonce_hash: string; verifier: string; account_id: string | null; session_hash: string | null; expires_at: number; }
const flowCookie = (req: IncomingMessage) => /(?:^|;\s*)meshmind_google=([A-Za-z0-9_-]{20,200})/.exec(req.headers.cookie ?? "")?.[1];

export class GoogleLogin {
  private provider: GoogleProvider;
  private secure: boolean;
  private inFlight = 0;
  constructor(private store: Store, origin: string, config: GoogleOptions, private allowSignup: boolean, provider?: GoogleProvider) {
    this.secure = origin.startsWith("https:");
    this.provider = provider ?? new GoogleIdentityProvider(config, origin + "/api/auth/google/callback");
  }
  private cookie(value: string, age: number) {
    // Lax is intentional: Google's top-level callback must receive the browser binding.
    return `meshmind_google=${value}; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=${age}${this.secure ? "; Secure" : ""}`;
  }
  begin(req: IncomingMessage, res: ServerResponse, account?: Actor & { owner: true }) {
    const state = secret("gs_"), browser = secret("gb_"), nonce = secret("gn_"), verifier = secret("pkce_");
    const localSession = account ? sessionCookie(req) : undefined;
    if (account && !localSession) throw new GoogleLoginError("google_link_expired");
    this.store.transaction(() => {
      this.store.db.prepare("DELETE FROM oauth_attempts WHERE expires_at<=?").run(Date.now());
      this.store.db.prepare("INSERT INTO oauth_attempts(state_hash,browser_hash,nonce_hash,verifier,account_id,session_hash,expires_at) VALUES(?,?,?,?,?,?,?)")
        .run(hash(state), hash(browser), hash(nonce), verifier, account?.tenant ?? null, localSession ? hash(localSession) : null, Date.now() + 10 * 60_000);
    });
    const challenge = Buffer.from(hash(verifier), "hex").toString("base64url");
    res.setHeader("set-cookie", this.cookie(browser, 600));
    return this.provider.authorizationUrl({ state, nonce, challenge });
  }
  async finish(req: IncomingMessage, res: ServerResponse, params: URLSearchParams) {
    const state = params.get("state"), browser = flowCookie(req);
    if (!state || !browser || !/^[A-Za-z0-9_-]{20,200}$/.test(state) || params.getAll("state").length !== 1) throw new GoogleLoginError("google_invalid_state");
    const attempt = this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT * FROM oauth_attempts WHERE state_hash=?").get(hash(state)) as Attempt | undefined;
      if (!row || row.expires_at <= Date.now() || row.browser_hash !== hash(browser)) throw new GoogleLoginError("google_invalid_state");
      this.store.db.prepare("DELETE FROM oauth_attempts WHERE state_hash=?").run(hash(state));
      return row;
    });
    res.setHeader("set-cookie", this.cookie("", 0));
    if (params.has("error")) throw new GoogleLoginError("google_cancelled");
    const code = params.get("code");
    if (!code || code.length > 4096 || params.getAll("code").length !== 1) throw new GoogleLoginError("google_failed");
    if (this.inFlight >= 4) throw new GoogleLoginError("google_busy");
    this.inFlight++;
    try {
      const identity = await this.provider.identity(code, attempt.verifier);
      if (hash(identity.nonce) !== attempt.nonce_hash) throw new GoogleLoginError("google_invalid_state");
      return this.store.transaction(() => {
        const existing = this.store.db.prepare("SELECT account_id FROM account_identities WHERE provider='google' AND subject=?")
          .get(identity.subject) as { account_id: string } | undefined;
        if (attempt.account_id) {
          // The initiating owner session must still be valid, even though Strict cookies
          // need not accompany Google's cross-site callback.
          const session = this.store.db.prepare("SELECT tenant_id FROM sessions WHERE hash=? AND expires_at>?")
            .get(attempt.session_hash!, Date.now()) as { tenant_id: string } | undefined;
          if (session?.tenant_id !== attempt.account_id) throw new GoogleLoginError("google_link_expired");
          const linked = this.store.db.prepare("SELECT subject FROM account_identities WHERE provider='google' AND account_id=?")
            .get(attempt.account_id) as { subject: string } | undefined;
          if ((existing && existing.account_id !== attempt.account_id) || (linked && linked.subject !== identity.subject)) throw new GoogleLoginError("google_link_conflict");
          if (!existing) this.store.db.prepare("INSERT INTO account_identities(provider,subject,account_id,email) VALUES('google',?,?,?)")
            .run(identity.subject, attempt.account_id, identity.email);
          this.store.audit(attempt.account_id, attempt.account_id, "google.linked", attempt.account_id, "ok");
          return { accountId: attempt.account_id, linked: true };
        }
        if (existing) {
          this.store.db.prepare("UPDATE account_identities SET email=? WHERE provider='google' AND subject=?").run(identity.email, identity.subject);
          this.store.audit(existing.account_id, existing.account_id, "google.login", existing.account_id, "ok");
          return { accountId: existing.account_id, linked: false };
        }
        // Never automatically merge by email: legacy passwords do not prove email ownership.
        if (this.store.db.prepare("SELECT id FROM accounts WHERE email=?").get(identity.email)) throw new GoogleLoginError("google_account_exists");
        if (!this.allowSignup) throw new GoogleLoginError("google_signup_closed");
        const accountId = id("acct_");
        this.store.db.prepare("INSERT INTO accounts(id,email,password,created_at) VALUES(?,?,?,?)")
          .run(accountId, identity.email, "!google-only", Date.now());
        this.store.db.prepare("INSERT INTO account_identities(provider,subject,account_id,email) VALUES('google',?,?,?)")
          .run(identity.subject, accountId, identity.email);
        this.store.audit(accountId, accountId, "google.registered", accountId, "ok");
        return { accountId, linked: false };
      });
    } finally { this.inFlight--; }
  }
}
