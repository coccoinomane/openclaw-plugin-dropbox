import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CHILD_TOKEN_ENV_KEY, CREDENTIAL_KEYS, EXIT, INSTALL_HINT } from "./constants.mjs";
import { WrapperError } from "./errors.mjs";

const WINDOWS = process.platform === "win32";

async function isExecutableFile(candidate) {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
    if (WINDOWS) return true;
    await fs.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsCandidates(name, env) {
  if (!WINDOWS || path.extname(name)) return [name];
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [name, ...exts.map((ext) => name + ext)];
}

/**
 * Locate the mcporter executable. `spec` is either a path (contains a
 * separator) or a bare command name looked up on PATH. Returns
 * `{ found, path, source, reason }` and never throws.
 */
export async function resolveMcporter(spec, { env = process.env, source = "default" } = {}) {
  const name = (spec && spec.trim()) || "mcporter";
  if (name.includes("/") || (WINDOWS && name.includes("\\"))) {
    const absolute = path.resolve(name);
    for (const candidate of windowsCandidates(absolute, env)) {
      if (await isExecutableFile(candidate)) return { found: true, path: candidate, source, reason: null };
    }
    return { found: false, path: absolute, source, reason: "not an executable file" };
  }
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of windowsCandidates(path.join(dir, name), env)) {
      if (await isExecutableFile(candidate)) return { found: true, path: candidate, source: `${source} (PATH)`, reason: null };
    }
  }
  return { found: false, path: name, source, reason: "not found on PATH" };
}

export function missingMcporterError(resolution) {
  return new WrapperError(`mcporter executable not available: ${resolution.path} (${resolution.reason}).`, {
    exitCode: EXIT.MCPORTER_MISSING,
    hint: INSTALL_HINT,
  });
}

/**
 * Build the child environment: inherit the parent, remove every credential
 * input key, then set only the token key mcporter's config references.
 */
export function buildChildEnv(parentEnv, accessToken) {
  const env = { ...parentEnv };
  for (const key of CREDENTIAL_KEYS) delete env[key];
  env[CHILD_TOKEN_ENV_KEY] = accessToken;
  return env;
}

function signalExitCode(signal) {
  const number = os.constants.signals[signal];
  return Number.isInteger(number) ? 128 + number : EXIT.ERROR;
}

/**
 * Spawn mcporter with an argv array (never a shell string), inherit stdio,
 * forward termination signals, and resolve with the exit code to propagate.
 */
export function runMcporter({ executable, args, env, spawn = nodeSpawn }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, { env, stdio: "inherit", windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    const forwarded = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map();
    for (const signal of forwarded) {
      const handler = () => {
        try {
          child.kill(signal);
        } catch {
          // Child already gone.
        }
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once("error", (err) => {
      cleanup();
      reject(
        new WrapperError(`Failed to start mcporter (${executable}): ${err?.code ?? err?.message}.`, {
          exitCode: EXIT.MCPORTER_MISSING,
          hint: INSTALL_HINT,
        }),
      );
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal) {
        resolve({ code: signalExitCode(signal), signal });
      } else {
        resolve({ code: code ?? EXIT.ERROR, signal: null });
      }
    });
  });
}
