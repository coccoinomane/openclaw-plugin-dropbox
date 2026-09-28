# Dropbox for OpenClaw

Use Dropbox through a CLI without filling your model's context window with Dropbox tool definitions.

Instead of registering the full Dropbox tool catalog with the model, this plugin lets the agent run CLI commands and request command details when needed. Only a short skill description is advertised upfront; the agent loads the instructions when a task calls for Dropbox. This leaves more context available for your conversation and work.

The CLI uses [mcporter](https://mcporter.dev) under the hood, reusing your existing installation and configuration. A small wrapper refreshes the OAuth access token when needed, before calling Dropbox. No cron job or background service is required.

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
