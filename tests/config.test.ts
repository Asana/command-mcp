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

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

describe("loadConfig", () => {
  it("fails when the access token is missing", () => {
    expect(() => loadConfig(env({}))).toThrow(CommandError);
    try {
      loadConfig(env({}));
    } catch (error) {
      const commandError = error as CommandError;
      expect(commandError.code).toBe("invalid_configuration");
      expect(commandError.message).toContain("ASANA_ACCESS_TOKEN");
    }
  });

  it("fails when the access token is blank", () => {
    expect(() => loadConfig(env({ ASANA_ACCESS_TOKEN: "   " }))).toThrow(CommandError);
  });

  it("never includes the token value in thrown errors", () => {
    const secretToken = "super-secret-pat-value-12345";
    try {
      loadConfig(
        env({
          ASANA_ACCESS_TOKEN: secretToken,
          ASANA_READ_ONLY: "maybe",
        }),
      );
      expect.unreachable("expected invalid_configuration");
    } catch (error) {
      const commandError = error as CommandError;
      expect(commandError.message).not.toContain(secretToken);
    }
  });

  it("fails for unparseable booleans", () => {
    expect(() =>
      loadConfig(
        env({
          ASANA_ACCESS_TOKEN: "token",
          ASANA_READ_ONLY: "maybe",
        }),
      ),
    ).toThrow(CommandError);
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
      expect(() =>
        loadConfig(
          env({
            ASANA_ACCESS_TOKEN: "token",
            ...overrides,
          }),
        ),
      ).toThrow(CommandError);
    }
  });

  it("applies defaults when optional variables are unset", () => {
    const config = loadConfig(env({ ASANA_ACCESS_TOKEN: "token" }));
    expect(config).toEqual({
      accessToken: "token",
      readOnly: false,
      maxScanTasks: DEFAULT_SCAN_BOUND,
      createTimeoutMs: DEFAULT_CREATE_TIMEOUT_MS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    });
  });

  it("converts create timeout seconds to milliseconds", () => {
    const config = loadConfig(
      env({
        ASANA_ACCESS_TOKEN: "token",
        ASANA_CREATE_TIMEOUT_SECONDS: "45",
      }),
    );
    expect(config.createTimeoutMs).toBe(45_000);
  });

  it("clamps scan bound above the hard maximum", () => {
    const config = loadConfig(
      env({
        ASANA_ACCESS_TOKEN: "token",
        ASANA_MAX_SCAN_TASKS: String(MAX_SCAN_BOUND + 500),
      }),
    );
    expect(config.maxScanTasks).toBe(MAX_SCAN_BOUND);
  });

  it("accepts valid boolean and integer overrides", () => {
    const config = loadConfig(
      env({
        ASANA_ACCESS_TOKEN: "  token-value  ",
        ASANA_READ_ONLY: "TRUE",
        ASANA_MAX_SCAN_TASKS: "2500",
        ASANA_REQUEST_TIMEOUT_MS: "15000",
        ASANA_TOOL_TIMEOUT_MS: "90000",
      }),
    );
    expect(config.accessToken).toBe("token-value");
    expect(config.readOnly).toBe(true);
    expect(config.maxScanTasks).toBe(2500);
    expect(config.requestTimeoutMs).toBe(15_000);
    expect(config.toolTimeoutMs).toBe(90_000);
  });
});
