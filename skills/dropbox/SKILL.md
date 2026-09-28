---
name: dropbox
description: Check, search, read, write, or share files in Dropbox through the mcporter CLI with automatic OAuth token refresh. Use for requests such as "check Dropbox", "search Dropbox for X", "read this file from Dropbox", "create a folder on Dropbox", "make a Dropbox link", or the Italian "controlla/cerca/leggi/scrivi su Dropbox". Do not register Dropbox tools with the model.
metadata:
  {
    "openclaw":
      {
        "emoji": "📦",
        "requires": { "bins": ["node", "mcporter"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "mcporter",
              "bins": ["mcporter"],
              "label": "Install mcporter (node)",
            },
          ],
      },
  }
---

# Dropbox through mcporter

Always go through the bundled wrapper. It refreshes the Dropbox access token when it is missing or about to expire, then runs the already installed `mcporter` against the `dropbox` server from the shared mcporter config. Do not call `mcporter` directly for Dropbox and do not paste tokens into commands.

```bash
node "{baseDir}/scripts/dropbox-mcporter.mjs" <command> [args]
```

The plugin sets `DROPBOX_MCPORTER_CONFIG`, `DROPBOX_ENV_FILE`, `DROPBOX_TOKEN_CACHE_DIR`, and related path variables for `exec` when they are configured in `plugins.entries.dropbox.config`. You should not need any option flags.

## Workflow

1. If this is the first Dropbox request in the session, or a previous call failed, check the setup. `status` contacts nothing and prints no secrets:

   ```bash
   node "{baseDir}/scripts/dropbox-mcporter.mjs" status
   ```

   Exit code 4 means `mcporter` is not installed. Report the install hint from the output to the user; never install it yourself. Exit code 3 means a config or credential problem; report the listed problems.

2. Discover the tools and their input schemas before the first call:

   ```bash
   node "{baseDir}/scripts/dropbox-mcporter.mjs" schema
   ```

3. Read or search:

   ```bash
   node "{baseDir}/scripts/dropbox-mcporter.mjs" call search --args '{"query":"invoice april"}' --output json
   node "{baseDir}/scripts/dropbox-mcporter.mjs" call list_folder --args '{"path":""}' --output json
   node "{baseDir}/scripts/dropbox-mcporter.mjs" call get_file_metadata --args '{"path_or_file_id":"/Documents/report.pdf"}' --output json
   node "{baseDir}/scripts/dropbox-mcporter.mjs" call get_file_content --args '{"path_or_file_id":"/Documents/notes.md"}' --output json
   node "{baseDir}/scripts/dropbox-mcporter.mjs" call get_usage_and_quota --output json
   ```

4. Write, create, or share only after describing the exact change and getting explicit confirmation from the user:

   ```bash
   node "{baseDir}/scripts/dropbox-mcporter.mjs" call create_folder --args '{"path":"/Documents/NewFolder"}' --output json
   node "{baseDir}/scripts/dropbox-mcporter.mjs" call create_file --args '{"path":"/Documents/notes.md","content":"Hello"}' --output json
   node "{baseDir}/scripts/dropbox-mcporter.mjs" call create_shared_link --args '{"path_or_file_id":"/Documents/report.pdf"}' --output json
   ```

Tool names above are the ones exposed by the official Dropbox remote MCP server at the time of writing; trust the output of `schema` over this list.

## Rules

- Pass arguments as JSON with `--args` and request `--output json`; this avoids shell quoting mistakes and gives parseable results.
- Do not retry a call that creates, modifies, deletes, or shares anything. If it failed, show the error and ask.
- A failure mentioning `401` or an invalid token after a fresh refresh means the account's refresh token was revoked or the app changed. Run `status`, then tell the user to re-authorize; do not loop on `refresh`.
- `refresh` forces a new token and is only for diagnostics; normal calls refresh on their own.
- Large outputs: write them to a private file and read a summary, instead of printing everything into the conversation.
- Never echo the env file, the token cache, or any `DROPBOX_*` value. In group chats, share Dropbox contents only when the user clearly wants that.
