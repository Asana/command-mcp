import { z } from "zod";
import { TeamspaceIdentifierSchema } from "../teamspace_identity.js";
import { TicketIdentifierSchema } from "../ticket_inputs.js";
import { defineTeamspaceScopedTool } from "../tool_registry.js";
import {
  AddDependencyOutputSchema,
  AddDependencyProtocolOutputSchema,
  RemoveDependencyOutputSchema,
  RemoveDependencyProtocolOutputSchema,
} from "../tools/workflow.js";

export const DependencyInputSchema = z
  .object({
    teamspace_id: TeamspaceIdentifierSchema,
    ticket: TicketIdentifierSchema.describe(
      "The ticket that depends on and is blocked by the dependency argument",
    ),
    dependency: TicketIdentifierSchema.describe(
      "The dependency ticket that blocks the ticket argument; the ticket cannot proceed until this dependency is done",
    ),
  })
  .strict();

const addDependency = defineTeamspaceScopedTool({
  name: "add_dependency",
  title: "Add ticket dependency",
  description:
    "Make ticket depend on dependency (dependency blocks ticket), then return ticket's current dependency list.",
  input: DependencyInputSchema,
  output: AddDependencyOutputSchema,
  protocolOutput: AddDependencyProtocolOutputSchema,
  readOnly: false,
  destructive: true,
  idempotent: true,
  handler: (input, context) =>
    context.services.workflow.addDependency(
      input.ticket,
      input.dependency,
      context.schema,
      context.deadlineMs,
    ),
});

const removeDependency = defineTeamspaceScopedTool({
  name: "remove_dependency",
  title: "Remove ticket dependency",
  description:
    "Stop ticket from depending on dependency, then return ticket's current dependency list.",
  input: DependencyInputSchema,
  output: RemoveDependencyOutputSchema,
  protocolOutput: RemoveDependencyProtocolOutputSchema,
  readOnly: false,
  destructive: true,
  idempotent: true,
  handler: (input, context) =>
    context.services.workflow.removeDependency(
      input.ticket,
      input.dependency,
      context.schema,
      context.deadlineMs,
    ),
});

export const workflowToolDefinitions = [addDependency, removeDependency] as const;
