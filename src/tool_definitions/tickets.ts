import { z } from "zod";
import { TeamspaceIdentifierSchema } from "../teamspace_identity.js";
import {
  CreateTicketFieldsSchema,
  DateOnlySchema,
  TicketIdentifierSchema,
  UpdateTicketFieldsSchema,
  withTicketId,
} from "../ticket_inputs.js";
import { defineTeamspaceScopedTool } from "../tool_registry.js";
import { ListTicketsOutputSchema, SearchTicketsOutputSchema } from "../tools/ticket_listing.js";
import {
  CreateTicketOutputSchema,
  CreateTicketProtocolOutputSchema,
  ReadTicketOutputSchema,
  UpdateTicketOutputSchema,
  UpdateTicketProtocolOutputSchema,
} from "../tools/tickets.js";

const ReadTicketInputSchema = withTicketId({
  teamspace_id: TeamspaceIdentifierSchema,
});

const readTicket = defineTeamspaceScopedTool({
  name: "read_ticket",
  title: "Read ticket",
  description: "Read one Command ticket by Asana GID, Command short ID, or Asana task URL.",
  input: ReadTicketInputSchema,
  output: ReadTicketOutputSchema,
  readOnly: true,
  handler: (input, context) =>
    context.services.tickets.readTicket(input.ticket_id, context.schema, context.deadlineMs),
});

const FilterNameSchema = z.string().trim().min(1, "Filter value must not be empty");

export const ListTicketsInputSchema = z
  .object({
    teamspace_id: TeamspaceIdentifierSchema,
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
    type: FilterNameSchema.describe("Teamspace-local ticket type name").optional(),
    label: FilterNameSchema.describe("Teamspace-local label name").optional(),
    assignee: FilterNameSchema.describe(
      "Assignee name, email address, or numeric Asana user GID",
    ).optional(),
    release: FilterNameSchema.describe("Release project name or numeric GID").optional(),
  })
  .strict();

const listTickets = defineTeamspaceScopedTool({
  name: "list_tickets",
  title: "List tickets",
  description:
    "Enumerate tickets in the selected Teamspace with bounded type, label, assignee, Release, and completion-status filtering plus opaque pagination. Use search_tickets instead for completion-date or due-date ranges.",
  input: ListTicketsInputSchema,
  output: ListTicketsOutputSchema,
  readOnly: true,
  handler: (input, context) =>
    context.services.ticketListing.listTickets(input, context.schema, context.deadlineMs),
});

export const SearchTicketsInputSchema = z
  .object({
    teamspace_id: TeamspaceIdentifierSchema,
    text: z
      .string()
      .trim()
      .min(1, "Search text must not be empty")
      .describe("Distinctive text to search for in ticket names and descriptions")
      .optional(),
    assignee: z
      .string()
      .trim()
      .min(1, "Assignee must not be empty")
      .describe("Assignee identifier accepted by Asana workspace search")
      .optional(),
    completed: z.boolean().describe("Exact completion state").optional(),
    "due_on.before": DateOnlySchema.optional(),
    "due_on.after": DateOnlySchema.optional(),
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

const searchTickets = defineTeamspaceScopedTool({
  name: "search_tickets",
  title: "Search tickets",
  description:
    "Search tickets in the selected Teamspace using eventually consistent Asana workspace search, with a total result limit up to 1,000. Use this tool for completion-date or due-date ranges; results include created_at and completed_at. Set compact=true to return only gid, name, and those timestamps.",
  input: SearchTicketsInputSchema,
  output: SearchTicketsOutputSchema,
  readOnly: true,
  handler: (input, context) =>
    context.services.ticketListing.searchTickets(input, context.schema, context.deadlineMs),
});

const CreateTicketInputSchema = CreateTicketFieldsSchema.extend({
  teamspace_id: TeamspaceIdentifierSchema,
});

const createTicket = defineTeamspaceScopedTool({
  name: "create_ticket",
  title: "Create ticket",
  description:
    "Create a Command ticket and wait for asynchronous custom-type initialization. For natural-language ticketing requests, search the whole Teamspace first for active duplicates.",
  input: CreateTicketInputSchema,
  output: CreateTicketOutputSchema,
  protocolOutput: CreateTicketProtocolOutputSchema,
  readOnly: false,
  destructive: false,
  idempotent: false,
  handler: (input, context) =>
    context.services.tickets.createTicket(input, context.schema, context.deadlineMs),
});

export const UpdateTicketProtocolInputSchema = z
  .object({
    teamspace_id: TeamspaceIdentifierSchema,
    task_gid: TicketIdentifierSchema.describe(
      "Ticket identifier: an Asana task GID, Command short ID, or Asana task URL",
    ),
    ...UpdateTicketFieldsSchema.shape,
  })
  .strict();

export const UpdateTicketRuntimeInputSchema = UpdateTicketProtocolInputSchema.refine(
  (input) => Object.keys(input).some((key) => key !== "teamspace_id" && key !== "task_gid"),
  {
    message: "At least one ticket field must be updated",
  },
);

const updateTicket = defineTeamspaceScopedTool({
  name: "update_ticket",
  title: "Update ticket",
  description: "Update one in-scope ticket and return a canonical post-write read.",
  input: UpdateTicketRuntimeInputSchema,
  protocolInput: UpdateTicketProtocolInputSchema,
  output: UpdateTicketOutputSchema,
  protocolOutput: UpdateTicketProtocolOutputSchema,
  readOnly: false,
  destructive: true,
  idempotent: true,
  handler: (input, context) => {
    const { task_gid: taskGid, ...fields } = input;
    return context.services.tickets.updateTicket(
      taskGid,
      fields,
      context.schema,
      context.deadlineMs,
    );
  },
});

export const ticketToolDefinitions = [
  readTicket,
  listTickets,
  searchTickets,
  createTicket,
  updateTicket,
] as const;
