import { CommandError } from "./errors.js";

export const DEFAULT_SCAN_BOUND = 1000;
export const MAX_SCAN_BOUND = 10000;
export const DEFAULT_CREATE_TIMEOUT_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export type Config = {
  accessToken: string;
  readOnly: boolean;
  maxScanTasks: number;
  createTimeoutMs: number;
  requestTimeoutMs: number;
  toolTimeoutMs: number;
};

function invalidConfig(variableName: string): never {
  throw new CommandError("invalid_configuration", `Invalid value for ${variableName}`);
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawToken = env.ASANA_ACCESS_TOKEN;
  if (rawToken === undefined || rawToken.trim() === "") {
    invalidConfig("ASANA_ACCESS_TOKEN");
  }
  const accessToken = rawToken.trim();

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

  return {
    accessToken,
    readOnly,
    maxScanTasks,
    createTimeoutMs,
    requestTimeoutMs,
    toolTimeoutMs,
  };
}
