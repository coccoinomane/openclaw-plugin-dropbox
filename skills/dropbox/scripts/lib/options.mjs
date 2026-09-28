import os from "node:os";
import path from "node:path";

import { DEFAULT_HTTP_TIMEOUT_MS, DEFAULT_LOCK_TIMEOUT_MS, DEFAULT_SERVER_NAME, ENV } from "./constants.mjs";
import { usageError } from "./errors.mjs";

export const COMMANDS = Object.freeze(["status", "refresh", "list", "schema", "call", "help"]);

const GLOBAL_FLAGS = Object.freeze({
  "--mcporter": "mcporterBin",
  "--config": "mcporterConfig",
  "--env-file": "envFile",
  "--cache-dir": "cacheDir",
  "--server": "serverName",
  "--timeout-ms": "httpTimeoutMs",
  "--lock-timeout-ms": "lockTimeoutMs",
});

export const USAGE = `Usage: dropbox-mcporter.mjs [global options] <command> [command args]

Commands
  status [--json]          Check mcporter, config, credentials, and the token cache. Contacts nothing.
  refresh [--json]         Refresh the access token now and update the cache.
  list [mcporter args]     Run "mcporter list <server> ..." with a fresh token.
  schema [mcporter args]   Run "mcporter list <server> --schema ..." with a fresh token.
  call <tool> [args]       Run "mcporter call <server>.<tool> ..." with a fresh token.
  help                     Show this text.

Global options (env var fallback in parentheses)
  --mcporter <path|name>   mcporter executable (${ENV.MCPORTER_BIN}; default: "mcporter" on PATH)
  --config <path>          mcporter config file (${ENV.MCPORTER_CONFIG}, then MCPORTER_CONFIG); required for list/schema/call
  --env-file <path>        optional env file with DROPBOX_* credentials (${ENV.ENV_FILE})
  --cache-dir <path>       token cache directory (${ENV.CACHE_DIR}; default: $XDG_CACHE_HOME/openclaw-dropbox or ~/.cache/openclaw-dropbox)
  --server <name>          mcporter server name (${ENV.SERVER}; default: ${DEFAULT_SERVER_NAME})
  --timeout-ms <n>         refresh HTTP timeout (${ENV.HTTP_TIMEOUT_MS}; default: ${DEFAULT_HTTP_TIMEOUT_MS})
  --lock-timeout-ms <n>    max wait for the cache lock (${ENV.LOCK_TIMEOUT_MS}; default: ${DEFAULT_LOCK_TIMEOUT_MS})

Arguments after list/schema/call are passed to mcporter unchanged, for example:
  call search --args '{"query":"invoice"}' --output json

Exit codes: 0 ok, 1 error, 2 usage, 3 configuration, 4 mcporter missing, 5 refresh failed, 6 lock timeout.
For list/schema/call the exit code of mcporter is returned; 128+N when it died from signal N.
`;

export function expandPath(value, { homedir = os.homedir(), cwd = process.cwd() } = {}) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === "~") return homedir;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return path.join(homedir, trimmed.slice(2));
  return path.resolve(cwd, trimmed);
}

function positiveInt(raw, label) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw usageError(`${label} must be a positive integer, got "${raw}".`);
  return n;
}

export function defaultCacheDir(env, homedir = os.homedir()) {
  const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim() ? env.XDG_CACHE_HOME.trim() : path.join(homedir, ".cache");
  return path.join(base, "openclaw-dropbox");
}

/**
 * Parse argv into `{ command, commandArgs, json, options }`. Global flags are
 * accepted only before the command; everything after the command belongs to
 * that command (and, for list/schema/call, to mcporter).
 */
