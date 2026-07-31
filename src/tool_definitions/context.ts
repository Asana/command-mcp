import { z } from "zod";
import { GidSchema } from "../asana_contracts.js";
import {
  ContextProjectionSchema,
  TeamspaceCandidatesSchema,
  WorkspaceListSchema,
} from "../context.js";
import { DiscoveryResultSchema } from "../schema_discovery.js";
import { withTeamspaceId } from "../teamspace_identity.js";
import {
  defineTeamspaceScopedTool,
  defineUnscopedTool,
  EMPTY_INPUT_SCHEMA,
} from "../tool_registry.js";

const TeamspaceOnlyInputSchema = withTeamspaceId({});

const FindTeamspacesInputSchema = z
  .object({
    workspace_gid: GidSchema.describe("Numeric Asana workspace GID"),
    query: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

const getContext = defineTeamspaceScopedTool({
  name: "get_context",
  title: "Get Asana Command Teamspace context",
  description:
    "Confirm one selected Teamspace at the start of an Asana workflow or when diagnosing schema warnings; do not call before every tool.",
  input: TeamspaceOnlyInputSchema,
  output: ContextProjectionSchema,
  readOnly: true,
  handler: (_input, context) => context.services.context.getContext(context.schema),
});

const listWorkspaces = defineUnscopedTool({
  name: "list_workspaces",
  title: "List Asana workspaces",
  description:
    "List workspaces accessible to the configured Asana Personal Access Token for Teamspace discovery or access diagnosis.",
  input: EMPTY_INPUT_SCHEMA,
  output: WorkspaceListSchema,
  readOnly: true,
  handler: (_input, context) => context.services.context.listWorkspaces(context.deadlineMs),
});

const findTeamspaces = defineUnscopedTool({
  name: "find_teamspaces",
  title: "Find Command Teamspaces",
  description:
    "Find recent or query-matched Teamspace candidates in one workspace; candidates are not schema-validated.",
  input: FindTeamspacesInputSchema,
  output: TeamspaceCandidatesSchema,
  readOnly: true,
  handler: (input, context) =>
    context.services.context.findTeamspaces({
      workspaceGid: input.workspace_gid,
      ...(input.query === undefined ? {} : { query: input.query }),
      limit: input.limit,
      deadlineMs: context.deadlineMs,
    }),
});

const getTeamspaceSchema = defineTeamspaceScopedTool({
  name: "get_teamspace_schema",
  title: "Get Teamspace schema",
  description: "Return the freshly discovered Command schema used for this tool call.",
  input: TeamspaceOnlyInputSchema,
  output: DiscoveryResultSchema,
  readOnly: true,
  handler: (_input, context) => context.schema,
});

export const contextToolDefinitions = [
  getContext,
  listWorkspaces,
  findTeamspaces,
  getTeamspaceSchema,
] as const;
