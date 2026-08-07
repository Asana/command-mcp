import { describe, expect, it } from "vitest";
import {
  DEFAULT_CREATE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SCAN_BOUND,
  DEFAULT_TOOL_TIMEOUT_MS,
  loadConfig,
  MAX_SCAN_BOUND,
} from "../src/config.js";
import { CommandError } from "../src/errors.js";
import type { StoredOAuthCredentials } from "../src/oauth_credentials.js";

const OAUTH_CREDENTIALS: StoredOAuthCredentials = {
  version: 1,
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
};

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

function loadAuthenticatedConfig(overrides: Record<string, string | undefined> = {}) {
  return loadConfig(env(overrides), { oauthCredentials: OAUTH_CREDENTIALS });
}

describe("loadConfig", () => {
  it("requires OAuth login when no keychain credentials are available", () => {
    expect(() => loadConfig(env({}))).toThrowError(/auth login/);
  });

  it("does not accept a legacy access token as authentication", () => {
    expect(() => loadConfig(env({ ASANA_ACCESS_TOKEN: "legacy-token" }))).toThrowError(
      /auth login/,
    );
  });

  it("always uses stored OAuth credentials when a legacy access-token variable exists", () => {
    const config = loadAuthenticatedConfig({ ASANA_ACCESS_TOKEN: "legacy-token" });

    expect(config.authentication).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });
  });

  it("accepts OAuth credentials loaded from the operating system keychain", () => {
    const config = loadAuthenticatedConfig();

    expect(config.authentication).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });
  });

  it("fails for unparseable booleans", () => {
    expect(() => loadAuthenticatedConfig({ ASANA_READ_ONLY: "maybe" })).toThrow(CommandError);
  });

  it("fails for unparseable or non-positive integers", () => {
    const cases = [
      { ASANA_MAX_SCAN_TASKS: "0" },
      { ASANA_MAX_SCAN_TASKS: "-1" },
      { ASANA_MAX_SCAN_TASKS: "1.5" },
      { ASANA_MAX_SCAN_TASKS: " 100" },
      { ASANA_MAX_SCAN_TASKS: "1e3" },
      { ASANA_REQUEST_TIMEOUT_MS: "abc" },
    ] as const;

    for (const overrides of cases) {
      expect(() => loadAuthenticatedConfig(overrides)).toThrow(CommandError);
    }
  });

  it("applies defaults when optional variables are unset", () => {
    const config = loadAuthenticatedConfig();
    expect(config).toEqual({
      authentication: {
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      readOnly: false,
      maxScanTasks: DEFAULT_SCAN_BOUND,
      createTimeoutMs: DEFAULT_CREATE_TIMEOUT_MS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    });
  });

  it("converts create timeout seconds to milliseconds", () => {
    const config = loadAuthenticatedConfig({ ASANA_CREATE_TIMEOUT_SECONDS: "45" });
    expect(config.createTimeoutMs).toBe(45_000);
  });

  it("clamps scan bound above the hard maximum", () => {
    const config = loadAuthenticatedConfig({
      ASANA_MAX_SCAN_TASKS: String(MAX_SCAN_BOUND + 500),
    });
    expect(config.maxScanTasks).toBe(MAX_SCAN_BOUND);
  });

  it("accepts valid boolean and integer overrides", () => {
    const config = loadAuthenticatedConfig({
      ASANA_READ_ONLY: "TRUE",
      ASANA_MAX_SCAN_TASKS: "2500",
      ASANA_REQUEST_TIMEOUT_MS: "15000",
      ASANA_TOOL_TIMEOUT_MS: "90000",
    });
    expect(config.readOnly).toBe(true);
    expect(config.maxScanTasks).toBe(2500);
    expect(config.requestTimeoutMs).toBe(15_000);
    expect(config.toolTimeoutMs).toBe(90_000);
  });
});
