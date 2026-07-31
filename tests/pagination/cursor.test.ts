import { describe, expect, it } from "vitest";
import type { CommandError } from "../../src/errors.js";
import { createCursorCodec } from "../../src/pagination/cursor.js";

type ListBinding = {
  filters: Record<string, string>;
  limit: number;
};

function createTestCodec(version: string | number = 1) {
  return createCursorCodec<ListBinding>({
    version,
    canonicalizeBinding: (binding) => ({
      filters: Object.fromEntries(
        Object.entries(binding.filters).sort(([left], [right]) => left.localeCompare(right)),
      ),
      limit: binding.limit,
    }),
    invalidMessage: "The pagination cursor is invalid. Restart without a cursor.",
  });
}

describe("createCursorCodec", () => {
  const binding: ListBinding = {
    filters: { status: "open", team: "core" },
    limit: 25,
  };

  it("round-trips the offset under the same binding", () => {
    const codec = createTestCodec();
    const cursor = codec.encode("offset-42", binding);
    const decoded = codec.decode(cursor, binding);

    expect(decoded.offset).toBe("offset-42");
  });

  it("rejects a cursor issued under a different filter set", () => {
    const codec = createTestCodec();
    const cursor = codec.encode("offset-1", binding);

    expect(() =>
      codec.decode(cursor, {
        ...binding,
        filters: { ...binding.filters, status: "closed" },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "cursor_invalid",
        message: "The pagination cursor is invalid. Restart without a cursor.",
      } satisfies Partial<CommandError>),
    );
  });

  it("rejects a cursor issued for a different page size", () => {
    const codec = createTestCodec();
    const cursor = codec.encode("offset-1", binding);

    expect(() => codec.decode(cursor, { ...binding, limit: 50 })).toThrowError(
      expect.objectContaining({ code: "cursor_invalid" } satisfies Partial<CommandError>),
    );
  });

  it("invalidates existing cursors when the schema version changes", () => {
    const issued = createTestCodec(1).encode("offset-1", binding);

    expect(() => createTestCodec(2).decode(issued, binding)).toThrowError(
      expect.objectContaining({ code: "cursor_invalid" } satisfies Partial<CommandError>),
    );
  });

  it("rejects malformed and truncated cursor input", () => {
    const codec = createTestCodec();

    expect(() => codec.decode("%%%", binding)).toThrowError(
      expect.objectContaining({ code: "cursor_invalid" } satisfies Partial<CommandError>),
    );

    const truncated = codec.encode("offset-1", binding).slice(0, 8);
    expect(() => codec.decode(truncated, binding)).toThrowError(
      expect.objectContaining({ code: "cursor_invalid" } satisfies Partial<CommandError>),
    );
  });

  it("decodes an envelope containing only version, offset, and fingerprint", () => {
    const codec = createTestCodec();
    const decoded = codec.decode(codec.encode(99, binding), binding);

    expect(decoded).toEqual({
      version: 1,
      offset: 99,
      fingerprint: decoded.fingerprint,
    });
    expect(Object.keys(decoded).sort()).toEqual(["fingerprint", "offset", "version"]);
    expect(decoded).not.toHaveProperty("filters");
    expect(decoded).not.toHaveProperty("limit");
  });
});
