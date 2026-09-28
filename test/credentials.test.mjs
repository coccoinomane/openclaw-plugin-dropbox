import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { describeCredentials, parseExpiresAt, resolveCredentials } from "../skills/dropbox/scripts/lib/credentials.mjs";
import { makeTmpDir, writeFile } from "./helpers/tmp.mjs";

test("parseExpiresAt accepts seconds, milliseconds, ISO, and rejects garbage", () => {
  assert.equal(parseExpiresAt("1700000000"), 1700000000000);
  assert.equal(parseExpiresAt("1700000000000"), 1700000000000);
  assert.equal(parseExpiresAt("2026-01-01T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(parseExpiresAt(""), null);
  assert.equal(parseExpiresAt(undefined), null);
  assert.throws(() => parseExpiresAt("tomorrow-ish"), (err) => err.exitCode === 3);
});

test("process env wins over env file; only allowed keys are read; fingerprint follows credentials", async (t) => {
  const dir = await makeTmpDir(t);
  const envFile = await writeFile(
    path.join(dir, "dropbox.env"),
    "DROPBOX_APP_KEY=file-key\nDROPBOX_REFRESH_TOKEN=file-refresh\nDROPBOX_APP_SECRET=file-secret\nUNRELATED=1\n",
  );
  const creds = await resolveCredentials({ env: { DROPBOX_APP_KEY: "env-key" }, envFilePath: envFile });
  assert.equal(creds.appKey, "env-key");
  assert.equal(creds.refreshToken, "file-refresh");
  assert.equal(creds.appSecret, "file-secret");
  assert.equal(creds.canRefresh, true);
  assert.equal(creds.sources.DROPBOX_APP_KEY, "env");
  assert.equal(creds.sources.DROPBOX_REFRESH_TOKEN, "file");
  assert.equal(creds.staticToken, undefined);
  assert.match(creds.credentialFingerprint, /^[0-9a-f]{64}$/);

  const other = await resolveCredentials({ env: { DROPBOX_APP_KEY: "env-key", DROPBOX_REFRESH_TOKEN: "another-account" }, envFilePath: envFile });
  assert.notEqual(other.credentialFingerprint, creds.credentialFingerprint, "a different refresh token must change the fingerprint");

  const described = describeCredentials(creds);
  const serialized = JSON.stringify(described);
  for (const secret of ["env-key", "file-refresh", "file-secret"]) {
    assert.equal(serialized.includes(secret), false, `description must not contain ${secret}`);
  }
});

test("static token selection and validation", async () => {
  const withAccess = await resolveCredentials({
    env: { DROPBOX_ACCESS_TOKEN: "sl.static", DROPBOX_MCP_TOKEN: "sl.legacy", DROPBOX_ACCESS_TOKEN_EXPIRES_AT: "2030-01-01T00:00:00Z" },
    envFilePath: undefined,
  });
  assert.equal(withAccess.staticToken, "sl.static");
  assert.equal(withAccess.staticTokenSource, "DROPBOX_ACCESS_TOKEN");
  assert.equal(withAccess.staticTokenExpiresAt, Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(withAccess.canRefresh, false);

  const legacy = await resolveCredentials({ env: { DROPBOX_MCP_TOKEN: "  sl.legacy  " }, envFilePath: undefined });
  assert.equal(legacy.staticToken, "sl.legacy");
  assert.equal(legacy.staticTokenSource, "DROPBOX_MCP_TOKEN");
  assert.equal(legacy.staticTokenExpiresAt, null);

  const empty = await resolveCredentials({ env: { DROPBOX_APP_KEY: "   " }, envFilePath: undefined });
  assert.equal(empty.appKey, undefined);
  assert.equal(empty.credentialFingerprint, null);

  await assert.rejects(
    resolveCredentials({ env: { DROPBOX_REFRESH_TOKEN: "r" }, envFilePath: undefined }),
    (err) => err.exitCode === 3 && /DROPBOX_APP_KEY is missing/.test(err.message),
  );
});
