import { z } from "zod";
import { GidSchema, WorkspaceSchema } from "./asana_contracts.js";
import { tryParseAsanaAppUrl } from "./asana_url.js";
import { CommandError } from "./errors.js";

const TEAMSPACE_PATH_PATTERN = /^\/\d+\/\d+\/project\/\d+\/dev\/space\/(\d+)(?:\/.*)?$/;

export const TeamspaceIdentifierSchema = z
  .string()
  .describe(
    "Numeric Asana project GID for the Teamspace, or an https://app.asana.com/.../dev/space/{id} URL",
  );

export const TeamspaceReferenceSchema = z.object({
  gid: GidSchema,
  name: z.string(),
  url: z.string().optional(),
});

export const ProvenanceSchema = z.object({
  workspace: WorkspaceSchema,
  teamspace: TeamspaceReferenceSchema,
});

export type TeamspaceReference = z.infer<typeof TeamspaceReferenceSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;

export function withTeamspaceId<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).extend({
    teamspace_id: TeamspaceIdentifierSchema,
  });
}

export function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function extractTeamspaceIdFromPath(pathname: string): string | null {
  const match = pathname.match(TEAMSPACE_PATH_PATTERN);
  return match?.[1] ?? null;
}

function invalidTeamspaceIdentifier(message: string, issues: unknown[]): never {
  throw new CommandError("invalid_input", message, {
    details: { issues },
  });
}

export function resolveTeamspaceIdentifier(input: string): string {
  if (GidSchema.safeParse(input).success) {
    return input;
  }

  const parsed = tryParseAsanaAppUrl(input);
  if (parsed === null) {
    invalidTeamspaceIdentifier("Invalid Teamspace identifier", [
      {
        path: ["teamspace_id"],
        message: "expected a numeric project GID or a Teamspace app URL",
      },
    ]);
  }

  const teamspaceId = extractTeamspaceIdFromPath(parsed.pathname);
  if (teamspaceId === null) {
    invalidTeamspaceIdentifier("Teamspace URL path is invalid", [
      {
        path: ["teamspace_id"],
        message:
          "expected path shape /{app}/{workspace}/project/{project}/dev/space/{teamspace_id}",
      },
    ]);
  }

  return teamspaceId;
}
