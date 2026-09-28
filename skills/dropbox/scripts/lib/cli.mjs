import fs from "node:fs/promises";

import { EXIT } from "./constants.mjs";
import { resolveCredentials } from "./credentials.mjs";
import { WrapperError, configError } from "./errors.mjs";
import { buildChildEnv, missingMcporterError, resolveMcporter, runMcporter } from "./mcporter.mjs";
import { USAGE, parseArgs } from "./options.mjs";
import { buildStatus, renderStatus } from "./status.mjs";
import { resolveAccessToken } from "./token.mjs";

function reportError(err, stderr) {
  if (err instanceof WrapperError) {
    stderr.write(`dropbox-mcporter: ${err.message}\n`);
    if (err.hint) stderr.write(`hint: ${err.hint}\n`);
    return err.exitCode;
  }
  // Unexpected failure: print the message only, never a stack that could echo inputs.
  stderr.write(`dropbox-mcporter: unexpected error: ${err?.message ?? String(err)}\n`);
  return EXIT.ERROR;
}

async function requireConfigFile(options) {
  if (!options.mcporterConfig) {
    throw configError(
      "No mcporter config path configured.",
      "Pass --config <path>, or set DROPBOX_MCPORTER_CONFIG (or MCPORTER_CONFIG) to the shared mcporter config that defines the Dropbox server.",
    );
  }
  try {
    const stat = await fs.stat(options.mcporterConfig);
    if (!stat.isFile()) throw configError(`mcporter config is not a file: ${options.mcporterConfig}`);
  } catch (err) {
    if (err instanceof WrapperError) throw err;
    throw configError(`mcporter config not found: ${options.mcporterConfig}`, "Check --config / DROPBOX_MCPORTER_CONFIG.");
  }
}

function describeExpiry(expiresAt, now) {
  if (!expiresAt) return "expiry unknown";
  const minutes = Math.round((expiresAt - now) / 60000);
  return `expires ${new Date(expiresAt).toISOString()} (in ${minutes} min)`;
}

/**
 * Entry point shared by the script and the tests. Returns the process exit
 * code instead of calling process.exit so tests can run it in-process.
 */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    fetch = globalThis.fetch,
    spawn = undefined,
    now = () => Date.now(),
    pathContext = {},
  } = deps;

  let parsed;
  try {
    parsed = parseArgs(argv, env, pathContext);
  } catch (err) {
    const code = reportError(err, stderr);
    stderr.write(`\n${USAGE}`);
    return code;
  }
  const { command, commandArgs, json, options } = parsed;

  try {
    if (command === "help") {
      stdout.write(USAGE);
      return EXIT.OK;
    }

    if (command === "status") {
      const { report, exitCode } = await buildStatus(options, { env, now });
      stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderStatus(report));
      return exitCode;
    }

    const tokenDeps = {
      cacheDir: options.cacheDir,
      now,
      fetch,
      httpTimeoutMs: options.httpTimeoutMs,
      lockTimeoutMs: options.lockTimeoutMs,
    };

    if (command === "refresh") {
      const credentials = await resolveCredentials({ env, envFilePath: options.envFile });
      const result = await resolveAccessToken({ credentials, force: true, ...tokenDeps });
      const summary = { ok: true, source: result.source, expiresAt: new Date(result.expiresAt).toISOString(), cacheDir: options.cacheDir };
      stdout.write(json ? `${JSON.stringify(summary)}\n` : `Token refreshed; ${describeExpiry(result.expiresAt, now())}. Cache: ${options.cacheDir}\n`);
      return EXIT.OK;
    }

    // list / schema / call: check the executable and config before spending a refresh.
    await requireConfigFile(options);
    const mcporter = await resolveMcporter(options.mcporterBin, { env, source: options.mcporterBinSource });
    if (!mcporter.found) throw missingMcporterError(mcporter);

    const credentials = await resolveCredentials({ env, envFilePath: options.envFile });
    const token = await resolveAccessToken({ credentials, force: false, ...tokenDeps });

    const server = options.serverName;
    let args;
    if (command === "list") {
      args = ["--config", options.mcporterConfig, "list", server, ...commandArgs];
    } else if (command === "schema") {
      args = ["--config", options.mcporterConfig, "list", server, "--schema", ...commandArgs];
    } else {
      const [tool, ...rest] = commandArgs;
      const selector = tool.startsWith(`${server}.`) ? tool : `${server}.${tool}`;
      args = ["--config", options.mcporterConfig, "call", selector, ...rest];
    }

    const result = await runMcporter({
      executable: mcporter.path,
      args,
      env: buildChildEnv(env, token.token),
      ...(spawn ? { spawn } : {}),
    });
    if (result.signal) stderr.write(`dropbox-mcporter: mcporter terminated by ${result.signal}\n`);
    return result.code;
  } catch (err) {
    return reportError(err, stderr);
  }
}
