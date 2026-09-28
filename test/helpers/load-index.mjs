// Loads the plugin entry through the stubbed SDK and prints a summary.
import { pathToFileURL } from "node:url";

const entry = (await import(pathToFileURL(process.argv[2]).href)).default;
const calls = [];
entry.register({
  pluginConfig: { mcporterConfig: "~/cfg.json" },
  on(name, handler, options) {
    calls.push({ name, options, hasHandler: typeof handler === "function" });
  },
});
process.stdout.write(
  JSON.stringify({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    schemaType: entry.configSchema?.type,
    stub: entry.__stub === true,
    calls,
  }),
);
