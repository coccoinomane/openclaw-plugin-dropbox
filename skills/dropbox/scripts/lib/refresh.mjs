import { DEFAULT_HTTP_TIMEOUT_MS, TOKEN_ENDPOINT } from "./constants.mjs";
import { refreshError } from "./errors.mjs";

const SAFE_OAUTH_ERRORS = new Set(["invalid_grant", "invalid_client", "invalid_request", "unsupported_grant_type", "invalid_scope", "server_error", "temporarily_unavailable"]);

function hintFor(errorCode) {
  switch (errorCode) {
    case "invalid_grant":
      return "The refresh token was rejected. Re-authorize the app and store the new DROPBOX_REFRESH_TOKEN.";
    case "invalid_client":
      return "Dropbox rejected the app credentials. Check DROPBOX_APP_KEY and DROPBOX_APP_SECRET.";
    default:
      return undefined;
  }
}

/**
 * Exchange a refresh token for a new short-lived access token.
 *
 * Only the fixed Dropbox token endpoint is ever contacted. Errors never carry
 * the request body, tokens, or the raw upstream response. The request is made
 * exactly once; there are no automatic retries.
 */
export async function refreshAccessToken(
  { appKey, appSecret, refreshToken },
  { fetch = globalThis.fetch, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, now = () => Date.now() } = {},
) {
  if (!appKey || !refreshToken) {
    throw refreshError("Cannot refresh: DROPBOX_APP_KEY and DROPBOX_REFRESH_TOKEN are required.");
  }
  if (typeof fetch !== "function") {
    throw refreshError("No fetch implementation is available in this Node runtime.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: appKey,
  });
  if (appSecret) body.set("client_secret", appSecret);

  const requestedAt = now();
  let response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw refreshError(`Token refresh timed out after ${timeoutMs} ms.`, undefined, err);
    }
    throw refreshError(
      `Token refresh request failed: ${err?.cause?.code ?? err?.code ?? err?.name ?? "network error"}.`,
      "Check network connectivity to api.dropboxapi.com.",
      err,
    );
  }

  let text;
  try {
    text = await response.text();
  } catch (err) {
    throw refreshError(`Token refresh response could not be read (HTTP ${response.status}).`, undefined, err);
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const code = SAFE_OAUTH_ERRORS.has(json?.error) ? json.error : null;
    const detail = code ?? "unrecognized OAuth error";
    throw refreshError(`Dropbox refused the token refresh (HTTP ${response.status}, ${detail}).`, hintFor(code));
  }

  if (!json || typeof json !== "object") {
    throw refreshError(`Token refresh returned HTTP ${response.status} without a JSON body.`);
  }
  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw refreshError("Token refresh response is missing access_token.");
  }
  if (json.token_type !== undefined && String(json.token_type).toLowerCase() !== "bearer") {
    throw refreshError("Token refresh returned an unsupported token_type.");
  }
  const expiresIn = Number(json.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || !Number.isFinite(new Date(requestedAt + expiresIn * 1000).getTime())) {
    throw refreshError("Token refresh response has an invalid expires_in value.");
  }

  if (requestedAt + Math.floor(expiresIn * 1000) - now() <= 300_000) {
    throw refreshError("Refreshed token expires too soon to use safely.");
  }

  return {
    accessToken: accessToken.trim(),
    expiresAt: requestedAt + Math.floor(expiresIn * 1000),
    obtainedAt: requestedAt,
    tokenType: "bearer",
    scope: typeof json.scope === "string" ? json.scope : null,
    accountId: typeof json.account_id === "string" ? json.account_id : null,
  };
}
