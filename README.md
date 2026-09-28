# openclaw-plugin-dropbox

Dropbox for OpenClaw, using the `mcporter` CLI you already have. The plugin ships a skill and a small Node wrapper. The wrapper refreshes the Dropbox OAuth access token when needed, then runs `mcporter` against the `dropbox` server in your existing mcporter config.

The plugin does not register Dropbox tools with the model, does not bundle or depend on `mcporter`, and does not start an MCP server of its own. Dropbox stays behind a skill so it costs no context until the user asks for it.

## How it works

```
agent (skill)  ──►  node skills/dropbox/scripts/dropbox-mcporter.mjs call search --args '{...}'
                          │
                          ├─ 1. find mcporter executable and the mcporter config  (fail early, no network)
                          ├─ 2. load DROPBOX_* keys from the env file / environment
                          ├─ 3. token cache fresh?  ── yes ──► reuse
                          │        └─ no ──► lock ──► POST https://api.dropboxapi.com/oauth2/token ──► cache (0600)
                          └─ 4. spawn mcporter with DROPBOX_MCP_TOKEN=<access token> in the child env only
```

- The refresh endpoint is fixed in the code. Nothing in config or environment can redirect it.
- Access tokens are cached in a plugin-owned directory (mode 0700) as a file with mode 0600, written atomically.
- A refresh happens when the cached token is missing, produced by different credentials, or expires within 5 minutes.
- Concurrent wrapper processes share one refresh through a directory lock with bounded waits and stale-lock recovery.
- The refresh token and app secret are removed from the child environment. Only the short-lived access token reaches `mcporter`.
- Nothing is retried automatically. A failed `mcporter` call, mutating or not, is reported once.

## Requirements

- OpenClaw 2026.9.4 or newer (the plugin was written against that host).
- Node 24.16 or newer.
- `mcporter` installed and on `PATH`, or its path configured. The plugin never installs it. The upstream OpenClaw `mcporter` skill declares the node installer (`npm install -g mcporter`); this plugin's skill declares the same one so the macOS Skills UI can offer it.
- An existing mcporter config with a `dropbox` server whose `Authorization` header references `${DROPBOX_MCP_TOKEN}`.
- A Dropbox app with a refresh token (recommended) or a static access token.

## Installation

For a local development checkout, link the directory so OpenClaw loads it from source:

```bash
openclaw plugins install --link /path/to/openclaw-plugin-dropbox
```

The Gateway asks for capability consent on link installs. Restart the Gateway afterwards if it is not managed. Inspect the loaded runtime with:

```bash
openclaw plugins inspect dropbox --runtime --json
```

To prove the package shape before publishing, pack it and install the tarball:

```bash
npm pack --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/openclaw-plugin-dropbox-0.1.0.tgz --force
```

No package name on npm or ClawHub has been assigned yet.

## Setup

### 1. mcporter config

Keep using your existing shared mcporter config. The plugin only reads it and never writes to it. The Dropbox entry should look like this:

```json
{
  "mcpServers": {
    "dropbox": {
      "baseUrl": "https://mcp.dropbox.com/mcp",
      "description": "Official Dropbox remote MCP server",
      "headers": {
        "Authorization": "Bearer ${DROPBOX_MCP_TOKEN}"
      }
    }
  }
}
```

`mcporter` substitutes `${DROPBOX_MCP_TOKEN}` from its process environment. The wrapper sets that variable for the child process, so the file itself contains no token.

### 2. Dropbox app and refresh token

