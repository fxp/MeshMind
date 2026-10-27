import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { IncomingMessage } from "node:http";
import { HttpError } from "./schema.ts";
import { Store, type PrincipalRow } from "./store.ts";

const scrypt = promisify(scryptCallback);
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const secret = (prefix: string) => prefix + randomBytes(32).toString("base64url");
export const id = (prefix: string) => prefix + randomBytes(12).toString("hex");
export const parseBearer = (value?: string) => /^Bearer ([A-Za-z0-9_-]{20,160})$/i.exec(value ?? "")?.[1];
export const bearer = (req: IncomingMessage) => parseBearer(req.headers.authorization);

export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + (await scrypt(password, salt, 64) as Buffer).toString("hex");
}
export async function passwordMatches(password: string, encoded: string) {
  // OAuth-only accounts have no usable password. Still perform the same scrypt work.
  const usable = /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded);
  const [salt, expected] = (usable ? encoded : "0".repeat(32) + ":" + "00".repeat(64)).split(":");
  const got = await scrypt(password, salt, 64) as Buffer;
  const wanted = Buffer.from(expected, "hex");
  return usable && got.length === wanted.length && timingSafeEqual(got, wanted);
}

export function sessionCookie(req: IncomingMessage) {
  return /(?:^|;\s*)meshmind_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "")?.[1];
}

export type Actor = { tenant: string; id: string; owner: true } |
  { tenant: string; id: string; owner: false; principal: PrincipalRow };

export function authenticate(store: Store, req: IncomingMessage): Actor {
  // An invalid Authorization header must never fall back to an owner's cookie.
  if (req.headers.authorization !== undefined) {
    const token = bearer(req);
    const principal = token && store.db.prepare("SELECT * FROM principals WHERE hash=? AND revoked=0 AND expires_at>?")
      .get(hash(token), Date.now()) as PrincipalRow | undefined;
    if (!principal) throw new HttpError(401, "访问凭证无效或已到期");
    return { tenant: principal.tenant_id, id: principal.id, owner: false, principal };
  }
  const cookie = /(?:^|;\s*)meshmind_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "")?.[1];
  const row = cookie && store.db.prepare("SELECT tenant_id FROM sessions WHERE hash=? AND expires_at>?")
    .get(hash(cookie), Date.now()) as { tenant_id: string } | undefined;
  if (!row) throw new HttpError(401, "请先登录");
  return { tenant: row.tenant_id, id: row.tenant_id, owner: true };
}

export function requireOwner(actor: Actor): asserts actor is Actor & { owner: true } {
  if (!actor.owner) throw new HttpError(403, "仅设备所有者可以管理");
}
export function canUse(actor: Actor, deviceId: string, action: string) {
  return actor.owner || (JSON.parse(actor.principal.devices).includes(deviceId) &&
    JSON.parse(actor.principal.permissions).includes(action));
}

export class RateLimiter {
  private buckets = new Map<string, { n: number; until: number }>();
  check(key: string, max: number, interval = 60_000) {
    const now = Date.now();
    if (this.buckets.size > 10000) {
      for (const [k, b] of this.buckets) if (b.until <= now) this.buckets.delete(k);
      if (this.buckets.size > 10000) throw new HttpError(429, "请求过多，请稍后重试");
    }
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) { bucket = { n: 0, until: now + interval }; this.buckets.set(key, bucket); }
    if (++bucket.n > max) throw new HttpError(429, "请求过多，请稍后重试");
  }
}
