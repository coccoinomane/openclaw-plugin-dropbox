#!/usr/bin/env node
// Dropbox wrapper around the external mcporter CLI.
//
// Refreshes the Dropbox OAuth access token when needed (cached, locked across
// processes), then spawns mcporter with the token injected as DROPBOX_MCP_TOKEN
// in the child environment only. Run with --help for usage.
import { main } from "./lib/cli.mjs";

process.exitCode = await main(process.argv.slice(2));
