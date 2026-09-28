import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CACHE_FILE_NAME, CACHE_VERSION, REFRESH_SKEW_MS } from "./constants.mjs";
import { configError } from "./errors.mjs";

const POSIX = process.platform !== "win32";

export function cacheFilePath(cacheDir) {
  return path.join(cacheDir, CACHE_FILE_NAME);
}

/**
 * Create the cache directory with mode 0700. The directory is plugin-owned, so
 * if it already exists with looser permissions it is tightened.
 */
export async function ensureCacheDir(cacheDir) {
  try {
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw configError(`Cannot create token cache directory ${cacheDir}: ${err?.code ?? err?.message}`);
  }
  if (!POSIX) return;
  const stat = await fs.lstat(cacheDir);
  if (stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw configError("Token cache directory must be owned by the current user and must not be a symlink.");
  if (!stat.isDirectory()) throw configError(`Token cache path is not a directory: ${cacheDir}`);
  if ((stat.mode & 0o077) !== 0) {
    await fs.chmod(cacheDir, 0o700);
  }
}

function isValidEntry(value) {
  return (
    value &&
    typeof value === "object" &&
    value.version === CACHE_VERSION &&
    typeof value.accessToken === "string" &&
    value.accessToken.length > 0 &&
    Number.isFinite(value.expiresAt) &&
    Number.isFinite(new Date(value.expiresAt).getTime()) &&
    typeof value.credentialFingerprint === "string" &&
    value.credentialFingerprint.length > 0
  );
}

/**
 * Read the cache without throwing. Returns `{ state, entry, path, mode }` where
 * state is one of: missing, corrupt, present.
 */
export async function readCache(cacheDir) {
  const file = cacheFilePath(cacheDir);
  let text;
  let mode = null;
  try {
    const directory = await fs.lstat(cacheDir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (POSIX && ((directory.mode & 0o077) !== 0 || directory.uid !== process.getuid()))) {
      throw configError("Unsafe token cache directory: use a private directory owned by the current user, mode 0700, without symlinks.");
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (POSIX && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
      throw configError("Unsafe token cache file: use a regular file owned by the current user, mode 0600, without symlinks.");
    }
    mode = POSIX ? stat.mode & 0o777 : null;
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err?.exitCode) throw err;
    if (err?.code === "ENOENT") return { state: "missing", entry: null, path: file, mode };
    return { state: "corrupt", entry: null, path: file, mode, reason: err?.code ?? "unreadable" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "corrupt", entry: null, path: file, mode, reason: "invalid JSON" };
  }
  if (!isValidEntry(parsed)) {
    return { state: "corrupt", entry: null, path: file, mode, reason: "unexpected shape" };
  }
  return { state: "present", entry: parsed, path: file, mode };
}

/**
 * Classify a cache entry against the current credentials and clock:
 * fresh (usable), expiring (inside the refresh window), expired, or mismatch
 * (produced by different credentials, so it must not be used).
 */
export function evaluateEntry(entry, { credentialFingerprint, now = Date.now(), skewMs = REFRESH_SKEW_MS }) {
  if (!entry) return "missing";
  if (entry.credentialFingerprint !== credentialFingerprint) return "mismatch";
  const remaining = entry.expiresAt - now;
  if (remaining <= 0) return "expired";
  if (remaining <= skewMs) return "expiring";
  return "fresh";
}

/**
 * Atomically write the cache file with mode 0600: write to a temp file in the
 * same directory, fsync, then rename over the destination.
 */
export async function writeCache(cacheDir, entry) {
  await ensureCacheDir(cacheDir);
  const file = cacheFilePath(cacheDir);
  const tmp = path.join(cacheDir, `.${CACHE_FILE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const payload = JSON.stringify({ ...entry, version: CACHE_VERSION }, null, 2) + "\n";
  let handle;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (POSIX) await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw configError(`Cannot write token cache ${file}: ${err?.code ?? err?.message}`);
  }
  return file;
}

/** Secret-free description of the cache for status output. */
export function describeCache(read, { credentialFingerprint, now = Date.now() }) {
  const base = { path: read.path, state: read.state, mode: read.mode === null ? null : read.mode.toString(8) };
  if (read.state !== "present") return { ...base, reason: read.reason ?? null };
  const evaluation = evaluateEntry(read.entry, { credentialFingerprint, now });
  return {
    ...base,
    evaluation,
    expiresAt: new Date(read.entry.expiresAt).toISOString(),
    expiresInSeconds: Math.max(0, Math.round((read.entry.expiresAt - now) / 1000)),
    obtainedAt: read.entry.obtainedAt ? new Date(read.entry.obtainedAt).toISOString() : null,
    source: read.entry.source ?? null,
    permissionsOk: read.mode === null ? null : (read.mode & 0o077) === 0,
  };
}
