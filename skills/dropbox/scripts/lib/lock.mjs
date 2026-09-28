import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_LOCK_TIMEOUT_MS, EXIT, LOCK_STALE_MS } from "./constants.mjs";
import { WrapperError } from "./errors.mjs";

const OWNER_FILE = "owner.json";
// A lock directory without an owner file older than this was abandoned between
// mkdir and writing the owner file.
const OWNERLESS_GRACE_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err?.code === "EPERM";
  }
}

async function readOwner(lockDir) {
  try {
    const text = await fs.readFile(path.join(lockDir, OWNER_FILE), "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function lockAgeMs(lockDir, now) {
  try {
    const stat = await fs.stat(lockDir);
    return now - stat.mtimeMs;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Break a lock only when the evidence says its owner is gone. Recovery is
 * race-safe: the directory is renamed to a unique name first, so only one
 * contender wins the rename and the others simply retry acquisition.
 */
async function breakIfStale(lockDir, { staleMs, hostname, now }) {
  const age = await lockAgeMs(lockDir, now);
  if (age === null) return false;
  const owner = await readOwner(lockDir);
  let stale = false;
  if (age > staleMs) {
    stale = true;
  } else if (!owner) {
    stale = age > OWNERLESS_GRACE_MS;
  } else if (owner.hostname === hostname) {
    stale = !pidAlive(owner.pid);
  }
  if (!stale) return false;
  const graveyard = `${lockDir}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await fs.rename(lockDir, graveyard);
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
  await fs.rm(graveyard, { recursive: true, force: true }).catch(() => {});
  return true;
}

/**
 * Run `fn` while holding a cross-process lock implemented with an atomic
 * mkdir. Waits are bounded by `timeoutMs`; stale locks (dead owner pid on this
 * host, or older than `staleMs`) are recovered safely.
 */
export async function withLock(lockDir, fn, options = {}) {
  const {
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleMs = LOCK_STALE_MS,
    pollMs = 50,
    now = () => Date.now(),
  } = options;
  const hostname = os.hostname();
  const id = randomBytes(8).toString("hex");
  const deadline = now() + timeoutMs;

  for (;;) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      await fs.writeFile(
        path.join(lockDir, OWNER_FILE),
        JSON.stringify({ pid: process.pid, hostname, id, createdAt: new Date(now()).toISOString() }),
        { mode: 0o600 },
      );
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") {
        throw new WrapperError(`Cannot create token cache lock ${lockDir}: ${err?.code ?? err?.message}`, {
          exitCode: EXIT.CONFIG,
        });
      }
    }
    const broke = await breakIfStale(lockDir, { staleMs, hostname, now: now() });
    if (broke) continue;
    if (now() >= deadline) {
      throw new WrapperError(
        `Timed out after ${timeoutMs} ms waiting for the token cache lock at ${lockDir}.`,
        {
          exitCode: EXIT.LOCK_TIMEOUT,
          hint: "Another wrapper process may be refreshing the token. Retry, or remove the lock directory if no wrapper is running.",
        },
      );
    }
    await sleep(pollMs + Math.floor(Math.random() * pollMs));
  }

  try {
    return await fn();
  } finally {
    // Only remove the lock if it is still ours; a very slow run could have had
    // its lock recovered as stale and re-taken by another process.
    const owner = await readOwner(lockDir);
    if (owner && owner.id === id) {
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
