// Shared constants for the Dropbox mcporter wrapper.

// The refresh endpoint is fixed on purpose. There is no override so that
// credentials can never be redirected to another host by configuration.
export const TOKEN_ENDPOINT = "https://api.dropboxapi.com/oauth2/token";

export const DEFAULT_SERVER_NAME = "dropbox";

// Refresh when the cached token expires within this window.
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

// A lock older than this is considered abandoned even if its owner pid still
// exists (for example a hung process or a pid reused by another program).
export const LOCK_STALE_MS = 120_000;

export const CACHE_VERSION = 1;
export const CACHE_FILE_NAME = "token-cache.json";
export const LOCK_DIR_NAME = "token-cache.lock";

// The only keys the wrapper reads from an env file or the process environment
// when looking for Dropbox credentials.
export const CREDENTIAL_KEYS = Object.freeze([
  "DROPBOX_APP_KEY",
  "DROPBOX_APP_SECRET",
  "DROPBOX_REFRESH_TOKEN",
  "DROPBOX_MCP_TOKEN",
  "DROPBOX_ACCESS_TOKEN",
  "DROPBOX_ACCESS_TOKEN_EXPIRES_AT",
]);

// The env var the mcporter config references in its Authorization header.
export const CHILD_TOKEN_ENV_KEY = "DROPBOX_MCP_TOKEN";

// Plugin-owned, secret-free path and behaviour settings.
export const ENV = Object.freeze({
  MCPORTER_BIN: "DROPBOX_MCPORTER_BIN",
  MCPORTER_CONFIG: "DROPBOX_MCPORTER_CONFIG",
  ENV_FILE: "DROPBOX_ENV_FILE",
  CACHE_DIR: "DROPBOX_TOKEN_CACHE_DIR",
  SERVER: "DROPBOX_MCPORTER_SERVER",
  HTTP_TIMEOUT_MS: "DROPBOX_REFRESH_TIMEOUT_MS",
  LOCK_TIMEOUT_MS: "DROPBOX_LOCK_TIMEOUT_MS",
});

export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  CONFIG: 3,
  MCPORTER_MISSING: 4,
  REFRESH_FAILED: 5,
  LOCK_TIMEOUT: 6,
});

export const INSTALL_HINT =
  "Install mcporter with `npm install -g mcporter` (the upstream OpenClaw mcporter skill declares the same node installer), " +
  "or point the wrapper at an existing executable with --mcporter <path> or DROPBOX_MCPORTER_BIN.";
