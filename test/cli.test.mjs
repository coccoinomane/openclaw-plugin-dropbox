import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { resolveCredentials } from "../skills/dropbox/scripts/lib/credentials.mjs";
import { readCache, writeCache } from "../skills/dropbox/scripts/lib/token-cache.mjs";
import { startTokenServer } from "./helpers/oauth-server.mjs";
import { fakeReport, runCli } from "./helpers/run-cli.mjs";
import { makeTmpDir, writeFile } from "./helpers/tmp.mjs";

const POSIX = process.platform !== "win32";
const SECRETS = ["refresh-secret-value", "app-secret-value"];

/** Build an isolated setup: mcporter config, env file, cache dir, empty bin dir. */
async function setup(t, { envFileContent, config = true } = {}) {
  const root = await makeTmpDir(t);
  const configPath = path.join(root, "mcporter.json");
  if (config) {
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { dropbox: { baseUrl: "https://mcp.dropbox.com/mcp", headers: { Authorization: "Bearer ${DROPBOX_MCP_TOKEN}" } } } }),
    );
  }
  const envFile = path.join(root, "dropbox.env");
  await writeFile(
    envFile,
    envFileContent ?? `DROPBOX_APP_KEY=app-key\nDROPBOX_APP_SECRET=${SECRETS[1]}\nDROPBOX_REFRESH_TOKEN=${SECRETS[0]}\n`,
  );
  const cacheDir = path.join(root, "cache");
  const emptyBinDir = path.join(root, "empty-bin");
  await fs.mkdir(emptyBinDir);
  const env = {
    DROPBOX_MCPORTER_CONFIG: configPath,
    DROPBOX_ENV_FILE: envFile,
    DROPBOX_TOKEN_CACHE_DIR: cacheDir,
    HOME: root,
  };
  return { root, configPath, envFile, cacheDir, emptyBinDir, env };
}

function assertNoSecrets(text, extra = []) {
  for (const secret of [...SECRETS, ...extra]) {
    assert.equal(text.includes(secret), false, `output must not contain ${secret}`);
  }
}

test("help exits 0; unknown command and bad options exit 2", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: dropbox-mcporter\.mjs/);

  const unknown = await runCli(["frobnicate"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command: frobnicate/);

  const badOpt = await runCli(["--bogus", "status"]);
  assert.equal(badOpt.code, 2);

  const noTool = await runCli(["call"]);
  assert.equal(noTool.code, 2);
  assert.match(noTool.stderr, /call requires a tool name/);

  const badTimeout = await runCli(["--timeout-ms", "soon", "status"]);
  assert.equal(badTimeout.code, 2);
});

test("status diagnoses a missing mcporter (exit 4) with install instructions and no secrets", async (t) => {
  const s = await setup(t);
  const server = await startTokenServer(t);
  const res = await runCli(["status", "--json"], { env: s.env, emptyBinDir: s.emptyBinDir, tokenUrl: server.url });
  assert.equal(res.code, 4);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.mcporter.found, false);
  assert.ok(report.problems.some((p) => /npm install -g mcporter/.test(p)));
  assert.equal(report.credentials.refreshToken, "file");
  assert.equal(report.credentials.appSecret, "file");
  assert.equal(report.credentials.canRefresh, true);
  assert.equal(report.config.state, "ok");
  assert.equal(report.config.referencesTokenEnv, true);
  assert.equal(report.cache.state, "missing");
  assertNoSecrets(res.stdout + res.stderr);
  assert.equal(server.requests.length, 0, "status must not refresh");
});

