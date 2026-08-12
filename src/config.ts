import { z } from "zod";
import { CommandError } from "./errors.js";
import type { StoredOAuthCredentials } from "./oauth_credentials.js";

export const DEFAULT_SCAN_BOUND = 1000;
export const MAX_SCAN_BOUND = 10000;
export const DEFAULT_CREATE_TIMEOUT_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

const AsanaAuthenticationSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
});

const ConfigSchema = z.object({
  authentication: AsanaAuthenticationSchema,
  readOnly: z.boolean(),
  maxScanTasks: z.number().int().positive().max(MAX_SCAN_BOUND),
  createTimeoutMs: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  toolTimeoutMs: z.number().int().positive(),
});

export type AsanaAuthentication = z.infer<typeof AsanaAuthenticationSchema>;
export type Config = z.infer<typeof ConfigSchema>;

function invalidConfig(variableName: string): never {
  throw new CommandError("invalid_configuration", `Invalid value for ${variableName}`);
}

export type LoadConfigOptions = {
  readonly oauthCredentials?: StoredOAuthCredentials | null;
};

function loadAuthentication(options: LoadConfigOptions): AsanaAuthentication {
  const oauthCredentials = options.oauthCredentials;
  if (oauthCredentials !== undefined && oauthCredentials !== null) {
    return {
      clientId: oauthCredentials.clientId,
      clientSecret: oauthCredentials.clientSecret,
      refreshToken: oauthCredentials.refreshToken,
    };
  }

  throw new CommandError(
    "invalid_configuration",
    "Asana OAuth login is missing; run asana-command-mcp auth login",
  );
}

function parseBoolean(value: string | undefined, variableName: string): boolean {
  if (value === undefined || value === "") {
    return false;
  }
  const normalized = value.toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  invalidConfig(variableName);
}

function parsePositiveInteger(
  value: string | undefined,
  variableName: string,
  defaultValue: number,
): number {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  if (!/^[0-9]+$/.test(value)) {
    invalidConfig(variableName);
  }
  const parsed = Number(value);
  if (parsed === 0 || !Number.isSafeInteger(parsed)) {
    invalidConfig(variableName);
  }
  return parsed;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): Config {
  const authentication = loadAuthentication(options);

  const readOnly = parseBoolean(env.ASANA_READ_ONLY, "ASANA_READ_ONLY");

  const maxScanTasks = Math.min(
    parsePositiveInteger(env.ASANA_MAX_SCAN_TASKS, "ASANA_MAX_SCAN_TASKS", DEFAULT_SCAN_BOUND),
    MAX_SCAN_BOUND,
  );

  const createTimeoutMs =
    parsePositiveInteger(
      env.ASANA_CREATE_TIMEOUT_SECONDS,
      "ASANA_CREATE_TIMEOUT_SECONDS",
      DEFAULT_CREATE_TIMEOUT_MS / 1000,
    ) * 1000;

  const requestTimeoutMs = parsePositiveInteger(
    env.ASANA_REQUEST_TIMEOUT_MS,
    "ASANA_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
  );

  const toolTimeoutMs = parsePositiveInteger(
    env.ASANA_TOOL_TIMEOUT_MS,
    "ASANA_TOOL_TIMEOUT_MS",
    DEFAULT_TOOL_TIMEOUT_MS,
  );

  return ConfigSchema.parse({
    authentication,
    readOnly,
    maxScanTasks,
    createTimeoutMs,
    requestTimeoutMs,
    toolTimeoutMs,
  });
}
