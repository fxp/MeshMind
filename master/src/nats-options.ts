const servers = process.env.NATS_URL ?? "nats://localhost:4222";
const user = process.env.NATS_USERNAME;
const pass = process.env.NATS_PASSWORD;

if (!!user !== !!pass) throw new Error("NATS_USERNAME and NATS_PASSWORD must be configured together");

export function natsOptions(name: string) {
  return { servers, name, ...(user && pass ? { user, pass } : {}) };
}

export function natsDisplayUrl() {
  try {
    const value = new URL(servers);
    if (value.username || value.password) value.username = value.password = "redacted";
    return value.toString().replace(/\/$/, "");
  } catch {
    return "configured NATS endpoint";
  }
}
