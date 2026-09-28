import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Create a private temp directory and register cleanup on the test context. */
export async function makeTmpDir(t, prefix = "openclaw-dropbox-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

export async function writeFile(filePath, content, mode = 0o600) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { mode });
  return filePath;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
