// Registers a module resolution hook that maps the OpenClaw SDK entry helper
// import to a local stub, so index.js can be loaded without the host package.
import { register } from "node:module";

register("./sdk-stub-hooks.mjs", import.meta.url);
