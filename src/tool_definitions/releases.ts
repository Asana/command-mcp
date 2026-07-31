import { z } from "zod";
import { TeamspaceIdentifierSchema, withTeamspaceId } from "../teamspace_identity.js";
import { TicketIdentifierSchema } from "../ticket_inputs.js";
import { defineTeamspaceScopedTool } from "../tool_registry.js";
import {
  AddTicketToReleaseOutputSchema,
  AddTicketToReleaseProtocolOutputSchema,
  RemoveTicketFromReleaseOutputSchema,
  RemoveTicketFromReleaseProtocolOutputSchema,
  TeamspaceReleasesOutputSchema,
} from "../tools/releases.js";

const ListTeamspaceReleasesInputSchema = withTeamspaceId({});

const ReleaseMutationInputSchema = z
  .object({
    teamspace_id: TeamspaceIdentifierSchema,
    ticket_id: TicketIdentifierSchema,
    release: z
      .string()
      .trim()
      .min(1, "Release name or GID is required")
      .describe("Exact name or GID returned by list_teamspace_releases"),
  })
  .strict();

const listTeamspaceReleases = defineTeamspaceScopedTool({
  name: "list_teamspace_releases",
  title: "List Teamspace releases",
  description: "List only Releases referenced by the selected Teamspace.",
  input: ListTeamspaceReleasesInputSchema,
  output: TeamspaceReleasesOutputSchema,
  readOnly: true,
  handler: (_input, context) => context.services.releases.listReleases(context.schema),
});

const addTicketToRelease = defineTeamspaceScopedTool({
  name: "add_ticket_to_release",
  title: "Add ticket to Release",
  description: "Multi-home a ticket into a currently referenced Teamspace Release.",
  input: ReleaseMutationInputSchema,
  output: AddTicketToReleaseOutputSchema,
  protocolOutput: AddTicketToReleaseProtocolOutputSchema,
  readOnly: false,
  destructive: false,
  idempotent: true,
  handler: (input, context) =>
    context.services.releases.addTicketToRelease(
      input.ticket_id,
      input.release,
      context.schema,
      context.deadlineMs,
    ),
});

const removeTicketFromRelease = defineTeamspaceScopedTool({
  name: "remove_ticket_from_release",
  title: "Remove ticket from Release",
  description: "Remove a ticket from a currently referenced Teamspace Release.",
  input: ReleaseMutationInputSchema,
  output: RemoveTicketFromReleaseOutputSchema,
  protocolOutput: RemoveTicketFromReleaseProtocolOutputSchema,
  readOnly: false,
  destructive: true,
  idempotent: true,
  handler: (input, context) =>
    context.services.releases.removeTicketFromRelease(
      input.ticket_id,
      input.release,
      context.schema,
      context.deadlineMs,
    ),
});

export const releaseReadToolDefinitions = [listTeamspaceReleases] as const;
export const releaseMutationToolDefinitions = [
  addTicketToRelease,
  removeTicketFromRelease,
] as const;
