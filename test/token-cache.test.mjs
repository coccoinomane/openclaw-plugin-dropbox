import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { CACHE_FILE_NAME, REFRESH_SKEW_MS } from "../skills/dropbox/scripts/lib/constants.mjs";
import { cacheFilePath, describeCache, ensureCacheDir, evaluateEntry, readCache, writeCache } from "../skills/dropbox/scripts/lib/token-cache.mjs";
import { makeTmpDir } from "./helpers/tmp.mjs";

const POSIX = process.platform !== "win32";
const FP = "a".repeat(64);

function entry(overrides = {}) {
  return { accessToken: "sl.cached", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now(), source: "refresh", credentialFingerprint: FP, ...overrides };
}

test("write then read round-trips, with 0600 file and 0700 directory", async (t) => {
  const root = await makeTmpDir(t);
  const cacheDir = path.join(root, "nested", "cache");
  const file = await writeCache(cacheDir, entry());
  assert.equal(file, cacheFilePath(cacheDir));
  const read = await readCache(cacheDir);
  assert.equal(read.state, "present");
  assert.equal(read.entry.accessToken, "sl.cached");
  assert.equal(read.entry.version, 1);
  if (POSIX) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(cacheDir)).mode & 0o777, 0o700);
  }
  const leftovers = (await fs.readdir(cacheDir)).filter((name) => name !== CACHE_FILE_NAME);
  assert.deepEqual(leftovers, [], "atomic write must leave no temp files");
});

test("ensureCacheDir tightens an existing directory with loose permissions", { skip: !POSIX }, async (t) => {
  const root = await makeTmpDir(t);
  const cacheDir = path.join(root, "loose");
  await fs.mkdir(cacheDir, { mode: 0o755 });
  await ensureCacheDir(cacheDir);
  assert.equal((await fs.stat(cacheDir)).mode & 0o777, 0o700);
});

test("corrupt or malformed cache files are reported, not thrown", async (t) => {
  const cacheDir = await makeTmpDir(t);
  assert.equal((await readCache(cacheDir)).state, "missing");

  await fs.writeFile(cacheFilePath(cacheDir), "{not json", { mode: 0o600 });
  const corrupt = await readCache(cacheDir);
  assert.equal(corrupt.state, "corrupt");
  assert.equal(corrupt.reason, "invalid JSON");

  await fs.writeFile(cacheFilePath(cacheDir), JSON.stringify({ version: 1, accessToken: "" }));
  assert.equal((await readCache(cacheDir)).reason, "unexpected shape");

  await fs.writeFile(cacheFilePath(cacheDir), JSON.stringify({ ...entry(), version: 99 }));
  assert.equal((await readCache(cacheDir)).state, "corrupt", "unknown cache versions are ignored");

  // A later write replaces the corrupt file.
  await writeCache(cacheDir, entry());
  assert.equal((await readCache(cacheDir)).state, "present");
});

test("evaluateEntry classifies fresh, expiring, expired, mismatch", () => {
  const now = 1_000_000_000_000;
  const opts = { credentialFingerprint: FP, now };
  assert.equal(evaluateEntry(null, opts), "missing");
  assert.equal(evaluateEntry(entry({ expiresAt: now + REFRESH_SKEW_MS + 1 }), opts), "fresh");
  assert.equal(evaluateEntry(entry({ expiresAt: now + REFRESH_SKEW_MS }), opts), "expiring");
  assert.equal(evaluateEntry(entry({ expiresAt: now + 1000 }), opts), "expiring");
  assert.equal(evaluateEntry(entry({ expiresAt: now }), opts), "expired");
  assert.equal(evaluateEntry(entry({ expiresAt: now - 1 }), opts), "expired");
  assert.equal(evaluateEntry(entry({ credentialFingerprint: "b".repeat(64) }), opts), "mismatch");
});

test("describeCache never includes the token", async (t) => {
  const cacheDir = await makeTmpDir(t);
  await writeCache(cacheDir, entry({ accessToken: "sl.super-secret" }));
  const described = describeCache(await readCache(cacheDir), { credentialFingerprint: FP });
  assert.equal(described.evaluation, "fresh");
  assert.equal(JSON.stringify(described).includes("sl.super-secret"), false);
  if (POSIX) assert.equal(described.permissionsOk, true);
});

test("fresh cache reads reject unsafe modes and symlinks", { skip: !POSIX }, async (t) => {
  const root = await makeTmpDir(t);
  const dir = path.join(root, "cache");
  await writeCache(dir, entry());
  await fs.chmod(cacheFilePath(dir), 0o644);
  await assert.rejects(readCache(dir), /Unsafe token cache file/);
  await fs.chmod(cacheFilePath(dir), 0o600);
  await fs.chmod(dir, 0o755);
  await assert.rejects(readCache(dir), /Unsafe token cache directory/);
  await fs.chmod(dir, 0o700);
  const linkedDir = path.join(root, "linked");
  await fs.symlink(dir, linkedDir);
  await assert.rejects(readCache(linkedDir), /Unsafe token cache directory/);
  await assert.rejects(ensureCacheDir(linkedDir), /must not be a symlink/);
  const target = path.join(root, "target");
  await fs.rename(cacheFilePath(dir), target);
  await fs.symlink(target, cacheFilePath(dir));
  await assert.rejects(readCache(dir), /Unsafe token cache file/);
});
