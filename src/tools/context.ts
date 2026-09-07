import { z } from "zod";
import {
  TEAMSPACE_CANDIDATE_FIELDS,
  TeamspaceCandidateSchema,
  WORKSPACE_FIELDS,
  WorkspaceSchema,
} from "../asana_contracts.js";
import type {
  AsanaHttpResult,
  AsanaRequestExecutorPort,
  AsanaRequestOptions,
  AsanaRequestTrace,
} from "../asana_gateway.js";
import { commandTeamspaceUrl } from "../asana_url.js";
import { CommandError } from "../errors.js";
import { collectPages } from "../pagination/scanner.js";
import type { DiscoveryResult } from "../schema_discovery.js";
import { TeamspaceReferenceSchema } from "../teamspace_identity.js";
import { createGitHubUpdateChecker, type UpdateChecker } from "../update_check.js";

export const WorkspaceListSchema = z.object({
  workspaces: z.array(WorkspaceSchema),
});

const TeamspaceCandidateReferenceSchema = TeamspaceReferenceSchema.extend({
  url: z.string().url(),
});

export const TeamspaceCandidatesSchema = z.object({
  candidates: z.array(TeamspaceCandidateReferenceSchema),
  schema_validated: z.literal(false),
  truncated: z.boolean(),
});

export const ContextProjectionSchema = z.object({
  workspace: WorkspaceSchema.describe("The selected workspace"),
  teamspace: TeamspaceReferenceSchema.describe("The selected Command Teamspace"),
  ticket_prefix: z.string().nullable().describe("The short-ID prefix or null when unavailable"),
  schema_fingerprint: z.string().describe("The fingerprint of the freshly discovered schema"),
  validation_warnings: z.array(z.string()).describe("Schema limitations the caller must surface"),
  update_available: z
    .string()
    .nullable()
    .describe(
      "The latest published server version when newer than the running version; null when already current or the check could not complete. Tell the user to run the installer again when set.",
    ),
});

export type WorkspaceList = z.infer<typeof WorkspaceListSchema>;
export type TeamspaceCandidates = z.infer<typeof TeamspaceCandidatesSchema>;
export type ContextProjection = z.infer<typeof ContextProjectionSchema>;

export type FindTeamspacesInput = {
  workspaceGid: string;
  query?: string;
  limit: number;
  deadlineMs: number;
};

export type ContextService = {
  listWorkspaces(deadlineMs: number): Promise<WorkspaceList>;
  findTeamspaces(input: FindTeamspacesInput): Promise<TeamspaceCandidates>;
  getContext(snapshot: DiscoveryResult): Promise<ContextProjection>;
};

function ensureHttpResult(result: unknown): AsanaHttpResult {
  if (typeof result === "object" && result !== null && "response" in result && "data" in result) {
    return result as AsanaHttpResult;
  }
  throw new CommandError("asana_api_error", "Unexpected collection response shape from Asana");
}

function pageResult<T>(page: { items: T[]; nextPageOffset: string | null }): {
  items: T[];
  nextOffset?: string;
} {
  return {
    items: page.items,
    ...(page.nextPageOffset === null ? {} : { nextOffset: page.nextPageOffset }),
  };
}

async function listWorkspaces(
  executor: AsanaRequestExecutorPort,
  deadlineMs: number,
): Promise<WorkspaceList> {
  const options: AsanaRequestOptions = { deadlineMs };
  const trace = executor.createTrace();
  const workspaces = await collectPages({
    loadPage: async (pageSize, offset) => {
      const page = await executor.readPage(
        WorkspaceSchema,
        options,
        async (resources) =>
          ensureHttpResult(
            await resources.workspaces.getWorkspacesWithHttpInfo({
              limit: pageSize,
              ...(offset === undefined ? {} : { offset }),
              opt_fields: WORKSPACE_FIELDS,
            }),
          ),
        trace,
      );
      return pageResult(page);
    },
  });

  return { workspaces };
}

async function findTeamspaces(
  executor: AsanaRequestExecutorPort,
  input: FindTeamspacesInput,
): Promise<TeamspaceCandidates> {
  const options: AsanaRequestOptions = { deadlineMs: input.deadlineMs };
  const trace: AsanaRequestTrace = executor.createTrace();
  const page = await executor.readPage(
    TeamspaceCandidateSchema,
    options,
    async (resources) =>
      ensureHttpResult(
        await resources.typeahead.typeaheadForWorkspaceWithHttpInfo(input.workspaceGid, "project", {
          count: input.limit,
          ...(input.query === undefined ? {} : { query: input.query }),
          opt_fields: TEAMSPACE_CANDIDATE_FIELDS,
        }),
      ),
    trace,
  );

  return {
    candidates: page.items.map((candidate) => ({
      gid: candidate.gid,
      name: candidate.name,
      url: commandTeamspaceUrl(input.workspaceGid, candidate.gid),
    })),
    schema_validated: false,
    truncated: page.items.length === input.limit,
  };
}

async function getContext(
  snapshot: DiscoveryResult,
  checkForUpdate: UpdateChecker,
): Promise<ContextProjection> {
  return {
    workspace: snapshot.workspace,
    teamspace: snapshot.teamspace,
    ticket_prefix: snapshot.ticket_short_id_field.id_prefix,
    schema_fingerprint: snapshot.fingerprint,
    validation_warnings: snapshot.warnings,
    update_available: await checkForUpdate(),
  };
}

export function createContextService(
  executor: AsanaRequestExecutorPort,
  checkForUpdate: UpdateChecker = createGitHubUpdateChecker(),
): ContextService {
  return {
    listWorkspaces: (deadlineMs) => listWorkspaces(executor, deadlineMs),
    findTeamspaces: (input) => findTeamspaces(executor, input),
    getContext: (snapshot) => getContext(snapshot, checkForUpdate),
  };
}