export function parseArgs(argv, env = process.env, ctx = {}) {
  const flags = {};
  const rest = [...argv];
  while (rest.length > 0) {
    const token = rest[0];
    if (token === "-h" || token === "--help") {
      rest.shift();
      return { command: "help", commandArgs: [], json: false, options: buildOptions(flags, env, ctx) };
    }
    if (!token.startsWith("--")) break;
    const [name, inlineValue] = token.includes("=") ? token.split(/=(.*)/s, 2) : [token, undefined];
    const key = GLOBAL_FLAGS[name];
    if (!key) throw usageError(`Unknown global option: ${name}`, "Run with --help to see the accepted options.");
    rest.shift();
    const value = inlineValue !== undefined ? inlineValue : rest.shift();
    if (value === undefined) throw usageError(`Option ${name} requires a value.`);
    flags[key] = value;
  }
  const command = rest.shift();
  if (!command) throw usageError("No command given.", "Run with --help to see the commands.");
  if (!COMMANDS.includes(command)) throw usageError(`Unknown command: ${command}`, `Commands: ${COMMANDS.join(", ")}.`);

  let json = false;
  let commandArgs = rest;
  if (command === "status" || command === "refresh") {
    json = rest.includes("--json");
    const unknown = rest.filter((arg) => arg !== "--json");
    if (unknown.length > 0) throw usageError(`Unexpected arguments for ${command}: ${unknown.join(" ")}`);
    commandArgs = [];
  }
  if (command === "call") {
    const tool = rest[0];
    if (!tool || tool.startsWith("-")) throw usageError("call requires a tool name, for example: call list_folder --args '{\"path\":\"\"}'");
  }
  return { command, commandArgs, json, options: buildOptions(flags, env, ctx) };
}

function buildOptions(flags, env, ctx) {
  const pick = (flagKey, envKey) => (flags[flagKey] !== undefined ? flags[flagKey] : env[envKey]);
  const mcporterBinRaw = pick("mcporterBin", ENV.MCPORTER_BIN);
  const mcporterConfigRaw = pick("mcporterConfig", ENV.MCPORTER_CONFIG) ?? env.MCPORTER_CONFIG;
  const envFileRaw = pick("envFile", ENV.ENV_FILE);
  const cacheDirRaw = pick("cacheDir", ENV.CACHE_DIR);
  const serverName = (pick("serverName", ENV.SERVER) ?? "").trim() || DEFAULT_SERVER_NAME;
  if (!/^[A-Za-z0-9._-]+$/.test(serverName)) throw usageError(`Invalid server name: "${serverName}".`);

  const mcporterBin = mcporterBinRaw && mcporterBinRaw.trim() ? mcporterBinRaw.trim() : "mcporter";
  const looksLikePath = mcporterBin.includes("/") || mcporterBin.includes("\\") || mcporterBin.startsWith("~");

  return {
    mcporterBin: looksLikePath ? expandPath(mcporterBin, ctx) : mcporterBin,
    mcporterBinSource: flags.mcporterBin !== undefined ? "--mcporter" : env[ENV.MCPORTER_BIN] ? ENV.MCPORTER_BIN : "default",
    mcporterConfig: expandPath(mcporterConfigRaw, ctx),
    mcporterConfigSource:
      flags.mcporterConfig !== undefined
        ? "--config"
        : env[ENV.MCPORTER_CONFIG]
          ? ENV.MCPORTER_CONFIG
          : env.MCPORTER_CONFIG
            ? "MCPORTER_CONFIG"
            : null,
    envFile: expandPath(envFileRaw, ctx),
    cacheDir: expandPath(cacheDirRaw, ctx) ?? defaultCacheDir(env, ctx.homedir),
    serverName,
    httpTimeoutMs: positiveInt(pick("httpTimeoutMs", ENV.HTTP_TIMEOUT_MS), "--timeout-ms") ?? DEFAULT_HTTP_TIMEOUT_MS,
    lockTimeoutMs: positiveInt(pick("lockTimeoutMs", ENV.LOCK_TIMEOUT_MS), "--lock-timeout-ms") ?? DEFAULT_LOCK_TIMEOUT_MS,
  };
}
