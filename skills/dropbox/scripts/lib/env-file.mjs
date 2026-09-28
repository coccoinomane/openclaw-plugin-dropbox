import fs from "node:fs/promises";

import { configError } from "./errors.mjs";

const LINE_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(raw) {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parse dotenv-style text and return only the keys in `allowedKeys`.
 *
 * The parser is deliberately small: one `KEY=VALUE` per line, optional
 * `export ` prefix, optional matching single or double quotes, `#` comment
 * lines. It never executes anything, so an env file is data, not a shell
 * script. Later assignments override earlier ones, as they would in a shell.
 */
export function parseEnvFile(text, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const values = new Map();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = LINE_PATTERN.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!allowed.has(key)) continue;
    values.set(key, unquote(rawValue));
  }
  return values;
}

/**
 * Load an optional env file. A missing file is not an error; an unreadable or
 * non-regular file is, because silently ignoring it would hide a setup mistake.
 */
export async function loadEnvFile(filePath, allowedKeys) {
  if (!filePath) return { path: null, status: "not-configured", values: new Map() };
  let text;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw configError(`Env file is not a regular file: ${filePath}`);
    }
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { path: filePath, status: "missing", values: new Map() };
    if (err?.exitCode) throw err;
    throw configError(`Cannot read env file ${filePath}: ${err?.code ?? err?.message ?? "unknown error"}`);
  }
  return { path: filePath, status: "loaded", values: parseEnvFile(text, allowedKeys) };
}
