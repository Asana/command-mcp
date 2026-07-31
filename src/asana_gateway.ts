import {
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
import type { z } from "zod";
import { collectionEnvelope, singleObjectEnvelope } from "./asana_contracts.js";
import type { Config } from "./config.js";
import { CommandError } from "./errors.js";

export const INCLUDE_ASANA_CREATED_CUSTOM_TYPES = "include_asana_created_custom_types";

const ASANA_ENABLE_HEADER = "Asana-Enable";
const MAX_RETRY_ATTEMPTS = 3;
const MAX_RETRY_AFTER_SECONDS = 60;
const MAX_UPSTREAM_MESSAGE_LENGTH = 500;
const RETRY_JITTER_MS = 250;

const REQUEST_ID_HEADERS = ["x-asana-request-id", "asana-request-id", "x-request-id"] as const;

const OPT_IN_HEADER_MESSAGE_MARKERS = [
  "asana-enable",
  "asana_enable",
  INCLUDE_ASANA_CREATED_CUSTOM_TYPES,
] as const;

export type AsanaResourceBundle = {
  tasks: TasksApi;
  projects: ProjectsApi;
  stories: StoriesApi;
  attachments: AttachmentsApi;
  customFieldSettings: CustomFieldSettingsApi;
  customTypes: CustomTypesApi;
  typeahead: TypeaheadApi;
  workspaces: WorkspacesApi;
};

export type AsanaHttpResult = {
  response: {
    headers?: Record<string, string | string[] | undefined>;
  };
  data: unknown;
};

export type AsanaRequestOptions = {
  deadlineMs: number;
};

export type AsanaRequestTrace = {
  readonly requestIds: string[];
};

type ClientFactory = (options: { accessToken: string; timeoutMs: number }) => ApiClient;

type ResourceFactory = (client: ApiClient) => AsanaResourceBundle;

type SleepFn = (ms: number) => Promise<void>;

type RandomSource = () => number;

type Clock = () => number;

export type AsanaRequestExecutorOptions = {
  clientFactory?: ClientFactory;
  resourceFactory?: ResourceFactory;
  sleep?: SleepFn;
  random?: RandomSource;
  clock?: Clock;
  maxRetryAttempts?: number;
};

function defaultClientFactory(options: { accessToken: string; timeoutMs: number }): ApiClient {
  const client = new ApiClient();
  client.RETURN_COLLECTION = false;
  const tokenAuth = client.authentications.token;
  if (tokenAuth === undefined) {
    throw new CommandError(
      "invalid_configuration",
      "The Asana SDK client is missing token authentication",
    );
  }
  tokenAuth.accessToken = options.accessToken;
  client.defaultHeaders[ASANA_ENABLE_HEADER] = INCLUDE_ASANA_CREATED_CUSTOM_TYPES;
  client.timeout = options.timeoutMs;
  return client;
}

function defaultResourceFactory(client: ApiClient): AsanaResourceBundle {
  return {
    tasks: new TasksApi(client),
    projects: new ProjectsApi(client),
    stories: new StoriesApi(client),
    attachments: new AttachmentsApi(client),
    customFieldSettings: new CustomFieldSettingsApi(client),
    customTypes: new CustomTypesApi(client),
    typeahead: new TypeaheadApi(client),
    workspaces: new WorkspacesApi(client),
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultRandom(): number {
  return Math.random();
}

function defaultClock(): number {
  return Date.now();
}

function remainingBudgetMs(deadlineMs: number, nowMs: number): number {
  return deadlineMs - nowMs;
}

function assertBudget(deadlineMs: number, nowMs: number): number {
  const remaining = remainingBudgetMs(deadlineMs, nowMs);
  if (remaining <= 0) {
    throw new CommandError("tool_timeout", "The tool deadline expired before the request started");
  }
  return remaining;
}

function sanitizeUpstreamMessage(message: string, accessToken: string): string {
  let sanitized = message;
  if (accessToken.length > 0) {
    sanitized = sanitized.split(accessToken).join("[REDACTED]");
  }
  sanitized = sanitized.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  if (sanitized.length > MAX_UPSTREAM_MESSAGE_LENGTH) {
    return sanitized.slice(0, MAX_UPSTREAM_MESSAGE_LENGTH);
  }
  return sanitized;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name];
  if (typeof direct === "string") {
    return direct;
  }
  if (Array.isArray(direct) && direct.length > 0) {
    return direct[0];
  }

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value) && value.length > 0) {
      return value[0];
    }
  }

  return undefined;
}

