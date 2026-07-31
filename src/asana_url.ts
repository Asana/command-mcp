import { CommandError } from "./errors.js";

const ASANA_APP_HOST = "app.asana.com";

export type AsanaAppUrl = {
  url: URL;
  pathname: string;
};

function invalidAsanaUrl(message: string, details?: Record<string, unknown>): never {
  throw new CommandError("invalid_input", message, {
    ...(details === undefined ? {} : { details }),
  });
}

/**
 * Parse a string as an Asana app URL. Returns null when the input is not a URL at
 * all so callers can try other identifier forms. Throws invalid_input when the
 * input parses as a URL but fails Asana scheme, host, port, or credential checks.
 */
export function tryParseAsanaAppUrl(input: string): AsanaAppUrl | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") {
    invalidAsanaUrl("Asana app URLs must use the https scheme", {
      issues: [{ path: ["scheme"], message: "expected https" }],
    });
  }

  if (url.hostname !== ASANA_APP_HOST) {
    invalidAsanaUrl("Asana app URLs must use the app.asana.com host", {
      issues: [{ path: ["hostname"], message: `expected ${ASANA_APP_HOST}` }],
    });
  }

  if (url.port.length > 0) {
    invalidAsanaUrl("Asana app URLs must not include an explicit port", {
      issues: [{ path: ["port"], message: "port is not allowed" }],
    });
  }

  if (url.username.length > 0 || url.password.length > 0) {
    invalidAsanaUrl("Asana app URLs must not include credentials", {
      issues: [{ path: ["credentials"], message: "username and password are not allowed" }],
    });
  }

  return { url, pathname: url.pathname };
}
