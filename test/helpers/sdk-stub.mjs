// Minimal stand-in for openclaw/plugin-sdk/plugin-entry, mirroring the shape
// of the real helper: it returns the definition with a lazy configSchema.
export function definePluginEntry({ id, name, description, configSchema = { type: "object", additionalProperties: false }, register }) {
  if (!id || !name || !description || typeof register !== "function") {
    throw new Error("definePluginEntry stub: id, name, description, and register are required");
  }
  return {
    id,
    name,
    description,
    get configSchema() {
      return typeof configSchema === "function" ? configSchema() : configSchema;
    },
    register,
    __stub: true,
  };
}
