import assert from "node:assert/strict";
import { test } from "node:test";

import { TOKEN_ENDPOINT } from "../skills/dropbox/scripts/lib/constants.mjs";
import { refreshAccessToken } from "../skills/dropbox/scripts/lib/refresh.mjs";

const CREDS = { appKey: "app-key", appSecret: "app-secret", refreshToken: "refresh-secret" };

function jsonResponse(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("posts a form-encoded refresh request to the fixed endpoint and validates the response", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ access_token: "sl.new", token_type: "bearer", expires_in: 14400, scope: "files.metadata.read" });
  };
  const now = () => 1_700_000_000_000;
  const result = await refreshAccessToken(CREDS, { fetch, now });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TOKEN_ENDPOINT);
  assert.equal(calls[0].url, "https://api.dropboxapi.com/oauth2/token");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  const form = Object.fromEntries(new URLSearchParams(calls[0].init.body));
  assert.deepEqual(form, { grant_type: "refresh_token", refresh_token: "refresh-secret", client_id: "app-key", client_secret: "app-secret" });
  assert.deepEqual(result, {
    accessToken: "sl.new",
    expiresAt: 1_700_000_000_000 + 14400 * 1000,
    obtainedAt: 1_700_000_000_000,
    tokenType: "bearer",
    scope: "files.metadata.read",
    accountId: null,
  });
});

test("omits client_secret for PKCE apps and requires app key + refresh token", async () => {
  let body;
  const fetch = async (_url, init) => {
    body = Object.fromEntries(new URLSearchParams(init.body));
    return jsonResponse({ access_token: "sl.x", expires_in: 100 });
  };
  await refreshAccessToken({ appKey: "k", refreshToken: "r" }, { fetch });
  assert.equal("client_secret" in body, false);
  await assert.rejects(refreshAccessToken({ appKey: "k" }, { fetch }), (err) => err.exitCode === 5);
});

test("Dropbox errors are reported by code without leaking secrets, and are never retried", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return jsonResponse({ error: "invalid_grant", error_description: "refresh token is invalid or revoked. token=refresh-secret" }, 400);
  };
  await assert.rejects(refreshAccessToken(CREDS, { fetch }), (err) => {
    assert.equal(err.exitCode, 5);
    assert.match(err.message, /HTTP 400, invalid_grant/);
    assert.match(err.hint, /Re-authorize/);
    return true;
  });
  assert.equal(calls, 1);
});

test("malformed success responses are rejected", async () => {
  const cases = [
    ["not json", jsonResponse("<html>oops</html>")],
    ["missing access_token", jsonResponse({ token_type: "bearer", expires_in: 100 })],
    ["empty access_token", jsonResponse({ access_token: "  ", expires_in: 100 })],
    ["bad token_type", jsonResponse({ access_token: "sl.x", token_type: "mac", expires_in: 100 })],
    ["bad expires_in", jsonResponse({ access_token: "sl.x", expires_in: "soon" })],
    ["zero expires_in", jsonResponse({ access_token: "sl.x", expires_in: 0 })],
  ];
  for (const [label, response] of cases) {
    await assert.rejects(refreshAccessToken(CREDS, { fetch: async () => response }), (err) => err.exitCode === 5, label);
  }
});

test("network failures and timeouts map to exit code 5 with a finite wait", async () => {
  await assert.rejects(
    refreshAccessToken(CREDS, { fetch: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); } }),
    (err) => err.exitCode === 5 && /ENOTFOUND/.test(err.message),
  );
  const hanging = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  const started = Date.now();
  await assert.rejects(refreshAccessToken(CREDS, { fetch: hanging, timeoutMs: 50 }), (err) => err.exitCode === 5 && /timed out/.test(err.message));
  assert.ok(Date.now() - started < 2_000);
});
