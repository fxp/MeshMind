import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { DeviceManifest } from "./schema.ts";

export type SqlValue = string | number | bigint | null | Uint8Array;
export interface SyncDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...values: SqlValue[]): unknown;
    get(...values: SqlValue[]): Record<string, SqlValue> | undefined;
    all(...values: SqlValue[]): Record<string, SqlValue>[];
  };
  close(): void;
  transaction?<T>(callback: () => T): T;
}

export class Store {
  readonly db: SyncDatabase;
  constructor(filename: string, database?: SyncDatabase) {
    if (!database && filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = database ?? new DatabaseSync(filename);
    if (!database && filename !== ":memory:") chmodSync(filename, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES accounts(id), expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_identities (
        provider TEXT NOT NULL CHECK(provider='google'), subject TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id), email TEXT NOT NULL,
        PRIMARY KEY(provider,subject), UNIQUE(provider,account_id)
      );
      CREATE TABLE IF NOT EXISTS oauth_attempts (
        state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, nonce_hash TEXT NOT NULL,
        verifier TEXT NOT NULL, account_id TEXT REFERENCES accounts(id), session_hash TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauth_expiry ON oauth_attempts(expires_at);
      CREATE TABLE IF NOT EXISTS gateways (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL,
        enroll_hash TEXT UNIQUE, enroll_expires INTEGER NOT NULL, public_key TEXT, bearer_hash TEXT UNIQUE,
        revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES accounts(id),
        gateway_id TEXT NOT NULL REFERENCES gateways(id), local_id TEXT NOT NULL,
        manifest TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(gateway_id, local_id)
      );
      CREATE TABLE IF NOT EXISTS principals (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('user','agent')), hash TEXT UNIQUE NOT NULL,
        devices TEXT NOT NULL, permissions TEXT NOT NULL, expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES accounts(id),
        principal_id TEXT NOT NULL REFERENCES principals(id), device_id TEXT NOT NULL REFERENCES devices(id),
        action TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, result TEXT,
        UNIQUE(principal_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS approval_payloads (
        approval_id TEXT PRIMARY KEY REFERENCES approvals(id), payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL REFERENCES accounts(id),
        actor TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL, outcome TEXT NOT NULL, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS devices_tenant ON devices(tenant_id);
      CREATE INDEX IF NOT EXISTS audit_tenant ON audit(tenant_id, seq DESC);
    `);
    // A process restart never replays physical operations whose outcome is unknown.
    this.db.prepare("UPDATE approvals SET state='unknown', result=? WHERE state='executing'")
      .run(JSON.stringify({ error: "Hub 重启，设备执行结果未知；请检查打印机，不会自动重试" }));
  }

  transaction<T>(fn: () => T): T {
    if (this.db.transaction) return this.db.transaction(fn);
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  audit(tenant: string, actor: string, action: string, resource: string, outcome: string) {
    this.db.prepare("INSERT INTO audit(tenant_id, actor, action, resource, outcome, ts) VALUES(?,?,?,?,?,?)")
      .run(tenant, actor, action, resource, outcome, Date.now());
  }

  gateway(id: string): GatewayRow | undefined {
    return this.db.prepare("SELECT * FROM gateways WHERE id=?").get(id) as GatewayRow | undefined;
  }
  device(tenant: string, id: string): DeviceRow | undefined {
    return this.db.prepare("SELECT * FROM devices WHERE tenant_id=? AND id=? AND active=1").get(tenant, id) as DeviceRow | undefined;
  }
  principal(id: string): PrincipalRow | undefined {
    return this.db.prepare("SELECT * FROM principals WHERE id=?").get(id) as PrincipalRow | undefined;
  }
  close() { this.db.close(); }
}

export interface GatewayRow {
  id: string; tenant_id: string; name: string; enroll_hash: string | null; enroll_expires: number;
  public_key: string | null; bearer_hash: string | null; revoked: number; created_at: number;
}
export interface DeviceRow {
  id: string; tenant_id: string; gateway_id: string; local_id: string; manifest: string; active: number;
}
export interface PrincipalRow {
  id: string; tenant_id: string; name: string; kind: "user" | "agent"; hash: string;
  devices: string; permissions: string; expires_at: number; revoked: number; created_at: number;
}
export interface ApprovalRow {
  id: string; tenant_id: string; principal_id: string; device_id: string; action: string;
  idempotency_key: string; state: string; expires_at: number; created_at: number; result: string | null;
}
export function manifest(row: DeviceRow): DeviceManifest { return JSON.parse(row.manifest); }