function collectRequestId(
  headers: Record<string, string | string[] | undefined> | undefined,
  trace: AsanaRequestTrace,
): void {
  if (headers === undefined) {
    return;
  }

  for (const headerName of REQUEST_ID_HEADERS) {
    const value = headerValue(headers, headerName);
    if (value !== undefined && value.length > 0 && !trace.requestIds.includes(value)) {
      trace.requestIds.push(value);
    }
  }
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as {
    timeout?: boolean;
    code?: string;
  };

  return (
    candidate.timeout === true ||
    candidate.code === "ETIMEDOUT" ||
    candidate.code === "ECONNABORTED"
  );
}

function upstreamMessage(error: unknown, accessToken: string): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const response = (error as { response?: { body?: unknown; text?: string } }).response;
  if (response === undefined) {
    return undefined;
  }

  const body = response.body;
  if (typeof body === "object" && body !== null) {
    const errors = (body as { errors?: Array<{ message?: string }> }).errors;
    if (Array.isArray(errors)) {
      const messages = errors
        .map((entry) => entry.message)
        .filter((message): message is string => typeof message === "string" && message.length > 0);
      if (messages.length > 0) {
        return sanitizeUpstreamMessage(messages.join("; "), accessToken);
      }
    }
  }

  if (typeof response.text === "string" && response.text.length > 0) {
    return sanitizeUpstreamMessage(response.text, accessToken);
  }

  return undefined;
}

function refersToOptInHeader(message: string | undefined): boolean {
  if (message === undefined) {
    return false;
  }
  const normalized = message.toLowerCase();
  return OPT_IN_HEADER_MESSAGE_MARKERS.some((marker) => normalized.includes(marker));
}

function retryAfterSeconds(error: unknown, nowMs: number): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const headers = (
    error as { response?: { headers?: Record<string, string | string[] | undefined> } }
  ).response?.headers;
  if (headers === undefined) {
    return undefined;
  }

  const raw = headerValue(headers, "retry-after");
  if (raw === undefined) {
    return undefined;
  }

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric;
  }

  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) {
    return undefined;
  }

  const seconds = Math.ceil((retryAt - nowMs) / 1000);
  return seconds >= 0 ? seconds : undefined;
}

function mergeCommandErrorRequestIds(error: CommandError, trace: AsanaRequestTrace): CommandError {
  const mergedIds = [...error.asanaRequestIds];
  for (const requestId of trace.requestIds) {
    if (!mergedIds.includes(requestId)) {
      mergedIds.push(requestId);
    }
  }
  if (
    mergedIds.length === error.asanaRequestIds.length &&
    mergedIds.every((requestId, index) => requestId === error.asanaRequestIds[index])
  ) {
    return error;
  }
  return new CommandError(error.code, error.message, {
    ...(error.details === undefined ? {} : { details: error.details }),
    asanaRequestIds: mergedIds,
    cause: error.cause,
  });
}

