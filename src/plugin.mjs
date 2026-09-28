import os from "node:os";
import path from "node:path";

export const PLUGIN_ID = "dropbox";
export const PLUGIN_NAME = "Dropbox";
export const PLUGIN_DESCRIPTION =
  "Dropbox through the external mcporter CLI: a packaged skill plus a wrapper that refreshes the OAuth access token on demand. No model tools are registered.";

// Env vars the plugin may inject into exec environments. All are paths or
// names owned by this plugin; none is a secret.
export const PLUGIN_ENV_KEYS = Object.freeze({
  mcporterBin: "DROPBOX_MCPORTER_BIN",
  mcporterConfig: "DROPBOX_MCPORTER_CONFIG",
  envFile: "DROPBOX_ENV_FILE",
  cacheDir: "DROPBOX_TOKEN_CACHE_DIR",
  serverName: "DROPBOX_MCPORTER_SERVER",
});

export const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mcporterBin: {
      type: "string",
      description: "mcporter executable: a path or a command name found on PATH. Default: mcporter.",
    },
    mcporterConfig: {
      type: "string",
      description: "Path to the shared mcporter config that defines the Dropbox server. The plugin only reads it.",
    },
    envFile: {
      type: "string",
      description: "Optional env file with DROPBOX_APP_KEY, DROPBOX_REFRESH_TOKEN, and related keys.",
    },
    cacheDir: {
      type: "string",
      description: "Directory for the access token cache (created with mode 0700). Default: ~/.cache/openclaw-dropbox.",
    },
    serverName: {
      type: "string",
      description: "mcporter server name for Dropbox. Default: dropbox.",
    },
  },
};

export const uiHints = {
  mcporterBin: { label: "mcporter executable", placeholder: "mcporter" },
  mcporterConfig: { label: "mcporter config path", placeholder: "~/.openclaw/workspace/config/mcporter.json" },
  envFile: { label: "Credentials env file", placeholder: "~/.openclaw/dropbox.env" },
  cacheDir: { label: "Token cache directory", placeholder: "~/.cache/openclaw-dropbox" },
  serverName: { label: "mcporter server name", placeholder: "dropbox" },
};

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Resolve `${VAR}` / `$VAR` references (whole value only) against `env`. */
export function resolveEnvReference(value, env) {
  const raw = cleanString(value);
  if (raw === undefined) return undefined;
  const ref = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(raw) || /^\$([A-Z][A-Z0-9_]*)$/.exec(raw);
  if (ref) return cleanString(env[ref[1]]);
  return raw;
}

export function stateDir(env, homedir = os.homedir()) {
  return cleanString(env.OPENCLAW_STATE_DIR) ?? path.join(homedir, ".openclaw");
}

/**
 * Expand `~` and resolve relative paths against the OpenClaw state directory
 * so the same config works for every user on every machine.
 */
export function resolveConfigPath(value, env, homedir = os.homedir()) {
  const raw = resolveEnvReference(value, env);
  if (raw === undefined) return undefined;
  if (raw === "~") return homedir;
  if (raw.startsWith("~/")) return path.join(homedir, raw.slice(2));
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(stateDir(env, homedir), raw);
}

/**
 * Compute the exec environment contributed by the plugin. Only plugin-owned
 * path/name variables are returned; credentials are never read here, so no
 * secret can reach the shared exec environment through this hook.
 */
export function resolvePluginEnv(config = {}, env = process.env, homedir = os.homedir()) {
  const out = {};
  const bin = resolveEnvReference(config.mcporterBin, env);
  if (bin) {
    // A bare command name stays a name; a path is expanded like the others.
    out[PLUGIN_ENV_KEYS.mcporterBin] = bin.includes("/") || bin.includes("\\") || bin.startsWith("~") ? resolveConfigPath(bin, env, homedir) : bin;
  }
  const mcporterConfig = resolveConfigPath(config.mcporterConfig, env, homedir);
  if (mcporterConfig) out[PLUGIN_ENV_KEYS.mcporterConfig] = mcporterConfig;
  const envFile = resolveConfigPath(config.envFile, env, homedir);
  if (envFile) out[PLUGIN_ENV_KEYS.envFile] = envFile;
  const cacheDir = resolveConfigPath(config.cacheDir, env, homedir);
  if (cacheDir) out[PLUGIN_ENV_KEYS.cacheDir] = cacheDir;
  const serverName = resolveEnvReference(config.serverName, env);
  if (serverName && /^[A-Za-z0-9._-]+$/.test(serverName)) out[PLUGIN_ENV_KEYS.serverName] = serverName;
  return out;
}

/** The object handed to definePluginEntry in index.js. */
export function createPluginDefinition() {
  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    configSchema,
    register(api) {
      api.on(
        "resolve_exec_env",
        async () => resolvePluginEnv(api.pluginConfig ?? {}, process.env),
        { priority: 20 },
      );
    },
  };
}
