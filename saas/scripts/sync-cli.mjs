import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const cliVersion = "0.1.0";
const skillVersion = "1.0.0";
const cliSha256 = "a8840a3bcf361ec3a4172bbd98a52ff60920999e0058ff159e7df6fc479ae9d8";
const skillSha256 = "40f9ad20b55c9b2c01c1c14d250e447ec07cecb1129500780162a83cda32a8f3";
const cli = await readFile(new URL("../bin/meshmind.mjs", import.meta.url));
const skill = await readFile(new URL("../public/skills/meshmind/SKILL.md", import.meta.url));

async function publish(directory, filename, content, expectedDigest) {
  await mkdir(directory, { recursive: true });
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== expectedDigest) throw new Error(`${filename} changed without a version and digest update`);
  await writeFile(new URL(filename, directory), content);
  await writeFile(new URL(filename + ".sha256", directory), `${digest}  ${filename}\n`);
}

// Unversioned CLI remains for local compatibility. Public documentation and the
// edge Worker redirect clients to the immutable, checksummed path below.
await writeFile(new URL("../public/meshmind-cli.mjs", import.meta.url), cli);
await publish(new URL("../public/downloads/", import.meta.url), `meshmind-cli-${cliVersion}.mjs`, cli, cliSha256);
await publish(new URL(`../public/skills/meshmind/v${skillVersion}/`, import.meta.url), "SKILL.md", skill, skillSha256);
