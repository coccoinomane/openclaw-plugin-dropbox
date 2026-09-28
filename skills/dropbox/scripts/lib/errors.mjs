import { EXIT } from "./constants.mjs";

/**
 * Error raised by the wrapper itself (as opposed to a failure inside mcporter).
 * The message must never contain a token, secret, or raw upstream response.
 */
export class WrapperError extends Error {
  constructor(message, { exitCode = EXIT.ERROR, hint = undefined, cause = undefined } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "WrapperError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export function configError(message, hint) {
  return new WrapperError(message, { exitCode: EXIT.CONFIG, hint });
}

export function usageError(message, hint) {
  return new WrapperError(message, { exitCode: EXIT.USAGE, hint });
}

export function refreshError(message, hint, cause) {
  return new WrapperError(message, { exitCode: EXIT.REFRESH_FAILED, hint, cause });
}
