import path from "node:path";

import { DEFAULT_HTTP_TIMEOUT_MS, DEFAULT_LOCK_TIMEOUT_MS, LOCK_DIR_NAME, REFRESH_SKEW_MS } from "./constants.mjs";
import { configError } from "./errors.mjs";
import { withLock } from "./lock.mjs";
import { refreshAccessToken } from "./refresh.mjs";
import { ensureCacheDir, evaluateEntry, readCache, writeCache } from "./token-cache.mjs";

function fromCache(entry) {
  return { token: entry.accessToken, expiresAt: entry.expiresAt, source: "cache", refreshed: false };
}

/**
 * Produce a usable access token, in this order of preference:
 *
 * 1. A cached token that matches the current credentials and is not within
 *    the refresh window.
 * 2. A static token from the environment whose expiry is known and far enough
 *    away.
 * 3. A fresh token from the refresh endpoint (cached afterwards).
 * 4. A static token without a known expiry, only when refreshing is not
 *    possible. Such a token is a best effort; callers cannot know when it dies.
 *
 * Refreshes are serialized across processes with a lock, and the cache is
 * re-read inside the lock so concurrent wrappers share one refresh.
 */
export async function resolveAccessToken({
  credentials,
  cacheDir,
  force = false,
  now = () => Date.now(),
  fetch = globalThis.fetch,
  httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  skewMs = REFRESH_SKEW_MS,
}) {
  const creds = credentials;
  if (!creds.canRefresh && !creds.staticToken) {
    throw configError(
      "No Dropbox credentials found.",
      "Set DROPBOX_APP_KEY and DROPBOX_REFRESH_TOKEN (recommended), or a static DROPBOX_ACCESS_TOKEN / DROPBOX_MCP_TOKEN, in the environment or the configured env file.",
    );
  }
  const fingerprint = creds.credentialFingerprint;

  if (!force) {
    const cached = await readCache(cacheDir);
    if (cached.state === "present" && evaluateEntry(cached.entry, { credentialFingerprint: fingerprint, now: now(), skewMs }) === "fresh") {
      return fromCache(cached.entry);
    }
    if (creds.staticToken && creds.staticTokenExpiresAt !== null) {
      if (creds.staticTokenExpiresAt - now() > skewMs) {
        return { token: creds.staticToken, expiresAt: creds.staticTokenExpiresAt, source: "static", refreshed: false };
      }
      if (!creds.canRefresh) {
        throw configError(
          `The static ${creds.staticTokenSource} has expired (or expires within ${Math.round(skewMs / 60000)} minutes) and no refresh credentials are configured.`,
          "Provide DROPBOX_APP_KEY and DROPBOX_REFRESH_TOKEN so the wrapper can refresh automatically, or supply a new token.",
        );
      }
    }
    if (!creds.canRefresh) {
      // Static token with unknown expiry and no way to refresh: use it as is.
      return { token: creds.staticToken, expiresAt: null, source: "static", refreshed: false };
    }
  } else if (!creds.canRefresh) {
    throw configError(
      "An explicit refresh needs DROPBOX_APP_KEY and DROPBOX_REFRESH_TOKEN.",
      "Static tokens cannot be refreshed; add refresh credentials to the env file.",
    );
  }

  await ensureCacheDir(cacheDir);
  const lockDir = path.join(cacheDir, LOCK_DIR_NAME);
  return withLock(
    lockDir,
    async () => {
      if (!force) {
        const cached = await readCache(cacheDir);
        if (cached.state === "present" && evaluateEntry(cached.entry, { credentialFingerprint: fingerprint, now: now(), skewMs }) === "fresh") {
          return fromCache(cached.entry);
        }
      }
      const result = await refreshAccessToken(
        { appKey: creds.appKey, appSecret: creds.appSecret, refreshToken: creds.refreshToken },
        { fetch, timeoutMs: httpTimeoutMs, now },
      );
      await writeCache(cacheDir, {
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
        obtainedAt: result.obtainedAt,
        source: "refresh",
        credentialFingerprint: fingerprint,
        scope: result.scope,
        accountId: result.accountId,
      });
      return { token: result.accessToken, expiresAt: result.expiresAt, source: "refresh", refreshed: true };
    },
    { timeoutMs: lockTimeoutMs, now },
  );
}
