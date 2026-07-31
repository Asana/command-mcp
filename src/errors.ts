import { ZodError, z } from "zod";

export const ErrorCodeSchema = z.enum([
  "authentication_failed",
  "payment_required",
  "permission_denied",
  "not_found",
  "required_api_change_unavailable",
  "invalid_teamspace",
  "schema_ambiguous",
  "schema_incompatible",
  "schema_drift",
  "cursor_invalid",
  "out_of_scope",
  "unknown_release",
  "rate_limited",
  "request_timeout",
  "tool_timeout",
  "invalid_configuration",
  "invalid_input",
  "asana_api_error",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorPayloadSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    suggested_action: z.string().optional(),
    details: z.record(z.unknown()).optional(),
  }),
  asana_request_ids: z.array(z.string()),
});

export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

type ErrorMeta = {
  retryable: boolean;
  suggested_action?: string;
};

const ERROR_META: Record<ErrorCode, ErrorMeta> = {
  authentication_failed: {
    retryable: false,
    suggested_action: "replace or restore access for the configured Asana Personal Access Token",
  },
  payment_required: { retryable: false },
  permission_denied: {
    retryable: false,
    suggested_action: "verify that the configured Asana identity can access this resource",
  },
  not_found: { retryable: false },
  required_api_change_unavailable: { retryable: false },
  invalid_teamspace: { retryable: false },
  schema_ambiguous: {
    retryable: false,
    suggested_action: "run doctor and correct the Teamspace schema before retrying",
  },
  schema_incompatible: {
    retryable: false,
    suggested_action: "run doctor and correct the Teamspace schema before retrying",
  },
  schema_drift: {
    retryable: false,
    suggested_action: "run doctor and correct the Teamspace schema before retrying",
  },
  cursor_invalid: {
    retryable: false,
    suggested_action: "restart pagination without a cursor and keep the same filters and limit",
  },
  out_of_scope: {
    retryable: false,
    suggested_action: "use get_context and provide a ticket from the selected Teamspace",
  },
  unknown_release: {
    retryable: false,
    suggested_action: "call list_teamspace_releases and use a returned Release name or GID",
  },
  rate_limited: {
    retryable: true,
    suggested_action: "wait before retrying the same operation",
  },
  request_timeout: {
    retryable: true,
    suggested_action:
      "for a mutation read the authoritative current state before deciding whether to retry",
  },
  tool_timeout: {
    retryable: true,
    suggested_action:
      "for a mutation read the authoritative current state before deciding whether to retry",
  },
  invalid_configuration: { retryable: false },
  invalid_input: {
    retryable: false,
    suggested_action: "correct the input using the tool schema",
  },
  asana_api_error: {
    retryable: true,
    suggested_action: "inspect the details and Asana request IDs then retry only if safe",
  },
};

export class CommandError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly asanaRequestIds: string[];

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      details?: Record<string, unknown>;
      asanaRequestIds?: string[];
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "CommandError";
    this.code = code;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
    this.asanaRequestIds = [...(options?.asanaRequestIds ?? [])];
  }

  toPayload(): ErrorPayload {
    const meta = ERROR_META[this.code];
    const error: ErrorPayload["error"] = {
      code: this.code,
      message: this.message,
      retryable: meta.retryable,
    };
    if (meta.suggested_action !== undefined) {
      error.suggested_action = meta.suggested_action;
    }
    if (this.details !== undefined) {
      error.details = this.details;
    }
    return {
      error,
      asana_request_ids: [...this.asanaRequestIds],
    };
  }
}

const GENERIC_ASANA_API_ERROR_MESSAGE =
  "An unexpected error occurred while communicating with Asana";

export function asCommandError(value: unknown): CommandError {
  if (value instanceof CommandError) {
    return value;
  }
  if (value instanceof ZodError) {
    return new CommandError("schema_drift", "Schema validation failed", {
      details: {
        issues: value.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
        })),
      },
      cause: value,
    });
  }
  return new CommandError("asana_api_error", GENERIC_ASANA_API_ERROR_MESSAGE);
}
