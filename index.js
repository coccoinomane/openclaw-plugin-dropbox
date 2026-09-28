import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { createPluginDefinition } from "./src/plugin.mjs";

export default definePluginEntry(createPluginDefinition());