function normalizeUpstreamError(
  error: unknown,
  accessToken: string,
  trace: AsanaRequestTrace,
  nowMs: number,
): CommandError {
  if (error instanceof CommandError) {
    return mergeCommandErrorRequestIds(error, trace);
  }

  if (typeof error === "object" && error !== null) {
    const response = (
      error as { response?: { headers?: Record<string, string | string[] | undefined> } }
    ).response;
    collectRequestId(response?.headers, trace);
  }

  if (isTimeoutError(error)) {
    return new CommandError("request_timeout", "The Asana request timed out", {
      asanaRequestIds: [...trace.requestIds],
      cause: error,
    });
  }

  const status =
    typeof error === "object" && error !== null ? (error as { status?: number }).status : undefined;
  const message = upstreamMessage(error, accessToken);

  const retryAfter = status === 429 ? retryAfterSeconds(error, nowMs) : undefined;
  const rateLimitDetails =
    retryAfter === undefined ? undefined : { retry_after_seconds: retryAfter };

  switch (status) {
    case 401:
      return new CommandError("authentication_failed", message ?? "Asana authentication failed", {
        asanaRequestIds: [...trace.requestIds],
        cause: error,
      });
    case 402:
      return new CommandError("payment_required", message ?? "Asana payment is required", {
        asanaRequestIds: [...trace.requestIds],
        cause: error,
      });
    case 403:
      return new CommandError(
        "permission_denied",
        message ?? "Asana denied permission for this request",
        {
          asanaRequestIds: [...trace.requestIds],
          cause: error,
        },
      );
    case 404:
      return new CommandError(
        "not_found",
        message ?? "The requested Asana resource was not found",
        {
          asanaRequestIds: [...trace.requestIds],
          cause: error,
        },
      );
    case 429:
      return new CommandError("rate_limited", message ?? "Asana rate limited this request", {
        ...(rateLimitDetails === undefined ? {} : { details: rateLimitDetails }),
        asanaRequestIds: [...trace.requestIds],
        cause: error,
      });
    default: {
      if (refersToOptInHeader(message)) {
        return new CommandError(
          "required_api_change_unavailable",
          "Asana requires an API opt-in header that is not enabled",
          {
            asanaRequestIds: [...trace.requestIds],
            cause: error,
          },
        );
      }

      const apiErrorOptions: {
        details?: Record<string, unknown>;
        asanaRequestIds: string[];
        cause: unknown;
      } = {
        asanaRequestIds: [...trace.requestIds],
        cause: error,
      };
      if (status !== undefined) {
        apiErrorOptions.details = { status };
      }
      return new CommandError(
        "asana_api_error",
        message ??
          (status === undefined
            ? "An unexpected Asana API error occurred"
            : `Asana API error (${status})`),
        apiErrorOptions,
      );
    }
  }
}

function decodeSchemaDrift(error: z.ZodError, trace: AsanaRequestTrace): CommandError {
  return new CommandError("schema_drift", "Asana response did not match the expected schema", {
    details: {
      issues: error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
      })),
    },
    asanaRequestIds: [...trace.requestIds],
    cause: error,
  });
}

export class AsanaRequestExecutor {
  private readonly config: Config;
  private readonly clientFactory: ClientFactory;
  private readonly resourceFactory: ResourceFactory;
  private readonly sleep: SleepFn;
  private readonly random: RandomSource;
  private readonly clock: Clock;
  private readonly maxRetryAttempts: number;

  constructor(config: Config, options: AsanaRequestExecutorOptions = {}) {
    this.config = config;
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.resourceFactory = options.resourceFactory ?? defaultResourceFactory;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? defaultRandom;
    this.clock = options.clock ?? defaultClock;
    this.maxRetryAttempts = options.maxRetryAttempts ?? MAX_RETRY_ATTEMPTS;
  }

  createTrace(): AsanaRequestTrace {
    return { requestIds: [] };
  }

