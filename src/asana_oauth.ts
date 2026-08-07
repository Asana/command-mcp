import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { CommandError } from "./errors.js";
import type { OAuthCredentialStore } from "./oauth_credentials.js";

export const ASANA_OAUTH_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

const ASANA_OAUTH_AUTHORIZE_URL = "https://app.asana.com/-/oauth_authorize";
const ASANA_OAUTH_TOKEN_URL = "https://app.asana.com/-/oauth_token";
const OAUTH_REQUEST_TIMEOUT_MS = 20_000;
const MAX_AUTHORIZATION_INPUT_LENGTH = 64 * 1024;
const MAX_OAUTH_RESPONSE_LENGTH = 64 * 1024;
const REQUEST_ID_HEADERS = ["x-asana-request-id", "asana-request-id", "x-request-id"] as const;

const AuthorizationTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  refresh_token: z.string().min(1),
});

export type AsanaOAuthLoginConfig = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
};

type OutputWriter = {
  write(data: string): unknown;
};

export type AsanaOAuthLoginOptions = {
  readonly app: AsanaOAuthLoginConfig;
  readonly credentialStore: OAuthCredentialStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly openBrowser?: (authorizationUrl: string) => Promise<boolean>;
  readonly readAuthorizationResponse?: (authorizationUrl: string) => Promise<string>;
  readonly stdout?: OutputWriter;
  readonly stderr?: OutputWriter;
};

function requiredTrimmedEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    throw new CommandError("invalid_configuration", `Invalid value for ${name}`);
  }
  return value;
}

export function loadAsanaOAuthLoginConfig(env: NodeJS.ProcessEnv): AsanaOAuthLoginConfig {
  const rawScopes = env.ASANA_OAUTH_SCOPES?.trim();
  return {
    clientId: requiredTrimmedEnv(env, "ASANA_OAUTH_CLIENT_ID"),
    clientSecret: requiredTrimmedEnv(env, "ASANA_OAUTH_CLIENT_SECRET"),
    scopes: rawScopes === undefined || rawScopes === "" ? [] : rawScopes.split(/\s+/),
  };
}

function createAuthorizationUrl(
  app: AsanaOAuthLoginConfig,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(ASANA_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", ASANA_OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", codeChallenge);
  if (app.scopes.length > 0) {
    url.searchParams.set("scope", app.scopes.join(" "));
  }
  return url.toString();
}

