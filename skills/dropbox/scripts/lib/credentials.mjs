import { createHash } from "node:crypto";

import { CREDENTIAL_KEYS } from "./constants.mjs";
import { loadEnvFile } from "./env-file.mjs";
import { configError } from "./errors.mjs";

function clean(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Accepts epoch seconds, epoch milliseconds, or an ISO-8601 timestamp and
 * returns epoch milliseconds. Throws a config error for anything else.
 */
export function parseExpiresAt(raw) {
  const value = clean(raw);
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    // Anything below 10^12 cannot be a millisecond timestamp after 2001, so treat it as seconds.
    const millis = n < 1e12 ? n * 1000 : n;
    if (!Number.isFinite(millis) || !Number.isFinite(new Date(millis).getTime())) {
      throw configError("DROPBOX_ACCESS_TOKEN_EXPIRES_AT is outside the supported timestamp range.");
    }
    return millis;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw configError(
      "DROPBOX_ACCESS_TOKEN_EXPIRES_AT must be epoch seconds, epoch milliseconds, or an ISO-8601 timestamp.",
    );
  }
  return parsed;
}

function fingerprint(parts) {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/**
 * Merge credentials from the process environment and an optional env file.
 * Process environment wins over the file, matching dotenv conventions.
 * Only the keys in CREDENTIAL_KEYS are ever read.
 */
export async function resolveCredentials({ env, envFilePath }) {
  const file = await loadEnvFile(envFilePath, CREDENTIAL_KEYS);
  const merged = {};
  const sources = {};
  for (const key of CREDENTIAL_KEYS) {
    const fromEnv = clean(env[key]);
    const fromFile = clean(file.values.get(key));
    if (fromEnv !== undefined) {
      merged[key] = fromEnv;
      sources[key] = "env";
    } else if (fromFile !== undefined) {
      merged[key] = fromFile;
      sources[key] = "file";
    } else {
      sources[key] = null;
    }
  }

  const appKey = merged.DROPBOX_APP_KEY;
  const appSecret = merged.DROPBOX_APP_SECRET;
  const refreshToken = merged.DROPBOX_REFRESH_TOKEN;
  const canRefresh = Boolean(appKey && refreshToken);

  let staticToken;
  let staticTokenSource = null;
  if (merged.DROPBOX_ACCESS_TOKEN) {
    staticToken = merged.DROPBOX_ACCESS_TOKEN;
    staticTokenSource = "DROPBOX_ACCESS_TOKEN";
  } else if (merged.DROPBOX_MCP_TOKEN) {
    staticToken = merged.DROPBOX_MCP_TOKEN;
    staticTokenSource = "DROPBOX_MCP_TOKEN";
  }
  const staticTokenExpiresAt = staticToken ? parseExpiresAt(merged.DROPBOX_ACCESS_TOKEN_EXPIRES_AT) : null;

  if (refreshToken && !appKey) {
    throw configError("DROPBOX_REFRESH_TOKEN is set but DROPBOX_APP_KEY is missing; both are needed to refresh.");
  }

  // The fingerprint ties a cached access token to the credentials that produced
  // it. Changing the app or the refresh token (for example switching accounts)
  // changes the fingerprint and invalidates the cache. Secrets are hashed, never
  // stored.
  const credentialFingerprint = canRefresh
    ? fingerprint(["refresh:v1", appKey, refreshToken])
    : staticToken
      ? fingerprint(["static:v1", staticToken])
      : null;

  return {
    appKey,
    appSecret,
    refreshToken,
    canRefresh,
    staticToken,
    staticTokenSource,
    staticTokenExpiresAt,
    credentialFingerprint,
    sources,
    envFile: { path: file.path, status: file.status },
  };
}

/** Secret-free view of the credentials for status output and logs. */
export function describeCredentials(creds) {
  return {
    appKey: creds.sources.DROPBOX_APP_KEY,
    appSecret: creds.sources.DROPBOX_APP_SECRET,
    refreshToken: creds.sources.DROPBOX_REFRESH_TOKEN,
    staticToken: creds.staticTokenSource ? creds.sources[creds.staticTokenSource] : null,
    staticTokenKey: creds.staticTokenSource,
    staticTokenExpiresAt: creds.staticTokenExpiresAt ? new Date(creds.staticTokenExpiresAt).toISOString() : null,
    canRefresh: creds.canRefresh,
    envFile: creds.envFile,
  };
}