  async read<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    options: AsanaRequestOptions,
    callback: (resources: AsanaResourceBundle) => Promise<AsanaHttpResult>,
    trace: AsanaRequestTrace = this.createTrace(),
  ): Promise<z.infer<TSchema>> {
    const envelope = singleObjectEnvelope(schema);
    const result = await this.executeWithRetry(options, trace, callback);
    try {
      const parsed = envelope.parse(result.data);
      return parsed.data;
    } catch (error) {
      if (error instanceof CommandError) {
        throw error;
      }
      if (error && typeof error === "object" && "issues" in error) {
        throw decodeSchemaDrift(error as z.ZodError, trace);
      }
      throw error;
    }
  }

  async write<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    options: AsanaRequestOptions,
    callback: (resources: AsanaResourceBundle) => Promise<AsanaHttpResult>,
    trace: AsanaRequestTrace = this.createTrace(),
  ): Promise<z.infer<TSchema>> {
    const envelope = singleObjectEnvelope(schema);
    const result = await this.executeOnce(options, trace, callback);
    try {
      const parsed = envelope.parse(result.data);
      return parsed.data;
    } catch (error) {
      if (error instanceof CommandError) {
        throw error;
      }
      if (error && typeof error === "object" && "issues" in error) {
        throw decodeSchemaDrift(error as z.ZodError, trace);
      }
      throw error;
    }
  }

  async readPage<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    options: AsanaRequestOptions,
    callback: (resources: AsanaResourceBundle) => Promise<AsanaHttpResult>,
    trace: AsanaRequestTrace = this.createTrace(),
  ): Promise<{ items: z.infer<TSchema>[]; nextPageOffset: string | null }> {
    const envelope = collectionEnvelope(schema);
    const result = await this.executeWithRetry(options, trace, callback);
    try {
      const parsed = envelope.parse(result.data);
      return {
        items: parsed.data,
        nextPageOffset: parsed.next_page?.offset ?? null,
      };
    } catch (error) {
      if (error instanceof CommandError) {
        throw error;
      }
      if (error && typeof error === "object" && "issues" in error) {
        throw decodeSchemaDrift(error as z.ZodError, trace);
      }
      throw error;
    }
  }

  private async executeWithRetry(
    options: AsanaRequestOptions,
    trace: AsanaRequestTrace,
    callback: (resources: AsanaResourceBundle) => Promise<AsanaHttpResult>,
  ): Promise<AsanaHttpResult> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        return await this.invokeRequest(options, trace, callback);
      } catch (error) {
        if (attempt >= this.maxRetryAttempts) {
          throw normalizeUpstreamError(error, this.config.accessToken, trace, this.clock());
        }

        const status =
          typeof error === "object" && error !== null
            ? (error as { status?: number }).status
            : undefined;
        const retryAfter = status === 429 ? retryAfterSeconds(error, this.clock()) : undefined;
        if (retryAfter === undefined || retryAfter > MAX_RETRY_AFTER_SECONDS) {
          throw normalizeUpstreamError(error, this.config.accessToken, trace, this.clock());
        }

        const delayMs = retryAfter * 1000 + Math.floor(this.random() * RETRY_JITTER_MS);
        const remaining = remainingBudgetMs(options.deadlineMs, this.clock());
        if (delayMs >= remaining) {
          throw new CommandError(
            "tool_timeout",
            "The tool deadline expired before a retry could run",
            {
              asanaRequestIds: [...trace.requestIds],
            },
          );
        }

        await this.sleep(delayMs);
      }
    }
  }

  private async executeOnce(
    options: AsanaRequestOptions,
    trace: AsanaRequestTrace,
    callback: (resources: AsanaResourceBundle) => Promise<AsanaHttpResult>,
  ): Promise<AsanaHttpResult> {
    try {
      return await this.invokeRequest(options, trace, callback);
    } catch (error) {
      throw normalizeUpstreamError(error, this.config.accessToken, trace, this.clock());
    }
  }

  private async invokeRequest(
    options: AsanaRequestOptions,
    trace: AsanaRequestTrace,
    callback: (resources: AsanaResourceBundle) => Promise<AsanaHttpResult>,
  ): Promise<AsanaHttpResult> {
    const nowMs = this.clock();
    const remaining = assertBudget(options.deadlineMs, nowMs);
    const timeoutMs = Math.min(this.config.requestTimeoutMs, remaining);
    const client = this.clientFactory({
      accessToken: this.config.accessToken,
      timeoutMs,
    });
    const resources = this.resourceFactory(client);

    try {
      const result = await callback(resources);
      collectRequestId(result.response.headers, trace);
      return result;
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        const response = (
          error as { response?: { headers?: Record<string, string | string[] | undefined> } }
        ).response;
        collectRequestId(response?.headers, trace);
      }
      throw error;
    }
  }
}

export type AsanaRequestExecutorPort = Pick<
  AsanaRequestExecutor,
  "read" | "write" | "readPage" | "createTrace"
>;
