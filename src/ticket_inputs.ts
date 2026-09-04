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

export const RICH_TEXT_WRITER_RULES =
  'Must be well-formed XML with a single root <body>...</body>. Only <a> may carry attributes (e.g. <a data-asana-gid="123"/> to @-mention an accessible object by GID); attributes on any other element are invalid. Elements outside the allowed list are rejected.';

const TICKET_DESCRIPTION_HTML_DESCRIPTION = [
  "HTML-formatted description; mutually exclusive with description. Use this for rich formatting or @-mentions.",
  `Allowed elements: <body>, <strong>, <em>, <u>, <s>, <code>, <ol>, <ul>, <li>, <a>, <blockquote>, <pre>, <h1>, <h2>, <hr/>, <img>. ${RICH_TEXT_WRITER_RULES}`,
].join(" ");

export const AssigneeIdentifierSchema = z
  .string()
  .trim()
  .refine(
    (value) => GidSchema.safeParse(value).success || z.string().email().safeParse(value).success,
    "Expected a numeric Asana user GID or a valid email address",
  )
  .describe("A numeric Asana user GID or a valid email address");

export const WorkspaceSearchAssigneeSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      value === "me" ||
      GidSchema.safeParse(value).success ||
      z.string().email().safeParse(value).success,
    'Expected "me", a numeric Asana user GID, or a valid email address',
  )
  .describe('The assignee "me", a numeric Asana user GID, or an email address');

export const ListTicketFiltersSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("Maximum tickets to return, from 1 to 100"),
    cursor: z
      .string()
      .trim()
      .min(1)
      .describe("Opaque cursor from a prior call with exactly the same filters and limit")
      .optional(),
    completed: z.boolean().describe("Exact ticket completion state").optional(),
    type: NonEmptyNameSchema.describe("Teamspace-local ticket type name").optional(),
    label: NonEmptyNameSchema.describe("Teamspace-local label name").optional(),
    assignee: NonEmptyNameSchema.describe(
      "Assignee name, email address, or numeric Asana user GID",
    ).optional(),
    release: NonEmptyNameSchema.describe("Release project name or numeric GID").optional(),
  })
  .strict();

export const SearchTicketFiltersSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, "Search text must not be empty")
      .describe("Distinctive text to search for in ticket names and descriptions")
      .optional(),
    assignee: WorkspaceSearchAssigneeSchema.optional(),
    completed: z.boolean().describe("Exact completion state").optional(),
    "completed_on.before": DateOnlySchema.optional(),
    "completed_on.after": DateOnlySchema.optional(),
    compact: z
      .boolean()
      .default(false)
      .describe("Return only gid, name, created_at, and completed_at"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(50)
      .describe("Maximum matches to return, from 1 to 1,000"),
  })
  .strict();

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
      .describe(
        "The replacement plain-text description; an empty string clears it. Markdown is not rendered; use description_html for rich formatting.",
      )
      .optional(),
    description_html: z.string().describe(TICKET_DESCRIPTION_HTML_DESCRIPTION).optional(),
    completed: z.boolean().describe("Whether the ticket is completed").optional(),
    type: NonEmptyNameSchema.describe("A Teamspace-local ticket type option name").optional(),
    labels: LabelUpdateSchema.optional(),
    assignee: AssigneeIdentifierSchema.nullable()
      .describe("An Asana user GID or email address, or null to clear the assignee")
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
    description: z
      .string()
      .describe(
        "The initial plain-text description. Markdown is not rendered; use description_html for rich formatting.",
      )
      .optional(),
    description_html: z.string().describe(TICKET_DESCRIPTION_HTML_DESCRIPTION).optional(),
    type: NonEmptyNameSchema.describe("A Teamspace-local ticket type option name").optional(),
    labels: LabelNamesSchema.describe("Initial Teamspace-local label option names").optional(),
    assignee: AssigneeIdentifierSchema.describe(
      "Initial assignee user GID or email address",
    ).optional(),
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
export type WorkspaceSearchAssignee = z.infer<typeof WorkspaceSearchAssigneeSchema>;
export type ListTicketFilters = z.infer<typeof ListTicketFiltersSchema>;
export type SearchTicketFilters = z.infer<typeof SearchTicketFiltersSchema>;
export type LabelUpdate = z.infer<typeof LabelUpdateSchema>;
export type UpdateTicketFields = z.infer<typeof UpdateTicketFieldsSchema>;
export type CreateTicketFields = z.infer<typeof CreateTicketFieldsSchema>;
export type PendingInitialization = z.infer<typeof PendingInitializationSchema>;
