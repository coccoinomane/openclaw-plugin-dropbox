import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { CREDENTIAL_KEYS } from "../skills/dropbox/scripts/lib/constants.mjs";
import { loadEnvFile, parseEnvFile } from "../skills/dropbox/scripts/lib/env-file.mjs";
import { makeTmpDir, writeFile } from "./helpers/tmp.mjs";

test("parseEnvFile reads only allowed keys and handles quotes, comments, export, CRLF, BOM", () => {
  const text =
    "﻿# comment\r\n" +
    "export DROPBOX_APP_KEY=abc\r\n" +
    "DROPBOX_REFRESH_TOKEN=\"quoted value\"\n" +
    "DROPBOX_APP_SECRET='single'\n" +
    "  DROPBOX_MCP_TOKEN =  spaced  \n" +
    "OTHER_SECRET=should-not-be-read\n" +
    "PATH=/evil\n" +
    "not a valid line\n" +
    "DROPBOX_APP_KEY=override\n";
  const values = parseEnvFile(text, CREDENTIAL_KEYS);
  assert.deepEqual(
    Object.fromEntries(values),
    {
      DROPBOX_APP_KEY: "override",
      DROPBOX_REFRESH_TOKEN: "quoted value",
      DROPBOX_APP_SECRET: "single",
      DROPBOX_MCP_TOKEN: "spaced",
    },
  );
  assert.equal(values.has("OTHER_SECRET"), false);
  assert.equal(values.has("PATH"), false);
});

test("parseEnvFile never treats shell syntax as executable", () => {
  const values = parseEnvFile("DROPBOX_APP_KEY=$(rm -rf /)\nDROPBOX_APP_SECRET=`whoami`\n", CREDENTIAL_KEYS);
  assert.equal(values.get("DROPBOX_APP_KEY"), "$(rm -rf /)");
  assert.equal(values.get("DROPBOX_APP_SECRET"), "`whoami`");
});

test("loadEnvFile: not configured, missing, loaded, and unreadable cases", async (t) => {
  const dir = await makeTmpDir(t);
  assert.deepEqual(await loadEnvFile(undefined, CREDENTIAL_KEYS), { path: null, status: "not-configured", values: new Map() });

  const missing = path.join(dir, "missing.env");
  assert.equal((await loadEnvFile(missing, CREDENTIAL_KEYS)).status, "missing");

  const file = await writeFile(path.join(dir, "ok.env"), "DROPBOX_APP_KEY=k\n");
  const loaded = await loadEnvFile(file, CREDENTIAL_KEYS);
  assert.equal(loaded.status, "loaded");
  assert.equal(loaded.values.get("DROPBOX_APP_KEY"), "k");

  await assert.rejects(loadEnvFile(dir, CREDENTIAL_KEYS), (err) => err.exitCode === 3 && /not a regular file/.test(err.message));

  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const locked = await writeFile(path.join(dir, "locked.env"), "DROPBOX_APP_KEY=k\n", 0o000);
    await fs.chmod(locked, 0o000);
    await assert.rejects(loadEnvFile(locked, CREDENTIAL_KEYS), (err) => err.exitCode === 3 && /Cannot read env file/.test(err.message));
  }
});
