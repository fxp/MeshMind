import type { SyncDatabase, SqlValue } from "../src/store.ts";

/** Execute the existing parameterized SQLite schema in persistent DO storage. */
export class DurableSqlite implements SyncDatabase {
  constructor(private storage: DurableObjectStorage) {}
  exec(query: string) {
    const sql = query.replace(/PRAGMA journal_mode = WAL;/g, "").replace(/PRAGMA busy_timeout = 5000;/g, "");
    if (sql.trim()) this.storage.sql.exec(sql).toArray();
  }
  prepare(sql: string) {
    const query = (...values: SqlValue[]): Record<string, SqlValue>[] => this.storage.sql.exec(sql, ...values).toArray()
      .map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof ArrayBuffer ? new Uint8Array(value) : value])));
    return { run: query, get: (...values: SqlValue[]) => query(...values)[0], all: query };
  }
  transaction<T>(callback: () => T): T { return this.storage.transactionSync(callback); }
  close() { /* Storage lifetime belongs to the Durable Object runtime. */ }
}
