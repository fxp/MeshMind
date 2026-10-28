import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

const sha256 = value => createHash("sha256").update(value).digest("hex");

test("public Agent assets are immutable, checksummed, and referenced by exact digest", async () => {
  const [skill, skillSum, cli, cliSum, homepage] = await Promise.all([
    readFile("public/skills/meshmind/v1.0.0/SKILL.md"),
    readFile("public/skills/meshmind/v1.0.0/SKILL.md.sha256", "utf8"),
    readFile("public/downloads/meshmind-cli-0.1.0.mjs"),
    readFile("public/downloads/meshmind-cli-0.1.0.mjs.sha256", "utf8"),
    readFile("public/index.html", "utf8"),
  ]);
  const skillDigest = sha256(skill), cliDigest = sha256(cli);
  assert.equal(skillSum, `${skillDigest}  SKILL.md\n`);
  assert.equal(cliSum, `${cliDigest}  meshmind-cli-0.1.0.mjs\n`);
  assert.match(homepage, new RegExp(skillDigest, "g"));
  assert.match(homepage, new RegExp(cliDigest));
  assert.doesNotMatch(homepage, /downloads\/MeshMind-Connect-macOS-arm64-0\.1\.2\.zip/);
});

test("release build requires Developer ID signing and notarization", async () => {
  const build = await readFile("macos/build.sh", "utf8");
  assert.match(build, /MESHMIND_CODESIGN_IDENTITY/);
  assert.match(build, /MESHMIND_NOTARY_PROFILE/);
  assert.match(build, /--options runtime --timestamp/);
  assert.match(build, /notarytool submit/);
  assert.match(build, /stapler staple/);
  assert.match(build, /spctl --assess/);
});
