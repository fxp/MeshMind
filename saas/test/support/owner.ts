import { hash, id, secret } from "../../src/auth.ts";
import type { Store } from "../../src/store.ts";

// Tests seed an owner session directly so production never exposes a password
// enrollment route solely to support integration fixtures.
export function seedOwner(store: Store, email: string) {
  const account = id("acct_");
  const token = secret("s_");
  store.db.prepare("INSERT INTO accounts(id,email,password,created_at) VALUES(?,?,?,?)")
    .run(account, email, "!google-only", Date.now());
  store.db.prepare("INSERT INTO sessions(hash,tenant_id,expires_at) VALUES(?,?,?)")
    .run(hash(token), account, Date.now() + 86400_000);
  return `meshmind_session=${token}`;
}
