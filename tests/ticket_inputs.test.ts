import { describe, expect, it } from "vitest";
import {
  AssigneeIdentifierSchema,
  CreateTicketFieldsSchema,
  DateOnlySchema,
  LabelUpdateSchema,
  PendingInitializationSchema,
  TicketIdentifierSchema,
  UpdateTicketFieldsSchema,
} from "../src/ticket_inputs.js";

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

describe("ticket mutation inputs", () => {
  it("accepts only numeric GIDs or email addresses as assignees", () => {
    expect(AssigneeIdentifierSchema.parse(" 1700000000000001 ")).toBe("1700000000000001");
    expect(AssigneeIdentifierSchema.parse(" Ada@example.com ")).toBe("Ada@example.com");
    expect(AssigneeIdentifierSchema.safeParse("Ada Lovelace").success).toBe(false);
    expect(AssigneeIdentifierSchema.description).toContain("numeric Asana user GID");
    expect(AssigneeIdentifierSchema.description).toContain("email address");
  });

  it("requires one label operation and rejects set combined with incremental changes", () => {
    expect(LabelUpdateSchema.parse({ set: [] })).toEqual({ set: [] });
    expect(LabelUpdateSchema.parse({ add: [" customer "], remove: [] })).toEqual({
      add: ["customer"],
      remove: [],
    });
    expect(LabelUpdateSchema.safeParse({}).success).toBe(false);
    expect(LabelUpdateSchema.safeParse({ set: [], add: ["Customer"] }).success).toBe(false);
    expect(LabelUpdateSchema.safeParse({ add: [""] }).success).toBe(false);
    expect(LabelUpdateSchema.safeParse({ add: ["Customer"], extra: true }).success).toBe(false);
    expect(LabelUpdateSchema.description).toContain("set replaces all labels");
    expect(LabelUpdateSchema.description).toContain("empty set array clears all labels");
  });

  it("supports all update fields and nullable clearing values", () => {
    expect(
      UpdateTicketFieldsSchema.parse({
        name: " Rename ticket ",
        description: "",
        completed: true,
        type: " feature ",
        labels: { add: [" customer "] },
        assignee: null,
        due_on: null,
        predicted_start_on: null,
        predicted_completion_on: null,
      }),
    ).toEqual({
      name: "Rename ticket",
      description: "",
      completed: true,
      type: "feature",
      labels: { add: ["customer"] },
      assignee: null,
      due_on: null,
      predicted_start_on: null,
      predicted_completion_on: null,
    });
    expect(UpdateTicketFieldsSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it("requires create names and never accepts completed", () => {
    expect(
      CreateTicketFieldsSchema.parse({
        name: " New ticket ",
        labels: [" customer "],
      }),
    ).toEqual({ name: "New ticket", labels: ["customer"] });
    expect(CreateTicketFieldsSchema.safeParse({ name: "Ticket", completed: true }).success).toBe(
      false,
    );
  });

  it("requires a canonical, resumable, non-empty pending update", () => {
    const pending = {
      teamspace_id: "1600000000000001",
      task_gid: "1700000000000001",
      pending_updates: { update_ticket: { name: "New ticket" } },
      retry_with: "update_ticket",
    };
    expect(PendingInitializationSchema.parse(pending)).toEqual(pending);
    expect(
      PendingInitializationSchema.safeParse({
        ...pending,
        pending_updates: { update_ticket: {} },
      }).success,
    ).toBe(false);
    expect(
      PendingInitializationSchema.safeParse({ ...pending, task_gid: "create another" }).success,
    ).toBe(false);
  });
});