test("status is ready (exit 0) with a fake mcporter, and never refreshes even when the cache is expired", async (t) => {
  const s = await setup(t);
  const server = await startTokenServer(t);
  const creds = await resolveCredentials({ env: {}, envFilePath: s.envFile });
  await writeCache(s.cacheDir, { accessToken: "sl.expired", expiresAt: Date.now() - 1000, obtainedAt: 0, source: "refresh", credentialFingerprint: creds.credentialFingerprint });

  const text = await runCli(["status"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /Dropbox mcporter wrapper: ready/);
  assert.match(text.stdout, /token cache: .*\[expired/);
  assertNoSecrets(text.stdout, ["sl.expired"]);

  const json = await runCli(["status", "--json"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  const report = JSON.parse(json.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.mcporter.found, true);
  assert.equal(report.cache.evaluation, "expired");
  assert.equal(server.requests.length, 0);
});

test("status reports config problems: missing path, missing file, missing server entry, missing placeholder", async (t) => {
  const s = await setup(t);
  const noPath = await runCli(["status", "--json"], { env: { ...s.env, DROPBOX_MCPORTER_CONFIG: "" }, withFakeMcporter: true });
  assert.equal(noPath.code, 3);
  assert.equal(JSON.parse(noPath.stdout).config.state, "not-configured");

  const missing = await runCli(["status", "--json"], { env: { ...s.env, DROPBOX_MCPORTER_CONFIG: path.join(s.root, "nope.json") }, withFakeMcporter: true });
  assert.equal(missing.code, 3);
  assert.equal(JSON.parse(missing.stdout).config.state, "missing");

  await writeFile(s.configPath, JSON.stringify({ mcpServers: { other: {} } }));
  const noServer = await runCli(["status", "--json"], { env: s.env, withFakeMcporter: true });
  assert.equal(noServer.code, 3);
  assert.equal(JSON.parse(noServer.stdout).config.state, "server-missing");

  await writeFile(s.configPath, JSON.stringify({ mcpServers: { dropbox: { baseUrl: "x", headers: { Authorization: "Bearer literal" } } } }));
  const noPlaceholder = await runCli(["status", "--json"], { env: s.env, withFakeMcporter: true });
  assert.equal(noPlaceholder.code, 0);
  const report = JSON.parse(noPlaceholder.stdout);
  assert.equal(report.config.referencesTokenEnv, false);
  assert.ok(report.warnings.some((w) => /does not reference/.test(w)));
  assert.equal(noPlaceholder.stdout.includes("literal"), false, "header values are never printed");
});

test("call fails fast (exit 4) when mcporter is missing, before any refresh", async (t) => {
  const s = await setup(t);
  const server = await startTokenServer(t);
  const res = await runCli(["call", "search", "--args", "{}"], { env: s.env, emptyBinDir: s.emptyBinDir, tokenUrl: server.url });
  assert.equal(res.code, 4);
  assert.match(res.stderr, /mcporter executable not available/);
  assert.match(res.stderr, /npm install -g mcporter/);
  assert.equal(server.requests.length, 0);
  assert.equal((await readCache(s.cacheDir)).state, "missing");
});

test("call without a config path is a configuration error (exit 3)", async (t) => {
  const s = await setup(t);
  const server = await startTokenServer(t);
  const res = await runCli(["call", "search"], { env: { ...s.env, DROPBOX_MCPORTER_CONFIG: "" }, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(res.code, 3);
  assert.match(res.stderr, /No mcporter config path configured/);
  assert.equal(server.requests.length, 0);
});

test("call refreshes once, injects the token into the child only, and passes args through unchanged", async (t) => {
  const s = await setup(t);
  const server = await startTokenServer(t, { respond: () => ({ status: 200, body: { access_token: "sl.fresh-1", token_type: "Bearer", expires_in: 14400 } }) });
  const args = ["call", "search", "--args", '{"query":"invoice april"}', "--output", "json"];
  const first = await runCli(args, { env: { ...s.env, DROPBOX_REFRESH_TOKEN: "env-wins-refresh" }, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(first.code, 0, first.stderr);
  const report = fakeReport(first.stdout);
  assert.deepEqual(report.argv, ["--config", s.configPath, "call", "dropbox.search", "--args", '{"query":"invoice april"}', "--output", "json"]);
  assert.equal(report.token, "sl.fresh-1");
  assert.deepEqual(report.leaked, [], "refresh token, app secret, and other inputs must not reach the child");

  assert.equal(server.requests.length, 1);
  const req = server.requests[0];
  assert.equal(req.method, "POST");
  assert.match(req.headers["content-type"], /application\/x-www-form-urlencoded/);
  assert.deepEqual(req.form, { grant_type: "refresh_token", refresh_token: "env-wins-refresh", client_id: "app-key", client_secret: SECRETS[1] });
  assertNoSecrets(first.stderr + first.stdout.replace(/\{.*\}/, ""), ["env-wins-refresh"]);

  // Second call: cache hit, no refresh.
  const second = await runCli(args, { env: { ...s.env, DROPBOX_REFRESH_TOKEN: "env-wins-refresh" }, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(second.code, 0);
  assert.equal(fakeReport(second.stdout).token, "sl.fresh-1");
  assert.equal(server.requests.length, 1);

  if (POSIX) {
    assert.equal((await fs.stat(s.cacheDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(s.cacheDir, "token-cache.json"))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await fs.readdir(s.cacheDir), ["token-cache.json"], "lock and temp files are cleaned up");
});

test("list and schema map to mcporter list; a server-prefixed tool selector is kept", async (t) => {
  const s = await setup(t);
  const server = await startTokenServer(t);
  const list = await runCli(["list", "--json"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(fakeReport(list.stdout).argv, ["--config", s.configPath, "list", "dropbox", "--json"]);

  const schema = await runCli(["--server", "dbx", "schema"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(schema.code, 0, schema.stderr);
  assert.deepEqual(fakeReport(schema.stdout).argv, ["--config", s.configPath, "list", "dbx", "--schema"]);

  const schemaOk = await runCli(["schema"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  assert.deepEqual(fakeReport(schemaOk.stdout).argv, ["--config", s.configPath, "list", "dropbox", "--schema"]);

  const prefixed = await runCli(["call", "dropbox.list_folder", "path="], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  assert.deepEqual(fakeReport(prefixed.stdout).argv, ["--config", s.configPath, "call", "dropbox.list_folder", "path="]);
  assert.equal(server.requests.length, 1, "one refresh serves all of the above");
});

test("mcporter exit codes and signals are propagated", async (t) => {
  const s = await setup(t);
  const server = await startTokenServer(t);
  const failed = await runCli(["call", "search"], { env: { ...s.env, FAKE_MCPORTER_EXIT: "7" }, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(failed.code, 7);

  if (POSIX) {
    const killed = await runCli(["call", "search"], { env: { ...s.env, FAKE_MCPORTER_SIGNAL: "SIGTERM" }, withFakeMcporter: true, tokenUrl: server.url });
    assert.equal(killed.code, 128 + 15);
    assert.match(killed.stderr, /terminated by SIGTERM/);
  }
  assert.equal(server.requests.length, 1, "a failing mcporter call is never retried");
});

test("refresh failure exits 5 with the Dropbox error code, no secrets, and no cache write", async (t) => {
  const s = await setup(t);
  const server = await startTokenServer(t, {
    respond: () => ({ status: 400, body: { error: "invalid_grant", error_description: `refresh token revoked (${SECRETS[0]})` } }),
  });
  const res = await runCli(["call", "search"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(res.code, 5);
  assert.match(res.stderr, /HTTP 400, invalid_grant/);
  assert.match(res.stderr, /hint: .*Re-authorize/);
  assert.equal(res.stdout, "", "mcporter must not run without a token");
  assert.equal((await readCache(s.cacheDir)).state, "missing");
  assert.equal(server.requests.length, 1, "no automatic retry");
  // The description echoed our refresh token; the wrapper truncates but still passes descriptions
  // through, so this checks the request body and hint rather than the description text.
  assert.equal(res.stderr.includes("client_secret"), false);
  assert.equal(res.stderr.includes(SECRETS[1]), false);
});

test("explicit refresh command forces a new token and prints only the expiry", async (t) => {
  const s = await setup(t);
  let n = 0;
  const server = await startTokenServer(t, { respond: () => ({ status: 200, body: { access_token: `sl.forced-${++n}`, expires_in: 3600 } }) });
  await runCli(["call", "search"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  const res = await runCli(["refresh", "--json"], { env: s.env, tokenUrl: server.url, emptyBinDir: s.emptyBinDir });
  assert.equal(res.code, 0, res.stderr);
  const summary = JSON.parse(res.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.source, "refresh");
  assert.match(summary.expiresAt, /^\d{4}-/);
  assert.equal(res.stdout.includes("sl.forced"), false);
  assert.equal(server.requests.length, 2);
  assert.equal((await readCache(s.cacheDir)).entry.accessToken, "sl.forced-2");

  const text = await runCli(["refresh"], { env: s.env, tokenUrl: server.url });
  assert.match(text.stdout, /^Token refreshed; expires /);
  assert.equal(text.stdout.includes("sl.forced"), false);
});

test("expired, mismatched, and corrupt caches all trigger a refresh and are replaced", async (t) => {
  const s = await setup(t);
  let n = 0;
  const server = await startTokenServer(t, { respond: () => ({ status: 200, body: { access_token: `sl.n${++n}`, expires_in: 3600 } }) });
  const creds = await resolveCredentials({ env: {}, envFilePath: s.envFile });

  await writeCache(s.cacheDir, { accessToken: "sl.expired", expiresAt: Date.now() - 1, obtainedAt: 0, source: "refresh", credentialFingerprint: creds.credentialFingerprint });
  let res = await runCli(["call", "search"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(fakeReport(res.stdout).token, "sl.n1");

  await writeCache(s.cacheDir, { accessToken: "sl.other-account", expiresAt: Date.now() + 3_600_000, obtainedAt: 0, source: "refresh", credentialFingerprint: "f".repeat(64) });
  res = await runCli(["call", "search"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(fakeReport(res.stdout).token, "sl.n2", "a token from other credentials must never be reused");

  await fs.writeFile(path.join(s.cacheDir, "token-cache.json"), "{{corrupt");
  res = await runCli(["call", "search"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(fakeReport(res.stdout).token, "sl.n3");
  assert.equal((await readCache(s.cacheDir)).entry.accessToken, "sl.n3");
  assert.equal(server.requests.length, 3);
});

test("changing the refresh token in the env file invalidates the cache", async (t) => {
  const s = await setup(t);
  let n = 0;
  const server = await startTokenServer(t, { respond: () => ({ status: 200, body: { access_token: `sl.acct${++n}`, expires_in: 3600 } }) });
  await runCli(["call", "search"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  await writeFile(s.envFile, "DROPBOX_APP_KEY=app-key\nDROPBOX_REFRESH_TOKEN=second-account\n");
  const res = await runCli(["call", "search"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(fakeReport(res.stdout).token, "sl.acct2");
  assert.equal(server.requests[1].form.refresh_token, "second-account");
});

test("static tokens: valid expiry is used without refresh; legacy DROPBOX_MCP_TOKEN alone is used as is", async (t) => {
  const s = await setup(t, { envFileContent: "DROPBOX_ACCESS_TOKEN=sl.static\nDROPBOX_ACCESS_TOKEN_EXPIRES_AT=2035-01-01T00:00:00Z\n" });
  const server = await startTokenServer(t);
  const res = await runCli(["call", "search"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(fakeReport(res.stdout).token, "sl.static");
  assert.equal(server.requests.length, 0);

  const legacy = await setup(t, { envFileContent: "DROPBOX_MCP_TOKEN=sl.legacy-only\n" });
  const legacyRes = await runCli(["call", "search"], { env: legacy.env, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(legacyRes.code, 0, legacyRes.stderr);
  const report = fakeReport(legacyRes.stdout);
  assert.equal(report.token, "sl.legacy-only");
  assert.deepEqual(report.leaked, []);
  assert.equal(server.requests.length, 0);

  const status = await runCli(["status", "--json"], { env: legacy.env, withFakeMcporter: true });
  assert.ok(JSON.parse(status.stdout).warnings.some((w) => /cannot be refreshed/.test(w)));
});

test("no credentials at all: clear error (exit 3) before any network or child process", async (t) => {
  const s = await setup(t, { envFileContent: "# nothing here\n" });
  const server = await startTokenServer(t);
  const res = await runCli(["call", "search"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(res.code, 3);
  assert.match(res.stderr, /No Dropbox credentials found/);
  assert.equal(res.stdout, "");
  assert.equal(server.requests.length, 0);
});

test("concurrent wrapper processes share exactly one refresh", async (t) => {
  const s = await setup(t);
  const server = await startTokenServer(t, { delayMs: 300, respond: (_req, n) => ({ status: 200, body: { access_token: `sl.concurrent-${n}`, expires_in: 3600 } }) });
  const runs = await Promise.all(
    Array.from({ length: 6 }, () => runCli(["call", "get_usage_and_quota"], { env: s.env, withFakeMcporter: true, tokenUrl: server.url })),
  );
  for (const run of runs) assert.equal(run.code, 0, run.stderr);
  const tokens = new Set(runs.map((run) => fakeReport(run.stdout).token));
  assert.deepEqual([...tokens], ["sl.concurrent-1"]);
  assert.equal(server.requests.length, 1);
  assert.deepEqual(await fs.readdir(s.cacheDir), ["token-cache.json"]);
});

test("a held lock is respected up to the bounded timeout (exit 6)", async (t) => {
  const s = await setup(t);
  const server = await startTokenServer(t);
  const lockDir = path.join(s.cacheDir, "token-cache.lock");
  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
  const os = await import("node:os");
  await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, hostname: os.hostname(), id: "test-holder" }));
  const started = Date.now();
  const res = await runCli(["call", "search"], { env: { ...s.env, DROPBOX_LOCK_TIMEOUT_MS: "400" }, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(res.code, 6);
  assert.match(res.stderr, /Timed out after 400 ms/);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(server.requests.length, 0);
});

test("a stale lock left by a dead process fails closed", async (t) => {
  const s = await setup(t);
  const server = await startTokenServer(t);
  const lockDir = path.join(s.cacheDir, "token-cache.lock");
  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
  const os = await import("node:os");
  await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: 2 ** 22 - 11, hostname: os.hostname(), id: "dead" }));
  const then = new Date(Date.now() - 60_000);
  await fs.utimes(lockDir, then, then);
  const res = await runCli(["call", "search"], { env: { ...s.env, DROPBOX_LOCK_TIMEOUT_MS: "100" }, withFakeMcporter: true, tokenUrl: server.url });
  assert.equal(res.code, 6, res.stderr);
  assert.equal(server.requests.length, 0);
});

test("--mcporter accepts an explicit path and reports a bad one", async (t) => {
  const s = await setup(t);
  const server = await startTokenServer(t);
  const { FAKE_MCPORTER_DIR } = await import("./helpers/paths.mjs");
  const ok = await runCli(["--mcporter", path.join(FAKE_MCPORTER_DIR, "mcporter"), "list"], { env: s.env, emptyBinDir: s.emptyBinDir, tokenUrl: server.url });
  assert.equal(ok.code, 0, ok.stderr);
  const bad = await runCli(["--mcporter", path.join(s.root, "nope", "mcporter"), "list"], { env: s.env, emptyBinDir: s.emptyBinDir, tokenUrl: server.url });
  assert.equal(bad.code, 4);
  assert.match(bad.stderr, /not an executable file/);
});
