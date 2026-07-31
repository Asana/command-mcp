import { describe, expect, it } from "vitest";
import { DateOnlySchema, TicketIdentifierSchema } from "../src/ticket_inputs.js";

describe("TicketIdentifierSchema", () => {
  it("trims accepted identifiers and describes every supported form", () => {
    expect(TicketIdentifierSchema.parse("  CMD_2-42  ")).toBe("CMD_2-42");
    expect(TicketIdentifierSchema.description).toContain("Asana task GID");
    expect(TicketIdentifierSchema.description).toContain("Command short ID");
    expect(TicketIdentifierSchema.description).toContain("Asana task URL");
  });

  it("rejects an empty identifier", () => {
    expect(TicketIdentifierSchema.safeParse("   ").success).toBe(false);
  });
});

describe("DateOnlySchema", () => {
  it.each(["2026-01-01", "2024-02-29"])("accepts the real calendar date %s", (value) => {
    expect(DateOnlySchema.parse(value)).toBe(value);
  });

  it.each(["2026-02-30", "2025-02-29", "2026-13-01", "2026-01-1", "not-a-date"])(
    "rejects the invalid date %s",
    (value) => {
      expect(DateOnlySchema.safeParse(value).success).toBe(false);
    },
  );
});
