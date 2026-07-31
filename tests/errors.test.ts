import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asCommandError,
  CommandError,
  ErrorCodeSchema,
  ErrorPayloadSchema,
} from "../src/errors.js";

const RETRYABLE_CODES = new Set([
  "rate_limited",
  "request_timeout",
  "tool_timeout",
  "asana_api_error",
]);

const GUIDANCE_CODES = new Set([
  "authentication_failed",
  "permission_denied",
  "schema_ambiguous",
  "schema_incompatible",
  "schema_drift",
  "cursor_invalid",
  "out_of_scope",
  "unknown_release",
  "rate_limited",
  "request_timeout",
  "tool_timeout",
  "invalid_input",
  "asana_api_error",
]);

describe("CommandError", () => {
  it("produces a valid payload for every error code", () => {
    for (const code of ErrorCodeSchema.options) {
      const error = new CommandError(code, `message for ${code}`);
      const payload = error.toPayload();
      expect(ErrorPayloadSchema.parse(payload)).toEqual(payload);
    }
  });

  it("marks retryable codes as retryable", () => {
    for (const code of ErrorCodeSchema.options) {
      const error = new CommandError(code, "retryable check");
      const payload = error.toPayload();
      expect(payload.error.retryable).toBe(RETRYABLE_CODES.has(code));
    }
  });

  it("emits suggested_action for codes with guidance", () => {
    for (const code of ErrorCodeSchema.options) {
      const error = new CommandError(code, "guidance check");
      const payload = error.toPayload();
      if (GUIDANCE_CODES.has(code)) {
        expect(payload.error.suggested_action).toBeTruthy();
        expect(payload.error.suggested_action?.length).toBeGreaterThan(0);
      } else {
        expect(payload.error.suggested_action).toBeUndefined();
      }
    }
  });

  it("omits details and suggested_action when absent", () => {
    const error = new CommandError("not_found", "missing resource");
    const payload = error.toPayload();
    expect(payload.error).not.toHaveProperty("details");
    expect(payload.error).not.toHaveProperty("suggested_action");
  });

  it("includes details when provided", () => {
    const error = new CommandError("invalid_input", "bad field", {
      details: { field: "name" },
    });
    const payload = error.toPayload();
    expect(payload.error.details).toEqual({ field: "name" });
  });

  it("copies asana request IDs from the constructor argument", () => {
    const requestIds = ["req-1", "req-2"];
    const error = new CommandError("asana_api_error", "upstream failure", {
      asanaRequestIds: requestIds,
    });
    requestIds.push("req-3");
    expect(error.asanaRequestIds).toEqual(["req-1", "req-2"]);
    expect(error.toPayload().asana_request_ids).toEqual(["req-1", "req-2"]);
  });
});

describe("asCommandError", () => {
  it("passes CommandError through unchanged", () => {
    const original = new CommandError("permission_denied", "denied");
    expect(asCommandError(original)).toBe(original);
  });

  it("maps Zod errors to schema_drift with issue details", () => {
    const schema = z.object({ name: z.string() });
    let zodError: z.ZodError | undefined;
    try {
      schema.parse({ name: 1 });
    } catch (error) {
      zodError = error as z.ZodError;
    }
    expect(zodError).toBeInstanceOf(z.ZodError);

    const commandError = asCommandError(zodError);
    expect(commandError.code).toBe("schema_drift");
    expect(commandError.details?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["name"],
          code: "invalid_type",
        }),
      ]),
    );
    expect(commandError.cause).toBe(zodError);
  });

  it("maps arbitrary thrown values to asana_api_error without the original message", () => {
    const secretMessage = "Bearer secret-token-value";
    const commandError = asCommandError(new Error(secretMessage));
    expect(commandError.code).toBe("asana_api_error");
    expect(commandError.message).not.toContain(secretMessage);
    expect(commandError.message).not.toContain("Bearer");
  });
});
