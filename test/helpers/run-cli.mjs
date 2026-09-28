import { spawn } from "node:child_process";
import path from "node:path";

import { FAKE_MCPORTER_DIR, FETCH_REDIRECT_PRELOAD, SCRIPT_PATH } from "./paths.mjs";

/**
 * Run the wrapper in a child process with a controlled environment. The
 * fetch-redirect preload sends the fixed Dropbox endpoint to `tokenUrl`.
 * `withFakeMcporter` puts the fake executable first on PATH; otherwise PATH
 * is an empty directory so no real mcporter can be found.
 */
export function runCli(args, { env = {}, tokenUrl, withFakeMcporter = false, emptyBinDir, cwd } = {}) {
  const pathEntries = [];
  if (withFakeMcporter) pathEntries.push(FAKE_MCPORTER_DIR);
  if (emptyBinDir) pathEntries.push(emptyBinDir);
  // node itself must stay reachable for the fake mcporter shebang.
  pathEntries.push(path.dirname(process.execPath));

  const childEnv = {
    PATH: pathEntries.join(path.delimiter),
    HOME: env.HOME ?? process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    DROPBOX_TEST_TOKEN_URL: tokenUrl ?? "",
    ...env,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", FETCH_REDIRECT_PRELOAD, SCRIPT_PATH, ...args], {
      env: childEnv,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** Parse the JSON line printed by the fake mcporter. */
export function fakeReport(stdout) {
  const line = stdout.split("\n").find((l) => l.startsWith("{"));
  if (!line) throw new Error(`fake mcporter produced no report; stdout was: ${JSON.stringify(stdout)}`);
  return JSON.parse(line);
}
