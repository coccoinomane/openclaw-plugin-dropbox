import assert from "node:assert/strict";
import { test } from "node:test";

import { REFRESH_SKEW_MS } from "../skills/dropbox/scripts/lib/constants.mjs";
import { resolveCredentials } from "../skills/dropbox/scripts/lib/credentials.mjs";
import { readCache, writeCache } from "../skills/dropbox/scripts/lib/token-cache.mjs";
import { resolveAccessToken } from "../skills/dropbox/scripts/lib/token.mjs";
import { makeTmpDir } from "./helpers/tmp.mjs";

const REFRESH_ENV = { DROPBOX_APP_KEY: "app", DROPBOX_REFRESH_TOKEN: "refresh-1" };

function fakeFetch(tokens = ["sl.one", "sl.two", "sl.three"]) {
  const state = { calls: 0 };
  state.fetch = async () => {
    const token = tokens[state.calls] ?? `sl.${state.calls}`;
    state.calls += 1;
    return new Response(JSON.stringify({ access_token: token, token_type: "bearer", expires_in: 3600 }), { status: 200 });
  };
  return state;
}

async function creds(env) {
  return resolveCredentials({ env, envFilePath: undefined });
}

test("no credentials at all is a configuration error", async (t) => {
  const cacheDir = await makeTmpDir(t);
  await assert.rejects(resolveAccessToken({ credentials: await creds({}), cacheDir }), (err) => err.exitCode === 3 && /No Dropbox credentials/.test(err.message));
});

test("first call refreshes and caches; later calls reuse the cache without fetching", async (t) => {
  const cacheDir = await makeTmpDir(t);
  const f = fakeFetch();
  const credentials = await creds(REFRESH_ENV);
  const first = await resolveAccessToken({ credentials, cacheDir, fetch: f.fetch });
  assert.deepEqual({ token: first.token, source: first.source, refreshed: first.refreshed }, { token: "sl.one", source: "refresh", refreshed: true });
  const second = await resolveAccessToken({ credentials, cacheDir, fetch: f.fetch });
  assert.deepEqual({ token: second.token, source: second.source }, { token: "sl.one", source: "cache" });
  assert.equal(f.calls, 1);
  assert.equal((await readCache(cacheDir)).entry.source, "refresh");
});

test("a token expiring within 5 minutes is refreshed; force always refreshes", async (t) => {
  const cacheDir = await makeTmpDir(t);
  const f = fakeFetch();
  const credentials = await creds(REFRESH_ENV);
  let clock = 1_800_000_000_000;
  const now = () => clock;
  await resolveAccessToken({ credentials, cacheDir, fetch: f.fetch, now }); // sl.one, expires in 3600s
  clock += 3600_000 - REFRESH_SKEW_MS + 1; // inside the refresh window
  const refreshed = await resolveAccessToken({ credentials, cacheDir, fetch: f.fetch, now });
  assert.equal(refreshed.token, "sl.two");
  assert.equal(f.calls, 2);
  const forced = await resolveAccessToken({ credentials, cacheDir, fetch: f.fetch, now, force: true });
  assert.equal(forced.token, "sl.three");
  assert.equal(f.calls, 3);
});

test("cache produced by other credentials (account change) is not reused", async (t) => {
  const cacheDir = await makeTmpDir(t);
  const f = fakeFetch();
  await resolveAccessToken({ credentials: await creds(REFRESH_ENV), cacheDir, fetch: f.fetch });
  const switched = await resolveAccessToken({ credentials: await creds({ ...REFRESH_ENV, DROPBOX_REFRESH_TOKEN: "refresh-2" }), cacheDir, fetch: f.fetch });
  assert.equal(switched.token, "sl.two");
  assert.equal(f.calls, 2);
  // Switching back also refreshes: the cache now belongs to refresh-2.
  const back = await resolveAccessToken({ credentials: await creds(REFRESH_ENV), cacheDir, fetch: f.fetch });
  assert.equal(back.token, "sl.three");
});

