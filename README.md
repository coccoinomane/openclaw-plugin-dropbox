# Dropbox for OpenClaw

Use Dropbox from OpenClaw through the [mcporter](https://mcporter.dev) CLI, with automatic OAuth token refresh.

The plugin packages a skill and a small CLI wrapper. It reuses your existing mcporter installation and configuration rather than adding Dropbox tools directly to OpenClaw. Before each request, the wrapper checks the access token and renews it if needed. No cron job or background service is required.

## Requirements

- **OpenClaw 2026.9.4** and Node.js 24.16+. Other OpenClaw versions need compatibility testing.
- **mcporter**, installed separately and available on `PATH` (tested with 0.12.3).
- A Dropbox app with an **OAuth refresh token**. See the [setup guide](docs/guide.md#2-dropbox-app-and-refresh-token) to obtain one.

## Install

```sh
openclaw plugins install git:github.com/coccoinomane/openclaw-plugin-dropbox@v0.1.0
```

Installation may restart a managed OpenClaw Gateway. If mcporter is missing, install it separately; this plugin does not download a private copy.

## Configure

1. Store your Dropbox app key, app secret and refresh token in a private env file. Use [`.env.example`](.env.example) as a template and restrict the file to its owner (`chmod 600`).
2. Add Dropbox to your existing mcporter configuration, with an authorization header that references `${DROPBOX_MCP_TOKEN}`. The [guide includes the entry](docs/guide.md#1-mcporter-config).
3. Merge this entry into your OpenClaw plugin configuration, adjusting both paths:

```json
{
  "plugins": {
    "entries": {
      "dropbox": {
        "enabled": true,
        "config": {
          "mcporterConfig": "~/.openclaw/workspace/config/mcporter.json",
          "envFile": "~/.openclaw/dropbox.env"
        }
      }
    }
  }
}
```

After activation, ask OpenClaw to **check the Dropbox connection** or **find a file in Dropbox**. The skill routes requests through the wrapper. Plain mcporter calls do not gain automatic refresh on their own.

Access tokens are stored in a private cache; the wrapper does not rewrite your env file or mcporter config. File changes and sharing require confirmation through the skill. Grant only the Dropbox scopes you need.

[Setup, CLI commands and troubleshooting →](docs/guide.md)

## Development

```sh
git clone https://github.com/coccoinomane/openclaw-plugin-dropbox.git
cd openclaw-plugin-dropbox
npm test
openclaw plugins install --link .
```

`--link` loads the checkout without copying it. Plugin code changes still require a Gateway restart. Tests use mock services, need no credentials and do not contact Dropbox. See the [development notes](docs/guide.md#development) for package checks and runtime verification.

## License

[MIT](LICENSE)
