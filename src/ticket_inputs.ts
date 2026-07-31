import { z } from "zod";
import { GidSchema } from "./asana_contracts.js";

export const TicketIdentifierSchema = z
  .string()
  .trim()
  .min(1, "Ticket identifier is required")
  .describe("An Asana task GID, a Command short ID such as ABC-42, or an Asana task URL");

function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximumDay = daysInMonth[month - 1];
  return maximumDay !== undefined && day >= 1 && day <= maximumDay;
}

export const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD form")
  .refine(isRealCalendarDate, "Expected a real calendar date")
  .describe("A calendar date in YYYY-MM-DD form");

const NonEmptyNameSchema = z.string().trim().min(1, "Name must not be empty");

export const AssigneeIdentifierSchema = z
  .string()
  .trim()
  .refine(
    (value) => GidSchema.safeParse(value).success || z.string().email().safeParse(value).success,
    "Expected a numeric Asana user GID or a valid email address",
  )
  .describe("A numeric Asana user GID or a valid email address");

const LabelNamesSchema = z.array(
  NonEmptyNameSchema.describe("A Teamspace-local label option name"),
);

export const LabelUpdateSchema = z
  .object({
    set: LabelNamesSchema.optional().describe(
      "Replace all labels with these names; an empty set array clears all labels",
    ),
    add: LabelNamesSchema.optional().describe("Add these names to the existing labels"),
    remove: LabelNamesSchema.optional().describe("Remove these names from the existing labels"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.set === undefined && value.add === undefined && value.remove === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one of set, add, or remove must be present",
      });
    }
    if (value.set !== undefined && (value.add !== undefined || value.remove !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "set may not be combined with add or remove",
        path: ["set"],
      });
    }
  })
  .describe(
    "A label update: set replaces all labels, while add and remove modify the existing set; an empty set array clears all labels",
  );

export const UpdateTicketFieldsSchema = z
  .object({
    name: NonEmptyNameSchema.describe("The replacement ticket name").optional(),
    description: z
      .string()
      .describe("The replacement plain-text description; an empty string clears it")
      .optional(),
    completed: z.boolean().describe("Whether the ticket is completed").optional(),
    type: NonEmptyNameSchema.describe("A Teamspace-local ticket type option name").optional(),
    labels: LabelUpdateSchema.optional(),
    assignee: AssigneeIdentifierSchema.nullable()
      .describe("An Asana user GID or email address, or null to clear the assignee")
      .optional(),
    due_on: DateOnlySchema.nullable()
      .describe("The due date in YYYY-MM-DD form, or null to clear the due date")
      .optional(),
    predicted_start_on: DateOnlySchema.nullable()
      .describe("The predicted start date in YYYY-MM-DD form, or null to clear it")
      .optional(),
    predicted_completion_on: DateOnlySchema.nullable()
      .describe("The predicted completion date in YYYY-MM-DD form, or null to clear it")
      .optional(),
  })
  .strict();

export const CreateTicketFieldsSchema = z
  .object({
    name: NonEmptyNameSchema.describe("The ticket name"),
    description: z.string().describe("The initial plain-text description").optional(),
    type: NonEmptyNameSchema.describe("A Teamspace-local ticket type option name").optional(),
    labels: LabelNamesSchema.describe("Initial Teamspace-local label option names").optional(),
    assignee: AssigneeIdentifierSchema.describe(
      "Initial assignee user GID or email address",
    ).optional(),
    due_on: DateOnlySchema.describe("Initial due date in YYYY-MM-DD form").optional(),
    predicted_start_on: DateOnlySchema.describe(
      "Initial predicted start date in YYYY-MM-DD form",
    ).optional(),
    predicted_completion_on: DateOnlySchema.describe(
      "Initial predicted completion date in YYYY-MM-DD form",
    ).optional(),
  })
  .strict();

export const PendingInitializationSchema = z
  .object({
    teamspace_id: GidSchema.describe("Canonical numeric Teamspace project GID"),
    task_gid: GidSchema.describe(
      "GID of the already-created Asana task; this task must not be created again",
    ),
    pending_updates: z
      .object({
        update_ticket: UpdateTicketFieldsSchema.refine(
          (fields) => Object.keys(fields).length > 0,
          "Pending update_ticket fields must not be empty",
        ).describe("Non-empty fields to pass to update_ticket when initialization completes"),
      })
      .strict()
      .describe("The resumable mutation that remains to be applied"),
    retry_with: z.literal("update_ticket").describe("The tool to call to resume initialization"),
  })
  .strict();

export function withTicketId<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).extend({
    ticket_id: TicketIdentifierSchema,
  });
}

export type TicketIdentifier = z.infer<typeof TicketIdentifierSchema>;
export type DateOnly = z.infer<typeof DateOnlySchema>;
export type AssigneeIdentifier = z.infer<typeof AssigneeIdentifierSchema>;
export type LabelUpdate = z.infer<typeof LabelUpdateSchema>;
export type UpdateTicketFields = z.infer<typeof UpdateTicketFieldsSchema>;
export type CreateTicketFields = z.infer<typeof CreateTicketFieldsSchema>;
export type PendingInitialization = z.infer<typeof PendingInitializationSchema>;
