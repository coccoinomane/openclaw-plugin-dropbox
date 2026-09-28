import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const HELPERS_DIR = path.join(REPO_ROOT, "test", "helpers");
export const SKILL_DIR = path.join(REPO_ROOT, "skills", "dropbox");
export const SCRIPT_PATH = path.join(SKILL_DIR, "scripts", "dropbox-mcporter.mjs");
export const LIB_DIR = path.join(SKILL_DIR, "scripts", "lib");
export const FAKE_MCPORTER_DIR = path.join(HELPERS_DIR, "fake-bin");
export const FETCH_REDIRECT_PRELOAD = path.join(HELPERS_DIR, "fetch-redirect.mjs");
