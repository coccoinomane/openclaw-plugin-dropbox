import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { withLock } from "../skills/dropbox/scripts/lib/lock.mjs";
import { makeTmpDir, sleep } from "./helpers/tmp.mjs";

async function plantLock(lockDir, owner, { ageMs = 0 } = {}) {
  await fs.mkdir(lockDir);
  if (owner) await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify(owner));
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    await fs.utimes(lockDir, then, then);
  }
}

test("acquires, runs, and releases", async (t) => {
  const lockDir = path.join(await makeTmpDir(t), "x.lock");
  const result = await withLock(lockDir, async () => {
    assert.ok((await fs.stat(lockDir)).isDirectory());
    return 42;
  });
  assert.equal(result, 42);
  await assert.rejects(fs.stat(lockDir), { code: "ENOENT" });
});

test("releases on error and propagates it", async (t) => {
  const lockDir = path.join(await makeTmpDir(t), "x.lock");
  await assert.rejects(withLock(lockDir, async () => { throw new Error("boom"); }), /boom/);
  await assert.rejects(fs.stat(lockDir), { code: "ENOENT" });
});

test("concurrent holders are serialized", async (t) => {
  const lockDir = path.join(await makeTmpDir(t), "x.lock");
  let active = 0;
  let maxActive = 0;
  const order = [];
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      withLock(lockDir, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        order.push(i);
        active -= 1;
      }, { pollMs: 5 }),
    ),
  );
  assert.equal(maxActive, 1);
  assert.equal(order.length, 6);
});

test("waits are bounded: a live lock times out with exit code 6", async (t) => {
  const lockDir = path.join(await makeTmpDir(t), "x.lock");
  await plantLock(lockDir, { pid: process.pid, hostname: os.hostname(), id: "someone-else" });
  const started = Date.now();
  await assert.rejects(withLock(lockDir, async () => "never", { timeoutMs: 300, pollMs: 20 }), (err) => err.exitCode === 6);
  assert.ok(Date.now() - started >= 280);
  assert.ok((await fs.stat(lockDir)).isDirectory(), "a live lock must not be removed");
});

for (const [label, owner] of [
  ["dead owner", { pid: 2 ** 22 - 7, hostname: os.hostname(), id: "dead" }],
  ["missing owner", null],
  ["live owner", { pid: process.pid, hostname: os.hostname(), id: "live" }],
]) {
  test(`old lock with ${label} is never stolen`, async (t) => {
    const lockDir = path.join(await makeTmpDir(t), "x.lock");
    await plantLock(lockDir, owner, { ageMs: 300_000 });
    await assert.rejects(withLock(lockDir, async () => assert.fail("must not enter"), { timeoutMs: 80, pollMs: 10 }), (err) => err.exitCode === 6);
    assert.ok((await fs.stat(lockDir)).isDirectory());
  });
}

test("a lock from another host with a fresh mtime is respected", async (t) => {
  const lockDir = path.join(await makeTmpDir(t), "x.lock");
  await plantLock(lockDir, { pid: 1, hostname: "some-other-host", id: "remote" });
  await assert.rejects(withLock(lockDir, async () => "never", { timeoutMs: 200, pollMs: 20 }), (err) => err.exitCode === 6);
});

test("release does not remove a lock that was re-taken by someone else", async (t) => {
  const lockDir = path.join(await makeTmpDir(t), "x.lock");
  await withLock(lockDir, async () => {
    // Simulate stale recovery by another process while we are still running.
    await fs.rm(lockDir, { recursive: true, force: true });
    await plantLock(lockDir, { pid: process.pid, hostname: os.hostname(), id: "other" });
  });
  assert.ok((await fs.stat(lockDir)).isDirectory(), "the other process's lock must survive our release");
});
