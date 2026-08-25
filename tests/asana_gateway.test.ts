import type {
  ApiClient,
  AttachmentsApi,
  CustomFieldSettingsApi,
  CustomTypesApi,
  ProjectsApi,
  StoriesApi,
  TasksApi,
  TypeaheadApi,
  WorkspacesApi,
} from "asana";
import { ApiClient as AsanaApiClient } from "asana";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GidSchema } from "../src/asana_contracts.js";
import {
  type AsanaHttpResult,
  AsanaRequestExecutor,
  type AsanaRequestExecutorOptions,
  type AsanaResourceBundle,
  INCLUDE_ASANA_CREATED_CUSTOM_TYPES,
} from "../src/asana_gateway.js";
import { type Config, DEFAULT_REQUEST_TIMEOUT_MS } from "../src/config.js";
import { CommandError } from "../src/errors.js";

const ACCESS_TOKEN = "0123456789012345678901234567890";
const NOW_MS = 1_000_000;
const GidResourceSchema = z.object({ gid: GidSchema });

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    authentication: {
      type: "oauth",
      clientId: "oauth-client-id",
      clientSecret: "oauth-client-secret",
      refreshToken: "oauth-refresh-token",
    },
    readOnly: false,
    maxScanTasks: 1000,
    createTimeoutMs: 30_000,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    toolTimeoutMs: 120_000,
    ...overrides,
  };
}

function deadlineAfter(budgetMs: number, nowMs = NOW_MS): number {
  return nowMs + budgetMs;
}

function buildFakeApiClient(options: { accessToken: string; timeoutMs: number }): ApiClient {
  const client = new AsanaApiClient();
  client.RETURN_COLLECTION = false;
  const tokenAuth = client.authentications.token;
  if (tokenAuth === undefined) {
    throw new Error("Expected token authentication on the Asana SDK client");
  }
  tokenAuth.accessToken = options.accessToken;
  client.defaultHeaders["Asana-Enable"] = INCLUDE_ASANA_CREATED_CUSTOM_TYPES;
  client.timeout = options.timeoutMs;
  return client;
}

function testExecutorOptions(
  overrides: {
    clock?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    maxRetryAttempts?: number;
    fetch?: typeof globalThis.fetch;
    clientFactory?: (options: { accessToken: string; timeoutMs: number }) => ApiClient;
    resourceFactory?: (client: ApiClient) => AsanaResourceBundle;
  } = {},
): AsanaRequestExecutorOptions {
  const options: AsanaRequestExecutorOptions = {
    clock: overrides.clock ?? (() => NOW_MS),
    fetch:
      overrides.fetch ??
      (async () =>
        new Response(
          JSON.stringify({
            access_token: ACCESS_TOKEN,
            expires_in: 3600,
            token_type: "bearer",
          }),
          { status: 200 },
        )),
    clientFactory: overrides.clientFactory ?? buildFakeApiClient,
    resourceFactory: overrides.resourceFactory ?? (() => createResourceBundle()),
  };

  if (overrides.sleep !== undefined) {
    options.sleep = overrides.sleep;
  }
  if (overrides.random !== undefined) {
    options.random = overrides.random;
  }
  if (overrides.maxRetryAttempts !== undefined) {
    options.maxRetryAttempts = overrides.maxRetryAttempts;
  }

  return options;
}

function unusedMethod(name: string): never {
  throw new Error(`Unexpected call to ${name}`);
}

function createThrowingApi<T extends object>(apiName: string): T {
  const target = { apiClient: {} };
  return new Proxy(target, {
    get(object, property, receiver) {
      if (property === "apiClient") {
        return Reflect.get(object, property, receiver);
      }
      if (property === "then") {
        return undefined;
      }
      return (..._args: unknown[]) => unusedMethod(`${apiName}.${String(property)}`);
    },
  }) as T;
}

