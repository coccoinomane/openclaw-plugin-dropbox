import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_LOCK_TIMEOUT_MS, EXIT } from "./constants.mjs";
import { WrapperError } from "./errors.mjs";

const OWNER_FILE = "owner.json";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readOwner(lockDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(lockDir, OWNER_FILE), "utf8"));
  } catch {
    return null;
  }
}

// Never reclaim an existing lock automatically. Checking an owner and then
// renaming its directory can steal a newly acquired lock from another process.
// Abandoned locks fail closed and require operator cleanup with wrappers stopped.
export async function withLock(lockDir, fn, options = {}) {
  const { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, pollMs = 50, now = () => Date.now() } = options;
  const id = randomBytes(16).toString("hex");
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    let acquired = false;
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      acquired = true;
      await fs.writeFile(path.join(lockDir, OWNER_FILE), JSON.stringify({
        pid: process.pid, hostname: os.hostname(), id, createdAt: new Date(now()).toISOString(),
      }), { mode: 0o600, flag: "wx" });
      break;
    } catch (err) {
      if (acquired) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw new WrapperError("Cannot write token lock metadata.", { exitCode: EXIT.CONFIG });
      }
      if (err?.code !== "EEXIST") {
        throw new WrapperError(`Cannot create token cache lock (${err?.code ?? "filesystem error"}).`, { exitCode: EXIT.CONFIG });
      }
    }
    if (performance.now() >= deadline) {
      throw new WrapperError(`Timed out after ${timeoutMs} ms waiting for the token cache lock at ${lockDir}.`, {
        exitCode: EXIT.LOCK_TIMEOUT,
        hint: "Retry after the active refresh finishes. If the lock was abandoned, stop all wrapper processes and remove only this lock directory before retrying. Existing locks are never stolen automatically.",
      });
    }
    await sleep(Math.min(pollMs + Math.floor(Math.random() * pollMs), Math.max(1, deadline - performance.now())));
  }
  try {
    return await fn();
  } finally {
    const owner = await readOwner(lockDir);
    if (owner?.id === id) await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}
