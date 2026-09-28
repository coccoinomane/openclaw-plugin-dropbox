import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  PLUGIN_DESCRIPTION,
  PLUGIN_ENV_KEYS,
  PLUGIN_ID,
  configSchema,
  createPluginDefinition,
  resolveConfigPath,
  resolvePluginEnv,
  uiHints,
} from "../src/plugin.mjs";
import { HELPERS_DIR, REPO_ROOT, SKILL_DIR } from "./helpers/paths.mjs";

const execFileAsync = promisify(execFile);
const byteLength = (s) => Buffer.byteLength(s, "utf8");

test("definition, manifest, and skill metadata agree and stay within limits", async () => {
  const def = createPluginDefinition();
  assert.equal(def.id, "dropbox");
  assert.equal(def.name, "Dropbox");
  assert.equal(typeof def.register, "function");
  assert.ok(byteLength(def.description) <= 500, "plugin description must be at most 500 UTF-8 bytes");

  const manifest = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "openclaw.plugin.json"), "utf8"));
  assert.equal(manifest.id, PLUGIN_ID);
  assert.equal(manifest.description, PLUGIN_DESCRIPTION);
  assert.deepEqual(manifest.configSchema, configSchema);
  assert.deepEqual(manifest.uiHints, uiHints);
  assert.deepEqual(manifest.skills, ["skills"]);
  assert.equal(manifest.activation?.onStartup, true);
  assert.equal(manifest.contracts, undefined, "no model tools are declared");
  assert.equal(manifest.mcpServers, undefined, "no native MCP registration");

  const skill = await fs.readFile(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  const frontmatter = skill.split("---")[1];
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1];
  assert.ok(description, "skill description present");
  assert.ok(byteLength(description) <= 500, `skill description is ${byteLength(description)} bytes`);
  assert.match(frontmatter, /^name: dropbox$/m);
  assert.match(frontmatter, /"requires": \{ "bins": \["node", "mcporter"\] \}/);
  assert.match(frontmatter, /"kind": "node"/);
  assert.match(frontmatter, /"package": "mcporter"/);
  assert.match(skill, /\{baseDir\}\/scripts\/dropbox-mcporter\.mjs/);
  await fs.access(path.join(SKILL_DIR, "scripts", "dropbox-mcporter.mjs"));
});

test("resolveConfigPath expands ~, env references, and state-relative paths", () => {
  const env = { OPENCLAW_STATE_DIR: "/state", CFG: "~/from-env.json" };
  const home = "/home/u";
  assert.equal(resolveConfigPath("~/a.json", env, home), "/home/u/a.json");
  assert.equal(resolveConfigPath("~", env, home), "/home/u");
  assert.equal(resolveConfigPath("${CFG}", env, home), "/home/u/from-env.json");
  assert.equal(resolveConfigPath("$CFG", env, home), "/home/u/from-env.json");
  assert.equal(resolveConfigPath("relative/x.json", env, home), "/state/relative/x.json");
  assert.equal(resolveConfigPath("relative/x.json", {}, home), "/home/u/.openclaw/relative/x.json");
  assert.equal(resolveConfigPath("/abs//x.json", env, home), "/abs/x.json");
  assert.equal(resolveConfigPath("   ", env, home), undefined);
  assert.equal(resolveConfigPath("${MISSING}", env, home), undefined);
});

test("resolvePluginEnv injects only plugin-owned path variables and never secrets", () => {
  const env = {
    OPENCLAW_STATE_DIR: "/state",
    DROPBOX_REFRESH_TOKEN: "must-not-leak",
    DROPBOX_APP_SECRET: "must-not-leak-either",
    MY_ENV_FILE: "/private/dropbox.env",
  };
  const out = resolvePluginEnv(
    {
      mcporterConfig: "~/cfg/mcporter.json",
      envFile: "${MY_ENV_FILE}",
      cacheDir: "cache/dropbox",
      mcporterBin: "mcporter",
      serverName: "dropbox",
      unexpected: "DROPBOX_REFRESH_TOKEN=x",
    },
    env,
    "/home/u",
  );
  assert.deepEqual(out, {
    DROPBOX_MCPORTER_BIN: "mcporter",
    DROPBOX_MCPORTER_CONFIG: "/home/u/cfg/mcporter.json",
    DROPBOX_ENV_FILE: "/private/dropbox.env",
    DROPBOX_TOKEN_CACHE_DIR: "/state/cache/dropbox",
    DROPBOX_MCPORTER_SERVER: "dropbox",
  });
  const allowed = new Set(Object.values(PLUGIN_ENV_KEYS));
  for (const key of Object.keys(out)) assert.ok(allowed.has(key), `${key} is plugin-owned`);
  assert.equal(JSON.stringify(out).includes("must-not-leak"), false);

  assert.deepEqual(resolvePluginEnv({}, env, "/home/u"), {}, "nothing configured, nothing injected");
  assert.equal(resolvePluginEnv({ mcporterBin: "~/bin/mcporter" }, env, "/home/u").DROPBOX_MCPORTER_BIN, "/home/u/bin/mcporter");
  assert.equal(resolvePluginEnv({ serverName: "bad name!" }, env, "/home/u").DROPBOX_MCPORTER_SERVER, undefined);
});

test("register wires a resolve_exec_env hook that reads api.pluginConfig", async () => {
  const calls = [];
  const api = {
    pluginConfig: { mcporterConfig: "~/cfg.json", envFile: "~/dropbox.env" },
    on(name, handler, options) {
      calls.push({ name, handler, options });
    },
    registerTool() {
      throw new Error("the plugin must not register tools");
    },
  };
  createPluginDefinition().register(api);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "resolve_exec_env");
  assert.deepEqual(calls[0].options, { priority: 20 });
  const env = await calls[0].handler({ toolName: "exec", host: "gateway" }, {});
  assert.equal(env.DROPBOX_MCPORTER_CONFIG, path.join(process.env.HOME ?? "", "cfg.json"));
  assert.equal(env.DROPBOX_ENV_FILE, path.join(process.env.HOME ?? "", "dropbox.env"));
  assert.equal(Object.keys(env).length, 2);
});

test("index.js loads through definePluginEntry (SDK stubbed via module hooks)", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", path.join(HELPERS_DIR, "sdk-stub-register.mjs"), path.join(HELPERS_DIR, "load-index.mjs"), path.join(REPO_ROOT, "index.js")],
    { cwd: REPO_ROOT },
  );
  const summary = JSON.parse(stdout);
  assert.equal(summary.id, "dropbox");
  assert.equal(summary.name, "Dropbox");
  assert.equal(summary.description, PLUGIN_DESCRIPTION);
  assert.equal(summary.schemaType, "object");
  assert.equal(summary.stub, true);
  assert.deepEqual(summary.calls, [{ name: "resolve_exec_env", options: { priority: 20 }, hasHandler: true }]);
});
