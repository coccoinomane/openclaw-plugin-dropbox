import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { REPO_ROOT } from "./helpers/paths.mjs";

const execFileAsync = promisify(execFile);

test("package.json points OpenClaw at the built JS entry and has no runtime dependencies", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.openclaw.extensions, ["./index.js"]);
  await fs.access(path.join(REPO_ROOT, "index.js"));
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  assert.equal(pkg.devDependencies, undefined, "tests use node:test only");
  assert.equal(pkg.bundledDependencies, undefined);
  assert.equal(pkg.peerDependenciesMeta?.openclaw?.optional, true);
  assert.equal("mcporter" in (pkg.peerDependencies ?? {}), false, "mcporter is an external CLI, never an npm dependency");
  assert.ok(pkg.openclaw.compat.minGatewayVersion);
});

test("npm pack --dry-run includes the runtime files and excludes tests and secrets", async (t) => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  let stdout;
  try {
    ({ stdout } = await execFileAsync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024 }));
  } catch (err) {
    if (err.code === "ENOENT") {
      t.skip("npm is not available on PATH");
      return;
    }
    throw err;
  }
  const [result] = JSON.parse(stdout);
  const files = result.files.map((f) => f.path);
  const required = [
    "index.js",
    "src/plugin.mjs",
    "openclaw.plugin.json",
    "package.json",
    "README.md",
    "LICENSE",
    ".env.example",
    "skills/dropbox/SKILL.md",
    "skills/dropbox/scripts/dropbox-mcporter.mjs",
    "skills/dropbox/scripts/lib/cli.mjs",
    "skills/dropbox/scripts/lib/token.mjs",
    "skills/dropbox/scripts/lib/lock.mjs",
    "skills/dropbox/scripts/lib/refresh.mjs",
  ];
  for (const file of required) assert.ok(files.includes(file), `${file} must be packed`);
  for (const file of files) {
    assert.ok(!file.startsWith("test/"), `${file} must not be packed`);
    assert.ok(!/(^|\/)\.env$/.test(file) && !/token-cache\.json$/.test(file) && !/\.env$/.test(file), `${file} looks like a secret`);
  }
  assert.equal(result.name, "openclaw-plugin-dropbox");
});
