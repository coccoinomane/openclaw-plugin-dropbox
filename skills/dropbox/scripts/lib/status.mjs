import fs from "node:fs/promises";

import { CHILD_TOKEN_ENV_KEY, EXIT, INSTALL_HINT } from "./constants.mjs";
import { describeCredentials, resolveCredentials } from "./credentials.mjs";
import { resolveMcporter } from "./mcporter.mjs";
import { describeCache, readCache } from "./token-cache.mjs";

/**
 * Inspect the mcporter config without printing any of its values. Header
 * values may contain literal tokens, so only booleans leave this function.
 */
export async function inspectMcporterConfig(configPath, serverName) {
  if (!configPath) return { path: null, state: "not-configured" };
  let text;
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch (err) {
    return { path: configPath, state: err?.code === "ENOENT" ? "missing" : "unreadable", reason: err?.code ?? null };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { path: configPath, state: "unparsed", reason: "not strict JSON; mcporter may still accept it" };
  }
  const server = parsed?.mcpServers?.[serverName];
  if (!server || typeof server !== "object") {
    return { path: configPath, state: "server-missing", serverName };
  }
  const serialized = JSON.stringify(server);
  return {
    path: configPath,
    state: "ok",
    serverName,
    hasBaseUrl: typeof server.baseUrl === "string" || typeof server.url === "string",
    referencesTokenEnv: serialized.includes(`\${${CHILD_TOKEN_ENV_KEY}}`),
  };
}

/**
 * Build a secret-free status report. This never refreshes a token and never
 * contacts Dropbox. Returns `{ report, exitCode }`.
 */
export async function buildStatus(options, { env = process.env, now = () => Date.now() } = {}) {
  const problems = [];
  const warnings = [];

  const mcporter = await resolveMcporter(options.mcporterBin, { env, source: options.mcporterBinSource });
  if (!mcporter.found) problems.push(`mcporter executable not available (${mcporter.reason}). ${INSTALL_HINT}`);

  const config = await inspectMcporterConfig(options.mcporterConfig, options.serverName);
  switch (config.state) {
    case "not-configured":
      problems.push("No mcporter config path. Set --config, DROPBOX_MCPORTER_CONFIG, or MCPORTER_CONFIG.");
      break;
    case "missing":
      problems.push(`mcporter config not found: ${config.path}`);
      break;
    case "unreadable":
      problems.push(`mcporter config unreadable (${config.reason}): ${config.path}`);
      break;
    case "server-missing":
      problems.push(`mcporter config has no "mcpServers.${options.serverName}" entry: ${config.path}`);
      break;
    case "unparsed":
      warnings.push(`mcporter config could not be parsed as strict JSON, so the "${options.serverName}" entry was not verified.`);
      break;
    default:
      if (!config.referencesTokenEnv) {
        warnings.push(
          `The "${options.serverName}" server entry does not reference \${${CHILD_TOKEN_ENV_KEY}}; the refreshed token will not reach mcporter.`,
        );
      }
  }

  let credentials = null;
  let credentialFingerprint = null;
  let credentialError = null;
  try {
    const resolved = await resolveCredentials({ env, envFilePath: options.envFile });
    credentials = describeCredentials(resolved);
    credentialFingerprint = resolved.credentialFingerprint;
  } catch (err) {
    credentialError = err?.message ?? String(err);
    problems.push(`Credentials: ${credentialError}`);
  }
  if (credentials) {
    if (credentials.envFile.status === "missing") warnings.push(`Env file not found: ${credentials.envFile.path}`);
    if (!credentials.canRefresh && !credentials.staticTokenKey) {
      problems.push(
        "No Dropbox credentials: set DROPBOX_APP_KEY and DROPBOX_REFRESH_TOKEN, or a static DROPBOX_ACCESS_TOKEN / DROPBOX_MCP_TOKEN.",
      );
    } else if (!credentials.canRefresh) {
      warnings.push(
        `Only a static token (${credentials.staticTokenKey}) is configured; it cannot be refreshed when it expires.`,
      );
    }
  }

  let cache = null;
  if (credentials) {
    cache = describeCache(await readCache(options.cacheDir), { credentialFingerprint, now: now() });
    if (cache.state === "corrupt") warnings.push(`Token cache is unreadable or corrupt and will be replaced on next refresh: ${cache.path}`);
    if (cache.state === "present" && cache.permissionsOk === false) warnings.push(`Token cache file permissions are wider than 0600: ${cache.path}`);
  } else {
    cache = { path: options.cacheDir, state: "not-checked" };
  }

  const report = {
    ok: problems.length === 0,
    mcporter: { path: mcporter.path, found: mcporter.found, source: mcporter.source, reason: mcporter.reason },
    config,
    envFile: credentials?.envFile ?? { path: options.envFile ?? null, status: credentialError ? "error" : "unknown" },
    credentials: credentials
      ? {
          appKey: credentials.appKey,
          appSecret: credentials.appSecret,
          refreshToken: credentials.refreshToken,
          staticToken: credentials.staticTokenKey ? { key: credentials.staticTokenKey, source: credentials.staticToken, expiresAt: credentials.staticTokenExpiresAt } : null,
          canRefresh: credentials.canRefresh,
        }
      : null,
    cache: { ...cache, directory: options.cacheDir },
    serverName: options.serverName,
    problems,
    warnings,
  };
  const exitCode = !mcporter.found ? EXIT.MCPORTER_MISSING : problems.length > 0 ? EXIT.CONFIG : EXIT.OK;
  return { report, exitCode };
}

