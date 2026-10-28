#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["Google OAuth client secret", /GOCSPX-[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["Slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["Stripe live key", /(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ["Cloudflare API token", /(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN)\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/i],
];

function git(...args) {
  return execFileSync("git", args, { encoding: args.includes("blob") ? "buffer" : "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const objects = git("rev-list", "--objects", "--all").trim().split("\n").filter(Boolean);
const scanned = new Set();
const findings = [];
function scanBlob(sha, path) {
  if (scanned.has(sha) || git("cat-file", "-t", sha).trim() !== "blob") return;
  scanned.add(sha);
  if (Number(git("cat-file", "-s", sha).trim()) > 2_000_000) return;
  const bytes = git("cat-file", "blob", sha);
  if (bytes.subarray(0, 8192).includes(0)) return;
  const text = bytes.toString("utf8");
  for (const [name, pattern] of patterns) {
    const match = pattern.exec(text);
    if (match) findings.push({ path, blob: sha.slice(0, 12), line: text.slice(0, match.index).split("\n").length, type: name });
  }
}

for (const row of objects) {
  const separator = row.indexOf(" ");
  const sha = separator === -1 ? row : row.slice(0, separator);
  const path = separator === -1 ? "<historical object>" : row.slice(separator + 1);
  scanBlob(sha, path);
}

// Include the staged index so the scanner can block a secret before it becomes
// part of history. CI sees the same files through the commit scan above.
for (const row of git("ls-files", "-s", "-z").split("\0").filter(Boolean)) {
  const match = /\d+ ([0-9a-f]{40,64}) \d+\t(.+)/.exec(row);
  if (match) scanBlob(match[1], match[2]);
}

if (findings.length) {
  console.error(JSON.stringify({ error: "Potential committed secrets detected", findings }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, gitObjectsScanned: scanned.size, findings: 0 }));
