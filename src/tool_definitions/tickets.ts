import { z } from "zod";
import { TeamspaceIdentifierSchema } from "../teamspace_identity.js";
import {
  CreateTicketFieldsSchema,
  ListTicketFiltersSchema,
  SearchTicketFiltersSchema,
  TicketIdentifierSchema,
  UpdateTicketFieldsSchema,
  withTicketId,
} from "../ticket_inputs.js";
import { defineTeamspaceScopedTool } from "../tool_registry.js";
import { GetTicketPullRequestsOutputSchema } from "../tools/pull_requests.js";
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

export const ListTicketsInputSchema = ListTicketFiltersSchema.extend({
  teamspace_id: TeamspaceIdentifierSchema,
});

const listTickets = defineTeamspaceScopedTool({
  name: "list_tickets",
  title: "List tickets",
  description:
    "Enumerate tickets in the selected Teamspace with bounded type, label, assignee, Release, and completion-status filtering plus opaque pagination. Use search_tickets instead for completion-date ranges.",
  input: ListTicketsInputSchema,
  output: ListTicketsOutputSchema,
  readOnly: true,
  handler: (input, context) =>
    context.services.ticketListing.listTickets(input, context.schema, context.deadlineMs),
});

export const SearchTicketsInputSchema = SearchTicketFiltersSchema.extend({
  teamspace_id: TeamspaceIdentifierSchema,
});

const searchTickets = defineTeamspaceScopedTool({
  name: "search_tickets",
  title: "Search tickets",
  description:
    "Search tickets in the selected Teamspace using eventually consistent Asana workspace search, with a total result limit up to 1,000. Use this tool for completion-date ranges; results include created_at and completed_at. Set compact=true to return only gid, name, and those timestamps.",
  input: SearchTicketsInputSchema,
  output: SearchTicketsOutputSchema,
  readOnly: true,
  handler: (input, context) =>
    context.services.ticketListing.searchTickets(input, context.schema, context.deadlineMs),
});

const GetTicketPullRequestsInputSchema = z
  .object({
    teamspace_id: TeamspaceIdentifierSchema,
    ticket_id: TicketIdentifierSchema.describe(
      "The ticket whose attachments and stories should be scanned for GitHub pull-request URLs",
    ),
  })
  .strict();

const getTicketPullRequests = defineTeamspaceScopedTool({
  name: "get_ticket_prs",
  title: "Get ticket pull requests",
  description:
    "Best-effort discovery of GitHub pull-request URLs in ticket attachments and stories.",
  input: GetTicketPullRequestsInputSchema,
  output: GetTicketPullRequestsOutputSchema,
  readOnly: true,
  handler: (input, context) =>
    context.services.pullRequests.getTicketPrs(input.ticket_id, context.schema, context.deadlineMs),
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

export const ticketReadToolDefinitions = [readTicket] as const;
export const ticketListingToolDefinitions = [listTickets, searchTickets] as const;
export const pullRequestToolDefinitions = [getTicketPullRequests] as const;
export const ticketMutationToolDefinitions = [createTicket, updateTicket] as const;

export const ticketToolDefinitions = [
  ...ticketReadToolDefinitions,
  ...ticketListingToolDefinitions,
  ...pullRequestToolDefinitions,
  ...ticketMutationToolDefinitions,
] as const;