test("a corrupt cache is ignored and rewritten", async (t) => {
  const cacheDir = await makeTmpDir(t);
  const f = fakeFetch();
  const { writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  await writeFile(path.join(cacheDir, "token-cache.json"), "garbage", { mode: 0o600 });
  const result = await resolveAccessToken({ credentials: await creds(REFRESH_ENV), cacheDir, fetch: f.fetch });
  assert.equal(result.token, "sl.one");
  assert.equal((await readCache(cacheDir)).state, "present");
});

test("refresh failures surface as exit code 5 and leave the old cache untouched", async (t) => {
  const cacheDir = await makeTmpDir(t);
  const credentials = await creds(REFRESH_ENV);
  await writeCache(cacheDir, { accessToken: "sl.old", expiresAt: Date.now() - 1, obtainedAt: 0, source: "refresh", credentialFingerprint: credentials.credentialFingerprint });
  const failing = async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  await assert.rejects(resolveAccessToken({ credentials, cacheDir, fetch: failing }), (err) => err.exitCode === 5);
  assert.equal((await readCache(cacheDir)).entry.accessToken, "sl.old");
});

test("static token with a known future expiry is used without refreshing", async (t) => {
  const cacheDir = await makeTmpDir(t);
  const f = fakeFetch();
  const credentials = await creds({ ...REFRESH_ENV, DROPBOX_ACCESS_TOKEN: "sl.static", DROPBOX_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 3_600_000) });
  const result = await resolveAccessToken({ credentials, cacheDir, fetch: f.fetch });
  assert.deepEqual({ token: result.token, source: result.source }, { token: "sl.static", source: "static" });
  assert.equal(f.calls, 0);
});

test("static token near expiry falls back to refresh when possible, otherwise errors", async (t) => {
  const cacheDir = await makeTmpDir(t);
  const f = fakeFetch();
  const soon = String(Date.now() + 60_000);
  const withRefresh = await creds({ ...REFRESH_ENV, DROPBOX_ACCESS_TOKEN: "sl.static", DROPBOX_ACCESS_TOKEN_EXPIRES_AT: soon });
  assert.equal((await resolveAccessToken({ credentials: withRefresh, cacheDir, fetch: f.fetch })).token, "sl.one");
  const withoutRefresh = await creds({ DROPBOX_ACCESS_TOKEN: "sl.static", DROPBOX_ACCESS_TOKEN_EXPIRES_AT: soon });
  await assert.rejects(resolveAccessToken({ credentials: withoutRefresh, cacheDir: await makeTmpDir(t), fetch: f.fetch }), (err) => err.exitCode === 3 && /expired/.test(err.message));
});

test("static token without expiry: refresh conservatively when possible, else use as is", async (t) => {
  const f = fakeFetch();
  const conservative = await creds({ ...REFRESH_ENV, DROPBOX_MCP_TOKEN: "sl.unknown-expiry" });
  assert.equal((await resolveAccessToken({ credentials: conservative, cacheDir: await makeTmpDir(t), fetch: f.fetch })).token, "sl.one");
  const only = await creds({ DROPBOX_MCP_TOKEN: "sl.unknown-expiry" });
  const result = await resolveAccessToken({ credentials: only, cacheDir: await makeTmpDir(t), fetch: f.fetch });
  assert.deepEqual({ token: result.token, source: result.source, expiresAt: result.expiresAt }, { token: "sl.unknown-expiry", source: "static", expiresAt: null });
  await assert.rejects(resolveAccessToken({ credentials: only, cacheDir: await makeTmpDir(t), fetch: f.fetch, force: true }), (err) => err.exitCode === 3);
  assert.equal(f.calls, 1);
});

test("concurrent in-process resolvers share a single refresh", async (t) => {
  const cacheDir = await makeTmpDir(t);
  const f = fakeFetch();
  const credentials = await creds(REFRESH_ENV);
  const results = await Promise.all(Array.from({ length: 5 }, () => resolveAccessToken({ credentials, cacheDir, fetch: f.fetch })));
  assert.equal(f.calls, 1);
  assert.ok(results.every((r) => r.token === "sl.one"));
});