function presence(source) {
  return source ? `set (${source})` : "not set";
}

export function renderStatus(report) {
  const lines = [];
  lines.push(`Dropbox mcporter wrapper: ${report.ok ? "ready" : "not ready"}`);
  lines.push(`  mcporter:     ${report.mcporter.found ? `${report.mcporter.path} [${report.mcporter.source}]` : `NOT FOUND (${report.mcporter.reason})`}`);
  const cfg = report.config;
  const cfgDetail =
    cfg.state === "ok"
      ? `ok, server "${cfg.serverName}" present, token placeholder ${cfg.referencesTokenEnv ? "present" : "MISSING"}`
      : cfg.state;
  lines.push(`  config:       ${cfg.path ?? "(none)"} [${cfgDetail}]`);
  lines.push(`  env file:     ${report.envFile.path ?? "(none)"} [${report.envFile.status}]`);
  if (report.credentials) {
    const c = report.credentials;
    lines.push(`  app key:      ${presence(c.appKey)}`);
    lines.push(`  app secret:   ${presence(c.appSecret)}`);
    lines.push(`  refresh tok.: ${presence(c.refreshToken)}`);
    lines.push(
      `  static token: ${c.staticToken ? `${c.staticToken.key} (${c.staticToken.source})${c.staticToken.expiresAt ? `, expires ${c.staticToken.expiresAt}` : ", expiry unknown"}` : "not set"}`,
    );
    lines.push(`  can refresh:  ${c.canRefresh ? "yes" : "no"}`);
  }
  const cache = report.cache;
  let cacheDetail = cache.state;
  if (cache.state === "present") {
    cacheDetail = `${cache.evaluation}, expires ${cache.expiresAt} (${cache.expiresInSeconds}s)${cache.permissionsOk === false ? ", permissions too open" : ""}`;
  } else if (cache.reason) {
    cacheDetail = `${cache.state} (${cache.reason})`;
  }
  lines.push(`  token cache:  ${cache.path ?? cache.directory} [${cacheDetail}]`);
  for (const w of report.warnings) lines.push(`  warning: ${w}`);
  for (const p of report.problems) lines.push(`  problem: ${p}`);
  return `${lines.join("\n")}\n`;
}