1. In the [Dropbox App Console](https://www.dropbox.com/developers/apps), create a scoped app (or reuse one). Note the app key. If the app has a client secret, note it too; apps created for PKCE have none.
2. On the Permissions tab, grant only what the agent needs. For the workflows in the skill: `account_info.read`, `files.metadata.read`, `files.content.read`, and, only if the agent should write or share, `files.content.write` and `sharing.write`. Users can re-run the authorization to add scopes later.
3. Authorize once in a browser and request a refresh token with `token_access_type=offline`:

   ```
   https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&response_type=code&token_access_type=offline
   ```

4. Exchange the code for tokens. Copy the `refresh_token` from the response; the `access_token` is short-lived and can be ignored.

   ```bash
   curl https://api.dropboxapi.com/oauth2/token \
     -d code=<CODE> -d grant_type=authorization_code \
     -d client_id=<APP_KEY> -d client_secret=<APP_SECRET>   # omit client_secret for PKCE apps
   ```

Refresh tokens do not expire on their own, but the user can revoke them and Dropbox invalidates them when the app is changed. Revocation shows up as `invalid_grant` from the wrapper.

### 3. Credentials env file

Copy `.env.example` to a private location, for example `~/.openclaw/dropbox.env`, set its mode to 600, and fill in the keys:

```bash
DROPBOX_APP_KEY=...
DROPBOX_APP_SECRET=...          # only for apps with a client secret
DROPBOX_REFRESH_TOKEN=...
```

The wrapper reads only these keys from the file: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`, `DROPBOX_MCP_TOKEN`, `DROPBOX_ACCESS_TOKEN`, `DROPBOX_ACCESS_TOKEN_EXPIRES_AT`. The file is parsed as data (`KEY=VALUE`, optional quotes, `#` comments) and never sourced by a shell. Values already present in the process environment win over the file.

A static token in `DROPBOX_ACCESS_TOKEN` (or the older `DROPBOX_MCP_TOKEN`) still works. With `DROPBOX_ACCESS_TOKEN_EXPIRES_AT` set, the wrapper uses it until 5 minutes before expiry. Without an expiry, the wrapper prefers refreshing when refresh credentials exist, and otherwise uses the static token as is.

### 4. Plugin config

Add the plugin to `~/.openclaw/openclaw.json`. Paths accept `~`, `${ENV_VAR}` references, and relative paths (resolved against the OpenClaw state directory):

```json5
{
  plugins: {
    entries: {
      dropbox: {
        enabled: true,
        config: {
          mcporterConfig: "~/.openclaw/workspace/config/mcporter.json",
          envFile: "~/.openclaw/dropbox.env",
          // optional:
          // mcporterBin: "/opt/homebrew/bin/mcporter",
          // cacheDir: "~/.cache/openclaw-dropbox",
          // serverName: "dropbox",
        },
      },
    },
  },
}
```

At `exec` time the plugin injects only these variables, all of them paths or names: `DROPBOX_MCPORTER_BIN`, `DROPBOX_MCPORTER_CONFIG`, `DROPBOX_ENV_FILE`, `DROPBOX_TOKEN_CACHE_DIR`, `DROPBOX_MCPORTER_SERVER`. It never reads the env file and never injects a credential into the shared exec environment.

### 5. Check

```bash
node skills/dropbox/scripts/dropbox-mcporter.mjs status
```

`status` reports the resolved executable, config, env file, which credential keys are present (names and sources only), and the cache state. It contacts nothing and exits 0 when the setup is usable.

## Wrapper reference

```
node skills/dropbox/scripts/dropbox-mcporter.mjs [global options] <command> [args]

status [--json]         diagnose setup; no network, no secrets in output
refresh [--json]        force a token refresh and update the cache
list [mcporter args]    mcporter list dropbox ...
schema [mcporter args]  mcporter list dropbox --schema ...
call <tool> [args]      mcporter call dropbox.<tool> ...
help
```

| Global option        | Env var                      | Default                                             |
| -------------------- | ---------------------------- | --------------------------------------------------- |
| `--mcporter`         | `DROPBOX_MCPORTER_BIN`       | `mcporter` on `PATH`                                |
| `--config`           | `DROPBOX_MCPORTER_CONFIG`    | `MCPORTER_CONFIG`, else required for list/schema/call |
| `--env-file`         | `DROPBOX_ENV_FILE`           | none (process environment only)                     |
| `--cache-dir`        | `DROPBOX_TOKEN_CACHE_DIR`    | `$XDG_CACHE_HOME/openclaw-dropbox` or `~/.cache/openclaw-dropbox` |
| `--server`           | `DROPBOX_MCPORTER_SERVER`    | `dropbox`                                           |
| `--timeout-ms`       | `DROPBOX_REFRESH_TIMEOUT_MS` | `20000`                                             |
| `--lock-timeout-ms`  | `DROPBOX_LOCK_TIMEOUT_MS`    | `30000`                                             |

Everything after `list`, `schema`, or `call <tool>` goes to `mcporter` unchanged. The wrapper always adds `--config <path>` itself.

Exit codes:

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| 0    | success                                                    |
| 1    | unexpected wrapper error                                   |
| 2    | usage error                                                |
| 3    | configuration error (config, env file, credentials, cache) |
| 4    | `mcporter` executable not found; the message says how to install it |
| 5    | token refresh failed (network, timeout, or Dropbox refused) |
| 6    | timed out waiting for the cache lock                       |
| N    | `mcporter` exit code, or 128+signal when it was killed by a signal |

Order of checks for `list`, `schema`, and `call`: config path, then executable, then credentials and token. A missing `mcporter` is reported before any network call.

## Security notes

- Secrets live in the env file and the token cache only. Both are ignored by git (`.gitignore`), and the cache directory is created with mode 0700 and the cache file with 0600. Existing cache files with wider permissions are flagged by `status`.
- The cache records a SHA-256 fingerprint of the credentials that produced the token. Changing the app key or refresh token (for example switching accounts) invalidates the cache instead of reusing a token for the wrong account.
- The wrapper never prints tokens, request bodies, or raw upstream responses. Error output carries the Dropbox error code and a truncated description at most.
- The mcporter child receives the parent environment minus every `DROPBOX_*` credential key, plus `DROPBOX_MCP_TOKEN` set to the current access token. Tokens are never passed as command-line arguments.
- `mcporter` is spawned with an argument array and no shell.
- Dropbox scopes: request the minimum. Read-only setups do not need `files.content.write` or `sharing.write`.
- The skill instructs the agent to confirm before any write or share and never to retry mutating calls.

## Development

```bash
npm test          # node --test "test/*.test.mjs"
npm pack --dry-run
```

Tests use only `node:test`. Dropbox is never contacted: refresh tests run against an in-process HTTP server (the CLI tests reach it through a test-only `--import` preload that redirects the fixed endpoint), `mcporter` is replaced by a fake executable under `test/helpers/`, and plugin registration is tested against a mocked API plus a stubbed `openclaw/plugin-sdk/plugin-entry` module loader. The tests do not prove that a live OpenClaw host loads the plugin; verify that with `openclaw plugins inspect dropbox --runtime --json` after linking.

Layout:

```
index.js                                  plugin entry (definePluginEntry)
src/plugin.mjs                            plugin definition, config resolution, exec env hook
openclaw.plugin.json                      manifest (id, config schema, skills dir)
skills/dropbox/SKILL.md                   the skill
skills/dropbox/scripts/dropbox-mcporter.mjs   wrapper CLI entry
skills/dropbox/scripts/lib/               wrapper modules (credentials, cache, lock, refresh, mcporter)
test/                                     node:test suites and helpers
```

## Troubleshooting

- `mcporter executable not available` (exit 4): install `mcporter` or set `mcporterBin`. `status` shows where the wrapper looked.
- `No mcporter config path configured` (exit 3): set `mcporterConfig` in the plugin config or pass `--config`.
- `Dropbox refused the token refresh (HTTP 400, invalid_grant)` (exit 5): the refresh token was revoked or belongs to a different app. Re-authorize and update the env file.
- `mcporter` fails with 401 right after a refresh: the token placeholder in the mcporter config may be missing. `status` warns when the `dropbox` entry does not reference `${DROPBOX_MCP_TOKEN}`.
- `Timed out ... waiting for the token cache lock` (exit 6): another wrapper is refreshing, or a lock directory was left behind by a process that is still running. Dead-owner locks are recovered automatically.

## License

MIT