function createResourceBundle(): AsanaResourceBundle {
  return {
    tasks: createThrowingApi<TasksApi>("tasks"),
    projects: createThrowingApi<ProjectsApi>("projects"),
    stories: createThrowingApi<StoriesApi>("stories"),
    attachments: createThrowingApi<AttachmentsApi>("attachments"),
    customFieldSettings: createThrowingApi<CustomFieldSettingsApi>("customFieldSettings"),
    customTypes: createThrowingApi<CustomTypesApi>("customTypes"),
    typeahead: createThrowingApi<TypeaheadApi>("typeahead"),
    workspaces: createThrowingApi<WorkspacesApi>("workspaces"),
  };
}

function superagentError(options: {
  status?: number;
  message?: string;
  headers?: Record<string, string>;
  body?: unknown;
  text?: string;
  code?: string;
  timeout?: boolean;
}): Error & {
  status?: number;
  response?: { headers?: Record<string, string>; body?: unknown; text?: string };
  code?: string;
  timeout?: boolean;
} {
  const error = new Error(options.message ?? "upstream failure") as Error & {
    status?: number;
    response?: { headers?: Record<string, string>; body?: unknown; text?: string };
    code?: string;
    timeout?: boolean;
  };
  if (options.status !== undefined) {
    error.status = options.status;
  }
  if (options.code !== undefined) {
    error.code = options.code;
  }
  if (options.timeout !== undefined) {
    error.timeout = options.timeout;
  }
  if (options.headers !== undefined || options.body !== undefined || options.text !== undefined) {
    error.response = {};
    if (options.headers !== undefined) {
      error.response.headers = options.headers;
    }
    if (options.body !== undefined) {
      error.response.body = options.body;
    }
    if (options.text !== undefined) {
      error.response.text = options.text;
    }
  }
  return error;
}

