import { ReadTicketOutputSchema } from "../tickets.js";
import { withTeamspaceId } from "../teamspace_identity.js";
import { TicketIdentifierSchema } from "../ticket_inputs.js";
import { defineTeamspaceScopedTool } from "../tool_registry.js";

const ReadTicketInputSchema = withTeamspaceId({
  ticket_id: TicketIdentifierSchema,
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

export const ticketToolDefinitions = [readTicket] as const;