function equalState(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function requestIds(headers: Headers): string[] {
  const values: string[] = [];
  for (const header of REQUEST_ID_HEADERS) {
    const value = headers.get(header);
    if (value !== null && value !== "" && !values.includes(value)) {
      values.push(value);
    }
  }
  return values;
}

function authorizationCodeFromInput(value: string, expectedState: string): string {
  const input = value.trim();
  if (input === "" || input.length > MAX_AUTHORIZATION_INPUT_LENGTH) {
    throw new CommandError(
      "invalid_input",
      "Paste the Asana OAuth authorization code or complete redirect URI",
    );
  }

  if (!input.startsWith(`${ASANA_OAUTH_REDIRECT_URI}?`)) {
    return input;
  }

  const redirect = new URL(input);
  if (`${redirect.protocol}${redirect.pathname}` !== ASANA_OAUTH_REDIRECT_URI) {
    throw new CommandError(
      "invalid_input",
      "Paste the Asana OAuth authorization code or complete redirect URI",
    );
  }

  const oauthError = redirect.searchParams.get("error");
  if (oauthError !== null) {
    throw new CommandError("authentication_failed", "Asana OAuth authorization was not granted", {
      details: { oauth_error: oauthError },
    });
  }

  const state = redirect.searchParams.get("state");
  if (state === null || !equalState(state, expectedState)) {
    throw new CommandError("authentication_failed", "Asana OAuth state verification failed");
  }

  const code = redirect.searchParams.get("code");
  if (code === null || code === "") {
    throw new CommandError(
      "authentication_failed",
      "Asana OAuth did not return an authorization code",
    );
  }
  return code;
}

async function defaultOpenBrowser(authorizationUrl: string): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [authorizationUrl] }
      : process.platform === "win32"
        ? {
            executable: "rundll32",
            args: ["url.dll,FileProtocolHandler", authorizationUrl],
          }
        : { executable: "xdg-open", args: [authorizationUrl] };

  return await new Promise((resolve) => {
    const child = spawn(command.executable, command.args, { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

async function defaultReadAuthorizationResponse(): Promise<string> {
  const input = createInterface({ input: process.stdin });
  try {
    return await input.question("");
  } finally {
    input.close();
  }
}

async function exchangeAuthorizationCode(
  app: AsanaOAuthLoginConfig,
  code: string,
  verifier: string,
  fetch: typeof globalThis.fetch,
): Promise<z.infer<typeof AuthorizationTokenResponseSchema>> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", app.clientId);
  body.set("client_secret", app.clientSecret);
  body.set("redirect_uri", ASANA_OAUTH_REDIRECT_URI);
  body.set("code", code);
  body.set("code_verifier", verifier);

  let response: Response;
  try {
    response = await fetch(ASANA_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const isTimeout =
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      ((error as { name?: unknown }).name === "AbortError" ||
        (error as { name?: unknown }).name === "TimeoutError");
    throw new CommandError(
      isTimeout ? "request_timeout" : "asana_api_error",
      isTimeout
        ? "The Asana OAuth code exchange timed out"
        : "The Asana OAuth code exchange failed",
      { cause: error },
    );
  }

  const asanaRequestIds = requestIds(response.headers);
  if (!response.ok) {
    const details = { status: response.status };
    if (response.status === 400 || response.status === 401) {
      throw new CommandError(
        "authentication_failed",
        "Asana rejected the OAuth authorization code or client credentials",
        { details, asanaRequestIds },
      );
    }
    if (response.status === 403) {
      throw new CommandError("permission_denied", "Asana denied the OAuth code exchange", {
        details,
        asanaRequestIds,
      });
    }
    if (response.status === 429) {
      throw new CommandError("rate_limited", "Asana rate limited the OAuth code exchange", {
        asanaRequestIds,
      });
    }
    throw new CommandError("asana_api_error", "The Asana OAuth code exchange failed", {
      details,
      asanaRequestIds,
    });
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    throw new CommandError("asana_api_error", "The Asana OAuth code exchange failed", {
      asanaRequestIds,
      cause: error,
    });
  }
  if (responseText.length > MAX_OAUTH_RESPONSE_LENGTH) {
    throw new CommandError("schema_drift", "The Asana OAuth token response was too large", {
      asanaRequestIds,
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    throw new CommandError("schema_drift", "The Asana OAuth token response was not valid JSON", {
      asanaRequestIds,
      cause: error,
    });
  }
  const parsed = AuthorizationTokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CommandError("schema_drift", "The Asana OAuth token response was invalid", {
      details: {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
      },
      asanaRequestIds,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export async function runAsanaOAuthLogin(options: AsanaOAuthLoginOptions): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const authorizationUrl = createAuthorizationUrl(options.app, state, challenge);
  const opened = await (options.openBrowser ?? defaultOpenBrowser)(authorizationUrl);

  stderr.write(
    opened
      ? "Asana authorization opened in your browser.\n"
      : "Could not open a browser automatically. Open this URL manually.\n",
  );
  stderr.write(`${authorizationUrl}\n`);
  stderr.write(
    "After authorizing, paste the one-time code shown by Asana (or the complete redirected URI) here:\n",
  );

  const authorizationResponse = await (
    options.readAuthorizationResponse ?? defaultReadAuthorizationResponse
  )(authorizationUrl);
  const code = authorizationCodeFromInput(authorizationResponse, state);
  const token = await exchangeAuthorizationCode(
    options.app,
    code,
    verifier,
    options.fetch ?? globalThis.fetch,
  );
  await options.credentialStore.save({
    version: 1,
    clientId: options.app.clientId,
    clientSecret: options.app.clientSecret,
    refreshToken: token.refresh_token,
  });
  stdout.write(
    `Asana OAuth login completed. Credentials saved to ${options.credentialStore.location}\n`,
  );
}
