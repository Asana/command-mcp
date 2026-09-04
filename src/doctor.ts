import { z } from "zod";
import { WorkspaceSchema } from "./asana_contracts.js";
import type { Config } from "./config.js";
import { asCommandError, CommandError } from "./errors.js";
import type { DiscoveryResult } from "./schema_discovery.js";
import { buildServices, type CommandServices } from "./services.js";
import { resolveTeamspaceIdentifier, TeamspaceReferenceSchema } from "./teamspace_identity.js";
import type { WorkspaceList } from "./tools/context.js";
import { createGitHubUpdateChecker, type UpdateChecker } from "./update_check.js";

export const DOCTOR_USAGE = "Usage: asana-command-mcp doctor [TEAMSPACE_ID_OR_URL]";

const PassedStatusSchema = z.object({
  status: z.literal("passed"),
});

const AuthenticationCheckSchema = PassedStatusSchema.extend({
  workspaces: z.array(WorkspaceSchema),
});

const TeamspaceSchemaCheckSchema = PassedStatusSchema.extend({
  workspace: WorkspaceSchema,
  teamspace: TeamspaceReferenceSchema,
  schema_fingerprint: z.string(),
  warnings: z.array(z.string()),
});

export const DoctorReportSchema = z.object({
  status: z.literal("passed"),
  authentication: AuthenticationCheckSchema,
  teamspace_schema: TeamspaceSchemaCheckSchema.optional(),
  asana_custom_types_opt_in: PassedStatusSchema.optional(),
  update_available: z
    .string()
    .nullable()
    .describe(
      "The latest published server version when newer than the running version; null when already current or the check could not complete.",
    ),
});

export type DoctorReport = z.infer<typeof DoctorReportSchema>;

export type RunDoctorOptions = {
  readonly services?: CommandServices;
  readonly deadlineMs?: number;
  readonly checkForUpdate?: UpdateChecker;
};

function usageError(cause?: unknown): CommandError {
  return new CommandError("invalid_input", DOCTOR_USAGE, {
    details: { usage: DOCTOR_USAGE },
    ...(cause === undefined ? {} : { cause }),
  });
}

function parseTeamspaceArgument(args: readonly string[]): string | null {
  if (args.length === 0) {
    return null;
  }
  if (args.length !== 1) {
    throw usageError();
  }
  const [argument] = args;
  if (argument === undefined) {
    throw usageError();
  }
  try {
    return resolveTeamspaceIdentifier(argument);
  } catch (error) {
    throw usageError(error);
  }
}

export function validateDoctorArguments(args: readonly string[]): void {
  parseTeamspaceArgument(args);
}

function stageError(error: unknown, stage: string): CommandError {
  const normalized = asCommandError(error);
  return new CommandError(normalized.code, normalized.message, {
    details: {
      ...(normalized.details ?? {}),
      stage,
    },
    asanaRequestIds: normalized.asanaRequestIds,
    cause: normalized,
  });
}

export async function runDoctor(
  args: readonly string[],
  config: Config,
  options: RunDoctorOptions = {},
): Promise<DoctorReport> {
  const teamspaceId = parseTeamspaceArgument(args);
  const services = options.services ?? buildServices(config);
  const deadlineMs = options.deadlineMs ?? Date.now() + config.toolTimeoutMs;
  const checkForUpdate = options.checkForUpdate ?? createGitHubUpdateChecker();

  let workspaces: WorkspaceList;
  try {
    workspaces = await services.context.listWorkspaces(deadlineMs);
  } catch (error) {
    throw stageError(error, "authentication");
  }
  const updateAvailable = await checkForUpdate();

  const authentication = {
    status: "passed" as const,
    workspaces: workspaces.workspaces,
  };
  if (teamspaceId === null) {
    return DoctorReportSchema.parse({
      status: "passed",
      authentication,
      update_available: updateAvailable,
    });
  }

  let schema: DiscoveryResult;
  try {
    schema = await services.schemaDiscovery.discover(teamspaceId, deadlineMs);
  } catch (error) {
    throw stageError(error, "teamspace_schema_and_custom_types_opt_in");
  }

  return DoctorReportSchema.parse({
    status: "passed",
    authentication,
    teamspace_schema: {
      status: "passed",
      workspace: schema.workspace,
      teamspace: schema.teamspace,
      schema_fingerprint: schema.fingerprint,
      warnings: schema.warnings,
    },
    asana_custom_types_opt_in: {
      status: "passed",
    },
    update_available: updateAvailable,
  });
}