describe("AsanaRequestExecutor", () => {
  it("uses a personal access token directly without an OAuth exchange", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const clientFactory = vi.fn(buildFakeApiClient);
    const executor = new AsanaRequestExecutor(
      testConfig({ authentication: { type: "pat", accessToken: "personal-access-token" } }),
      testExecutorOptions({ fetch, clientFactory }),
    );

    await executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(5_000) }, async () => ({
      response: { headers: {} },
      data: { data: { gid: "1" } },
    }));

    expect(fetch).not.toHaveBeenCalled();
    expect(clientFactory).toHaveBeenCalledWith({
      accessToken: "personal-access-token",
      timeoutMs: 5_000,
    });
  });

  it("exchanges an OAuth refresh token and sends the resulting bearer token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "oauth-access-token",
            expires_in: 3600,
            token_type: "bearer",
          }),
          { status: 200 },
        ),
    );
    const clientFactory = vi.fn(buildFakeApiClient);
    const executor = new AsanaRequestExecutor(testConfig(), {
      clock: () => NOW_MS,
      fetch,
      clientFactory,
      resourceFactory: () => createResourceBundle(),
    });

    await executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(5_000) }, async () => ({
      response: { headers: {} },
      data: { data: { gid: "1" } },
    }));

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://app.asana.com/-/oauth_token");
    expect(init).toMatchObject({ method: "POST" });
    expect(init?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(String(init?.body)).toBe(
      "grant_type=refresh_token&refresh_token=oauth-refresh-token&client_id=oauth-client-id&client_secret=oauth-client-secret",
    );
    expect(clientFactory).toHaveBeenCalledWith({
      accessToken: "oauth-access-token",
      timeoutMs: 5_000,
    });
  });

  it("reuses a valid OAuth access token and refreshes it before expiry", async () => {
    let nowMs = NOW_MS;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "oauth-access-token-1",
            expires_in: 3600,
            token_type: "bearer",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "oauth-access-token-2",
            expires_in: 3600,
            token_type: "bearer",
          }),
          { status: 200 },
        ),
      );
    const clientFactory = vi.fn(buildFakeApiClient);
    const executor = new AsanaRequestExecutor(testConfig(), {
      clock: () => nowMs,
      fetch,
      clientFactory,
      resourceFactory: () => createResourceBundle(),
    });
    const callback = async () => ({
      response: { headers: {} },
      data: { data: { gid: "1" } },
    });

    await executor.read(GidResourceSchema, { deadlineMs: nowMs + 5_000 }, callback);
    nowMs += 1_000;
    await executor.read(GidResourceSchema, { deadlineMs: nowMs + 5_000 }, callback);
    nowMs += 3_540_000;
    await executor.read(GidResourceSchema, { deadlineMs: nowMs + 5_000 }, callback);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(clientFactory.mock.calls.map(([options]) => options.accessToken)).toEqual([
      "oauth-access-token-1",
      "oauth-access-token-1",
      "oauth-access-token-2",
    ]);
  });

  it("persists a rotated OAuth refresh token before using it", async () => {
    const persistOAuthRefreshToken = vi.fn(async () => undefined);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "oauth-access-token",
            expires_in: 3600,
            token_type: "bearer",
            refresh_token: "rotated-refresh-token",
          }),
          { status: 200 },
        ),
    );
    const executor = new AsanaRequestExecutor(testConfig(), {
      clock: () => NOW_MS,
      fetch,
      persistOAuthRefreshToken,
      clientFactory: buildFakeApiClient,
      resourceFactory: () => createResourceBundle(),
    });

    await executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(5_000) }, async () => ({
      response: { headers: {} },
      data: { data: { gid: "1" } },
    }));

    expect(persistOAuthRefreshToken).toHaveBeenCalledWith("rotated-refresh-token");
  });

  it("maps a rejected OAuth refresh without exposing credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "oauth-refresh-token was rejected",
          }),
          { status: 400, headers: { "x-asana-request-id": "oauth-request-id" } },
        ),
    );
    const executor = new AsanaRequestExecutor(testConfig(), {
      clock: () => NOW_MS,
      fetch,
    });

    await expect(
      executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(5_000) }, async () => ({
        response: { headers: {} },
        data: { data: { gid: "1" } },
      })),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CommandError);
      const commandError = error as CommandError;
      expect(commandError.code).toBe("authentication_failed");
      expect(commandError.asanaRequestIds).toEqual(["oauth-request-id"]);
      expect(commandError.message).not.toContain("oauth-refresh-token");
      expect(commandError.message).not.toContain("oauth-client-secret");
      return true;
    });
  });

  it("fails closed when an OAuth token response is malformed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ access_token: "oauth-access-token", token_type: "bearer" }), {
          status: 200,
        }),
    );
    const executor = new AsanaRequestExecutor(testConfig(), {
      clock: () => NOW_MS,
      fetch,
    });

    await expect(
      executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(5_000) }, async () => ({
        response: { headers: {} },
        data: { data: { gid: "1" } },
      })),
    ).rejects.toMatchObject({ code: "schema_drift" });
  });

  it("maps an OAuth refresh timeout before invoking the SDK", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const error = new Error("oauth-client-secret timed out");
      error.name = "TimeoutError";
      throw error;
    });
    const callback = vi.fn(async (): Promise<AsanaHttpResult> => unusedMethod("callback"));
    const executor = new AsanaRequestExecutor(testConfig(), {
      clock: () => NOW_MS,
      fetch,
    });

    await expect(
      executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(5_000) }, callback),
    ).rejects.toMatchObject({
      code: "request_timeout",
      message: "The Asana OAuth token refresh timed out",
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it("redacts a refreshed OAuth access token from SDK errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "oauth-access-token",
            expires_in: 3600,
            token_type: "bearer",
          }),
          { status: 200 },
        ),
    );
    const executor = new AsanaRequestExecutor(testConfig(), {
      clock: () => NOW_MS,
      fetch,
      clientFactory: buildFakeApiClient,
      resourceFactory: () => createResourceBundle(),
    });

    await expect(
      executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(5_000) }, async () => {
        throw superagentError({
          status: 500,
          body: { errors: [{ message: "Token oauth-access-token was rejected" }] },
        });
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CommandError);
      const commandError = error as CommandError;
      expect(commandError.message).not.toContain("oauth-access-token");
      expect(commandError.message).toContain("[REDACTED]");
      return true;
    });
  });

  it("throws tool_timeout without invoking the SDK when the deadline is already exhausted", async () => {
    const callback = vi.fn(async (): Promise<AsanaHttpResult> => unusedMethod("callback"));
    const executor = new AsanaRequestExecutor(
      testConfig(),
      testExecutorOptions({ clock: () => 2_000 }),
    );

    await expect(
      executor.read(GidResourceSchema, { deadlineMs: 1_000 }, callback),
    ).rejects.toMatchObject({
      code: "tool_timeout",
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it("sets the per-request timeout to the smaller of the configured timeout and remaining budget", async () => {
    const createdClients: ApiClient[] = [];
    const executor = new AsanaRequestExecutor(
      testConfig({ requestTimeoutMs: 20_000 }),
      testExecutorOptions({
        clock: () => NOW_MS,
        clientFactory: ({ timeoutMs }) => {
          const client = buildFakeApiClient({ accessToken: ACCESS_TOKEN, timeoutMs });
          createdClients.push(client);
          return client;
        },
      }),
    );

    await executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(5_000) }, async () => ({
      response: { headers: {} },
      data: { data: { gid: "1" } },
    }));

    expect(createdClients).toHaveLength(1);
    expect(createdClients[0]?.timeout).toBe(5_000);
  });

  it("sends the Asana custom-type opt-in header on every request", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const executor = new AsanaRequestExecutor(
      testConfig(),
      testExecutorOptions({
        clock: () => NOW_MS,
        resourceFactory: (client) => {
          capturedHeaders = client.defaultHeaders;
          return createResourceBundle();
        },
      }),
    );

    await executor.write(GidResourceSchema, { deadlineMs: deadlineAfter(5_000) }, async () => ({
      response: { headers: {} },
      data: { data: { gid: "2" } },
    }));

    expect(capturedHeaders?.["Asana-Enable"]).toBe(INCLUDE_ASANA_CREATED_CUSTOM_TYPES);
  });

  it("retries a rate-limited read twice after the initial failure (3 total attempts) when Retry-After is acceptable and stops at the attempt limit", async () => {
    const sleep = vi.fn(async () => {});
    const callback = vi
      .fn()
      .mockRejectedValueOnce(
        superagentError({
          status: 429,
          headers: { "retry-after": "1" },
          body: { errors: [{ message: "Rate limited" }] },
        }),
      )
      .mockRejectedValueOnce(
        superagentError({
          status: 429,
          headers: { "retry-after": "1" },
          body: { errors: [{ message: "Rate limited again" }] },
        }),
      )
      .mockResolvedValueOnce({
        response: { headers: { "x-asana-request-id": "req-success" } },
        data: { data: { gid: "3" } },
      });

    const executor = new AsanaRequestExecutor(
      testConfig(),
      testExecutorOptions({
        sleep,
        random: () => 0,
      }),
    );

    const trace = executor.createTrace();
    const result = await executor.read(
      GidResourceSchema,
      { deadlineMs: deadlineAfter(10_000) },
      callback,
      trace,
    );
    expect(result).toEqual({ gid: "3" });
    expect(callback).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(trace.requestIds).toEqual(["req-success"]);
  });

  it("throws tool_timeout instead of sleeping when a retry would cross the deadline", async () => {
    const sleep = vi.fn(async () => {});
    const callback = vi.fn().mockRejectedValue(
      superagentError({
        status: 429,
        headers: { "retry-after": "5" },
        body: { errors: [{ message: "Rate limited" }] },
      }),
    );
    let now = NOW_MS;
    const executor = new AsanaRequestExecutor(
      testConfig(),
      testExecutorOptions({
        clock: () => now,
        sleep: async (ms) => {
          now += ms;
          await sleep();
        },
        random: () => 0,
        maxRetryAttempts: 5,
      }),
    );

    await expect(
      executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(4_000, now) }, callback),
    ).rejects.toMatchObject({
      code: "tool_timeout",
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never retries a write", async () => {
    const sleep = vi.fn(async () => {});
    const callback = vi.fn().mockRejectedValue(
      superagentError({
        status: 429,
        headers: { "retry-after": "1" },
        body: { errors: [{ message: "Rate limited" }] },
      }),
    );
    const executor = new AsanaRequestExecutor(
      testConfig(),
      testExecutorOptions({
        sleep,
        random: () => 0,
        maxRetryAttempts: 5,
      }),
    );

    await expect(
      executor.write(GidResourceSchema, { deadlineMs: deadlineAfter(10_000) }, callback),
    ).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    [401, "authentication_failed"],
    [402, "payment_required"],
    [403, "permission_denied"],
    [404, "not_found"],
    [429, "rate_limited"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const executor = new AsanaRequestExecutor(testConfig(), testExecutorOptions());

    await expect(
      executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(10_000) }, async () => {
        throw superagentError(
          status === 429
            ? {
                status,
                body: { errors: [{ message: `status ${status}` }] },
                headers: { "retry-after": "120" },
              }
            : {
                status,
                body: { errors: [{ message: `status ${status}` }] },
              },
        );
      }),
    ).rejects.toMatchObject({ code });
  });

  it("redacts the configured access token and bearer patterns from upstream messages", async () => {
    const personalAccessToken = "personal-access-token";
    const executor = new AsanaRequestExecutor(
      testConfig({ authentication: { type: "pat", accessToken: personalAccessToken } }),
      testExecutorOptions(),
    );

    await expect(
      executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(10_000) }, async () => {
        throw superagentError({
          status: 500,
          body: {
            errors: [
              {
                message: `Token ${personalAccessToken} and Bearer abc.def.ghi were rejected`,
              },
            ],
          },
        });
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CommandError);
      const commandError = error as CommandError;
      expect(commandError.message).not.toContain(personalAccessToken);
      expect(commandError.message).not.toContain("abc.def.ghi");
      expect(commandError.message).toContain("[REDACTED]");
      return true;
    });
  });

  it("maps HTTP 401 to authentication_failed even when the body mentions the opt-in header", async () => {
    const executor = new AsanaRequestExecutor(testConfig(), testExecutorOptions());

    await expect(
      executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(10_000) }, async () => {
        throw superagentError({
          status: 401,
          body: {
            errors: [{ message: "Missing Asana-Enable: include_asana_created_custom_types" }],
          },
        });
      }),
    ).rejects.toMatchObject({
      code: "authentication_failed",
    });
  });

  it("does not surface transport error messages that only appear on the thrown error", async () => {
    const executor = new AsanaRequestExecutor(testConfig(), testExecutorOptions());
    const secretUrl = `https://app.asana.com/api/1.0/tasks?access_token=${ACCESS_TOKEN}`;

    await expect(
      executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(10_000) }, async () => {
        throw superagentError({
          status: 500,
          message: `connect failed for ${secretUrl}`,
        });
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CommandError);
      const commandError = error as CommandError;
      expect(commandError.message).toBe("Asana API error (500)");
      expect(commandError.message).not.toContain(ACCESS_TOKEN);
      expect(commandError.message).not.toContain(secretUrl);
      return true;
    });
  });

  it("parses HTTP-date Retry-After values using the injected clock", async () => {
    const sleep = vi.fn(async () => {});
    const callback = vi
      .fn()
      .mockRejectedValueOnce(
        superagentError({
          status: 429,
          headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" },
          body: { errors: [{ message: "Rate limited" }] },
        }),
      )
      .mockResolvedValueOnce({
        response: { headers: {} },
        data: { data: { gid: "9" } },
      });
    const retryAtMs = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    const nowMs = retryAtMs - 2_000;

    const executor = new AsanaRequestExecutor(
      testConfig(),
      testExecutorOptions({
        clock: () => nowMs,
        sleep,
        random: () => 0,
      }),
    );

    await executor.read(GidResourceSchema, { deadlineMs: nowMs + 10_000 }, callback);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("maps opt-in header failures to required_api_change_unavailable", async () => {
    const executor = new AsanaRequestExecutor(testConfig(), testExecutorOptions());

    await expect(
      executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(10_000) }, async () => {
        throw superagentError({
          status: 400,
          body: {
            errors: [{ message: "Missing Asana-Enable: include_asana_created_custom_types" }],
          },
        });
      }),
    ).rejects.toMatchObject({
      code: "required_api_change_unavailable",
    });
  });

  it("maps timeout markers to request_timeout", async () => {
    const executor = new AsanaRequestExecutor(testConfig(), testExecutorOptions());

    await expect(
      executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(10_000) }, async () => {
        throw superagentError({ code: "ETIMEDOUT" });
      }),
    ).rejects.toMatchObject({
      code: "request_timeout",
    });
  });

  it("throws schema_drift with issue paths, collected request IDs, and without raw values on decode failure", async () => {
    const executor = new AsanaRequestExecutor(testConfig(), testExecutorOptions());

    const secretValue = "super-secret-ticket-content";
    await expect(
      executor.read(
        z.object({ gid: GidSchema, name: z.string() }),
        { deadlineMs: deadlineAfter(10_000) },
        async () => ({
          response: { headers: { "x-asana-request-id": "req-drift" } },
          data: { data: { gid: "4", name: 123, secret: secretValue } },
        }),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CommandError);
      const commandError = error as CommandError;
      expect(commandError.code).toBe("schema_drift");
      expect(commandError.asanaRequestIds).toEqual(["req-drift"]);
      expect(commandError.details?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["data", "name"],
            code: "invalid_type",
          }),
        ]),
      );
      expect(JSON.stringify(commandError.details)).not.toContain(secretValue);
      expect(commandError.message).not.toContain(secretValue);
      return true;
    });
  });

  it("collects request IDs from accepted header spellings, deduplicates them, and preserves them on failure", async () => {
    const executor = new AsanaRequestExecutor(testConfig(), testExecutorOptions());

    const successTrace = executor.createTrace();
    await executor.read(
      GidResourceSchema,
      { deadlineMs: deadlineAfter(10_000) },
      async () => ({
        response: {
          headers: {
            "x-asana-request-id": "req-1",
            "Asana-Request-Id": "req-1",
            "x-request-id": "req-2",
          },
        },
        data: { data: { gid: "5" } },
      }),
      successTrace,
    );
    expect(successTrace.requestIds).toEqual(["req-1", "req-2"]);

    const failureTrace = executor.createTrace();
    await expect(
      executor.read(
        GidResourceSchema,
        { deadlineMs: deadlineAfter(10_000) },
        async () => {
          throw superagentError({
            status: 500,
            headers: { "asana-request-id": "req-3" },
            body: { errors: [{ message: "failed" }] },
          });
        },
        failureTrace,
      ),
    ).rejects.toMatchObject({
      code: "asana_api_error",
      asanaRequestIds: ["req-3"],
    });
    expect(failureTrace.requestIds).toEqual(["req-3"]);
  });

  it("returns collection items and the next page offset from readPage", async () => {
    const executor = new AsanaRequestExecutor(testConfig(), testExecutorOptions());

    const page = await executor.readPage(
      GidResourceSchema,
      { deadlineMs: deadlineAfter(10_000) },
      async () => ({
        response: { headers: {} },
        data: {
          data: [{ gid: "6" }, { gid: "7" }],
          next_page: { offset: "next-offset", path: "/tasks", uri: "https://example.test/tasks" },
        },
      }),
    );

    expect(page.items).toEqual([{ gid: "6" }, { gid: "7" }]);
    expect(page.nextPageOffset).toBe("next-offset");
  });

  it("decodes single-object envelopes through read and write", async () => {
    const executor = new AsanaRequestExecutor(testConfig(), testExecutorOptions());

    const payload = { data: { gid: "8" } };
    await expect(
      executor.read(GidResourceSchema, { deadlineMs: deadlineAfter(10_000) }, async () => ({
        response: { headers: {} },
        data: payload,
      })),
    ).resolves.toEqual({ gid: "8" });
  });
});
