// Bundling guard: the deployed Hub must receive persistent Durable Object storage.
export class DatabaseSync {
  constructor() { throw new Error("Cloudflare requires DurableSqlite storage"); }
}
