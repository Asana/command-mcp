import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CUSTOM_FIELD_SETTING_FIELDS,
  CUSTOM_TYPE_FIELDS,
  type CustomField,
  type CustomFieldSetting,
  CustomFieldSettingSchema,
  type CustomType,
  CustomTypeSchema,
  type EnumOption,
  GidSchema,
  PROJECT_FIELDS,
  type Project,
  ProjectSchema,
  StatusUpdateSchema,
  WorkspaceSchema,
} from "./asana_contracts.js";
import type {
  AsanaHttpResult,
  AsanaRequestExecutorPort,
  AsanaRequestOptions,
  AsanaRequestTrace,
} from "./asana_gateway.js";
import { commandTeamspaceUrl } from "./asana_url.js";
import { CommandError } from "./errors.js";
import { collectPages } from "./pagination/scanner.js";
import {
  normalizeName,
  type Provenance,
  ProvenanceSchema,
  type TeamspaceReference,
  TeamspaceReferenceSchema,
} from "./teamspace_identity.js";

const ASANA_DEV_PREDICTED_START_DATE = "ASANA_DEV_PREDICTED_START_DATE";
const ASANA_DEV_PREDICTED_COMPLETION_DATE = "ASANA_DEV_PREDICTED_COMPLETION_DATE";
const DEV_TICKET_TYPE = "dev_ticket_type";

const TICKET_TYPE_OPTION_NAMES = ["feature", "bug", "task"] as const;

const ENGLISH_HEURISTICS_WARNING =
  "Discovery relies on English-language field and option heuristics in this beta.";

const MISSING_TICKET_TYPE_WARNING =
  "Ticket type field was not found; type reads return null and type filters and type mutations are unavailable.";

const FINGERPRINT_HEX_LENGTH = 16;

function ensureHttpResult(result: unknown): AsanaHttpResult {
  if (typeof result === "object" && result !== null && "response" in result && "data" in result) {
    return result as AsanaHttpResult;
  }
  throw new CommandError("asana_api_error", "Unexpected paginated response shape from Asana");
}

export const FieldOptionSchema = z.object({
  gid: GidSchema,
  name: z.string(),
});

export const FieldDefinitionSchema = z.object({
  gid: GidSchema,
  name: z.string(),
  resource_subtype: z.string().optional(),
  representation_type: z.string().optional(),
  enum_options: z.array(FieldOptionSchema),
});

export const ShortIdFieldDefinitionSchema = FieldDefinitionSchema.extend({
  id_prefix: z.string().nullable(),
});

export const ReleaseReferenceSchema = z.object({
  gid: GidSchema,
  name: z.string(),
  due_on: z.string().nullable(),
  completed: z.boolean(),
  current_status_update: StatusUpdateSchema.nullable(),
});

export const DiscoveryResultSchema = z.object({
  workspace: WorkspaceSchema,
  teamspace: TeamspaceReferenceSchema,
  ticket_custom_type: z.object({
    gid: GidSchema,
    name: z.string(),
  }),
  ticket_short_id_field: ShortIdFieldDefinitionSchema,
  ticket_type_field: FieldDefinitionSchema.nullable(),
  labels_field: FieldDefinitionSchema,
  predicted_start_date_field: FieldDefinitionSchema,
  predicted_completion_date_field: FieldDefinitionSchema,
  releases_field: FieldDefinitionSchema,
  releases: z.array(ReleaseReferenceSchema),
  fingerprint: z.string(),
  warnings: z.array(z.string()),
  discovered_at: z.string().datetime(),
});

export type FieldOption = z.infer<typeof FieldOptionSchema>;
export type FieldDefinition = z.infer<typeof FieldDefinitionSchema>;
export type ShortIdFieldDefinition = z.infer<typeof ShortIdFieldDefinitionSchema>;
export type ReleaseReference = z.infer<typeof ReleaseReferenceSchema>;
export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;

const DISCOVERY_RELEASE_FIELDS = [
  "gid",
  "name",
  "completed",
  "due_on",
  "current_status_update.gid",
  "current_status_update.title",
  "current_status_update.text",
].join(",");

const ReleaseProjectSchema = z.object({
  gid: GidSchema,
  name: z.string(),
  completed: z.boolean().optional(),
  due_on: z.string().nullable().optional(),
  current_status_update: StatusUpdateSchema.nullable().optional(),
});

type Candidate = { gid: string; name: string };

function enabledOptions(field: CustomField): EnumOption[] {
  const options =
    field.resource_subtype === "multi_enum"
      ? (field.multi_enum_options ?? [])
      : field.resource_subtype === "enum"
        ? (field.enum_options ?? [])
        : [];
  return options.filter((option) => option.enabled !== false);
}

function toFieldDefinition(field: CustomField): FieldDefinition {
  const definition: FieldDefinition = {
    gid: field.gid,
    name: field.name,
    enum_options: enabledOptions(field).map((option) => ({
      gid: option.gid,
      name: option.name,
    })),
  };
  if (field.resource_subtype !== undefined) {
    definition.resource_subtype = field.resource_subtype;
  }
  if (field.representation_type !== undefined) {
    definition.representation_type = field.representation_type;
  }
  return definition;
}

function toShortIdFieldDefinition(field: CustomField): ShortIdFieldDefinition {
  return {
    ...toFieldDefinition(field),
    id_prefix: field.id_prefix ?? null,
  };
}

function schemaIncompatible(message: string, details?: Record<string, unknown>): never {
  throw new CommandError("schema_incompatible", message, {
    ...(details === undefined ? {} : { details }),
  });
}

function schemaAmbiguous(message: string, candidates: Candidate[]): never {
  throw new CommandError("schema_ambiguous", message, {
    details: { candidates },
  });
}

function requireExactlyOne<T>(matches: T[], role: string, toCandidate: (match: T) => Candidate): T {
  if (matches.length === 0) {
    schemaIncompatible(`No ${role} found`);
  }
  if (matches.length > 1) {
    schemaAmbiguous(`Multiple ${role} fields found`, matches.map(toCandidate));
  }
  const [match] = matches;
  if (match === undefined) {
    schemaIncompatible(`No ${role} found`);
  }
  return match;
}

function resolveTicketCustomType(customTypes: CustomType[]): CustomType {
  const devTicketMatches = customTypes.filter(
    (customType) => normalizeName(customType.name) === "dev ticket",
  );
  if (devTicketMatches.length === 1) {
    const [match] = devTicketMatches;
    if (match === undefined) {
      schemaIncompatible("No ticket custom type found");
    }
    return match;
  }
  if (customTypes.length === 1) {
    const [match] = customTypes;
    if (match === undefined) {
      schemaIncompatible("No ticket custom type found");
    }
    return match;
  }
  if (customTypes.length === 0) {
    schemaIncompatible("No ticket custom type found");
  }
  schemaAmbiguous("Multiple ticket custom types found", customTypes);
}

function fieldCandidate(field: CustomField): Candidate {
  return { gid: field.gid, name: field.name };
}

function matchesName(field: CustomField, expectedName: string): boolean {
  return normalizeName(field.name) === normalizeName(expectedName);
}

function matchesAsanaCreatedField(
  field: CustomField,
  identifier: string,
  resourceSubtype: string,
): boolean {
  return field.asana_created_field === identifier && field.resource_subtype === resourceSubtype;
}

function matchesPredictedStartFallback(field: CustomField): boolean {
  const normalized = normalizeName(field.name);
  return normalized === "predicted start" || normalized === "predicted start date";
}

function matchesPredictedCompletionFallback(field: CustomField): boolean {
  const normalized = normalizeName(field.name);
  return normalized === "predicted completion" || normalized === "predicted completion date";
}

function matchesTicketTypeFallback(field: CustomField): boolean {
  if (field.resource_subtype !== "enum") {
    return false;
  }
  const enabledNames = new Set(enabledOptions(field).map((option) => normalizeName(option.name)));
  return (
    enabledNames.size === TICKET_TYPE_OPTION_NAMES.length &&
    TICKET_TYPE_OPTION_NAMES.every((name) => enabledNames.has(name))
  );
}

function resolveFieldByStrategies(
  fields: CustomField[],
  role: string,
  strategies: Array<(field: CustomField) => boolean>,
): CustomField {
  for (const strategy of strategies) {
    const matches = fields.filter(strategy);
    if (matches.length === 1) {
      return matches[0] as CustomField;
    }
    if (matches.length > 1) {
      schemaAmbiguous(`Multiple ${role} fields found`, matches.map(fieldCandidate));
    }
  }
  schemaIncompatible(`No ${role} found`);
}

function resolveOptionalTicketTypeField(fields: CustomField[]): CustomField | null {
  const generatedMatches = fields.filter((field) =>
    matchesAsanaCreatedField(field, DEV_TICKET_TYPE, "enum"),
  );
  if (generatedMatches.length === 1) {
    return generatedMatches[0] as CustomField;
  }
  if (generatedMatches.length > 1) {
    schemaAmbiguous("Multiple ticket type fields found", generatedMatches.map(fieldCandidate));
  }

  const fallbackMatches = fields.filter(matchesTicketTypeFallback);
  if (fallbackMatches.length === 1) {
    return fallbackMatches[0] as CustomField;
  }
  if (fallbackMatches.length > 1) {
    schemaAmbiguous("Multiple ticket type fields found", fallbackMatches.map(fieldCandidate));
  }

  return null;
}

function serializeFieldForFingerprint(field: FieldDefinition): string {
  const options = [...field.enum_options]
    .sort((left, right) => left.gid.localeCompare(right.gid))
    .map((option) => `${option.gid}:${option.name}`)
    .join(",");
  const parts = [
    field.gid,
    field.name,
    field.resource_subtype ?? "",
    field.representation_type ?? "",
    options,
  ];
  return parts.join("|");
}

export function computeDiscoveryFingerprint(input: {
  projectGid: string;
  ticketCustomTypeGid: string;
  fields: FieldDefinition[];
  releaseGids: string[];
}): string {
  const fieldSegments = [...input.fields]
    .sort((left, right) => left.gid.localeCompare(right.gid))
    .map((field) => serializeFieldForFingerprint(field));

  const releaseGids = [...input.releaseGids].sort((left, right) => left.localeCompare(right));

  const payload = [
    `project:${input.projectGid}`,
    `ticket_custom_type:${input.ticketCustomTypeGid}`,
    ...fieldSegments.map((segment) => `field:${segment}`),
    `releases:${releaseGids.join(",")}`,
  ].join("\n");

  return createHash("sha256").update(payload).digest("hex").slice(0, FINGERPRINT_HEX_LENGTH);
}

async function readTeamspaceProject(
  executor: AsanaRequestExecutorPort,
  teamspaceId: string,
  options: AsanaRequestOptions,
  trace: AsanaRequestTrace,
): Promise<Project> {
  try {
    return await executor.read(
      ProjectSchema,
      options,
      async (resources) =>
        resources.projects.getProjectWithHttpInfo(teamspaceId, {
          opt_fields: PROJECT_FIELDS,
        }),
      trace,
    );
  } catch (error) {
    if (error instanceof CommandError && error.code === "not_found") {
      throw new CommandError(
        "invalid_teamspace",
        "The Teamspace project was not found or is not accessible",
        {
          ...(error.details === undefined ? {} : { details: error.details }),
          asanaRequestIds: [...error.asanaRequestIds],
          cause: error,
        },
      );
    }
    throw error;
  }
}

async function collectCustomFieldSettings(
  executor: AsanaRequestExecutorPort,
  teamspaceId: string,
  options: AsanaRequestOptions,
  trace: AsanaRequestTrace,
): Promise<CustomFieldSetting[]> {
  return collectPages({
    loadPage: async (pageSize, offset) => {
      const page = await executor.readPage(
        CustomFieldSettingSchema,
        options,
        async (resources) =>
          ensureHttpResult(
            await resources.customFieldSettings.getCustomFieldSettingsForProjectWithHttpInfo(
              teamspaceId,
              {
                limit: pageSize,
                ...(offset === undefined ? {} : { offset }),
                opt_fields: CUSTOM_FIELD_SETTING_FIELDS,
              },
            ),
          ),
        trace,
      );
      return {
        items: page.items,
        ...(page.nextPageOffset === null ? {} : { nextOffset: page.nextPageOffset }),
      };
    },
  });
}

async function collectCustomTypes(
  executor: AsanaRequestExecutorPort,
  teamspaceId: string,
  options: AsanaRequestOptions,
  trace: AsanaRequestTrace,
): Promise<CustomType[]> {
  return collectPages({
    loadPage: async (pageSize, offset) => {
      const page = await executor.readPage(
        CustomTypeSchema,
        options,
        async (resources) =>
          ensureHttpResult(
            await resources.customTypes.getCustomTypesWithHttpInfo({
              project: teamspaceId,
              limit: pageSize,
              ...(offset === undefined ? {} : { offset }),
              opt_fields: CUSTOM_TYPE_FIELDS,
            }),
          ),
        trace,
      );
      return {
        items: page.items,
        ...(page.nextPageOffset === null ? {} : { nextOffset: page.nextPageOffset }),
      };
    },
  });
}

function projectCustomFieldValue(project: Project, fieldGid: string): CustomField | undefined {
  return project.custom_fields?.find((field) => field.gid === fieldGid);
}

async function loadReleases(
  executor: AsanaRequestExecutorPort,
  project: Project,
  releasesField: FieldDefinition,
  options: AsanaRequestOptions,
  trace: AsanaRequestTrace,
): Promise<ReleaseReference[]> {
  const releasesValue = projectCustomFieldValue(project, releasesField.gid);
  const references = releasesValue?.reference_value ?? [];
  const releases: ReleaseReference[] = [];

  for (const reference of references) {
    const releaseProject = await executor.read(
      ReleaseProjectSchema,
      options,
      async (resources) =>
        resources.projects.getProjectWithHttpInfo(reference.gid, {
          opt_fields: DISCOVERY_RELEASE_FIELDS,
        }),
      trace,
    );

    releases.push({
      gid: releaseProject.gid,
      name: releaseProject.name,
      due_on: releaseProject.due_on ?? null,
      completed: releaseProject.completed ?? false,
      current_status_update: releaseProject.current_status_update ?? null,
    });
  }

  return releases;
}

export async function discoverTeamspaceSchema(
  executor: AsanaRequestExecutorPort,
  teamspaceId: string,
  options: AsanaRequestOptions,
  trace: AsanaRequestTrace = executor.createTrace(),
): Promise<DiscoveryResult> {
  const project = await readTeamspaceProject(executor, teamspaceId, options, trace);
  const [customFieldSettings, customTypes] = await Promise.all([
    collectCustomFieldSettings(executor, teamspaceId, options, trace),
    collectCustomTypes(executor, teamspaceId, options, trace),
  ]);

  const customFields = customFieldSettings.map((setting) => setting.custom_field);
  const ticketCustomType = resolveTicketCustomType(customTypes);

  const shortIdField = requireExactlyOne(
    customFields.filter((field) => field.representation_type === "custom_id"),
    "short-ID",
    fieldCandidate,
  );
  const labelsField = requireExactlyOne(
    customFields.filter(
      (field) => matchesName(field, "Labels") && field.resource_subtype === "multi_enum",
    ),
    "Labels",
    fieldCandidate,
  );
  const releasesField = requireExactlyOne(
    customFields.filter(
      (field) => matchesName(field, "Releases") && field.resource_subtype === "reference",
    ),
    "Releases",
    fieldCandidate,
  );
  const predictedStartField = resolveFieldByStrategies(customFields, "predicted start date", [
    (field) => matchesAsanaCreatedField(field, ASANA_DEV_PREDICTED_START_DATE, "date"),
    (field) => field.resource_subtype === "date" && matchesPredictedStartFallback(field),
  ]);
  const predictedCompletionField = resolveFieldByStrategies(
    customFields,
    "predicted completion date",
    [
      (field) => matchesAsanaCreatedField(field, ASANA_DEV_PREDICTED_COMPLETION_DATE, "date"),
      (field) => field.resource_subtype === "date" && matchesPredictedCompletionFallback(field),
    ],
  );

  const ticketTypeField = resolveOptionalTicketTypeField(customFields);
  const warnings = [ENGLISH_HEURISTICS_WARNING];
  if (ticketTypeField === null) {
    warnings.push(MISSING_TICKET_TYPE_WARNING);
  }

  const ticketShortIdField = toShortIdFieldDefinition(shortIdField);
  const labelsFieldDefinition = toFieldDefinition(labelsField);
  const releasesFieldDefinition = toFieldDefinition(releasesField);
  const predictedStartFieldDefinition = toFieldDefinition(predictedStartField);
  const predictedCompletionFieldDefinition = toFieldDefinition(predictedCompletionField);
  const ticketTypeFieldDefinition =
    ticketTypeField === null ? null : toFieldDefinition(ticketTypeField);

  const releases = await loadReleases(executor, project, releasesFieldDefinition, options, trace);

  const fingerprintFields = [
    ticketShortIdField,
    labelsFieldDefinition,
    predictedStartFieldDefinition,
    predictedCompletionFieldDefinition,
    releasesFieldDefinition,
    ...(ticketTypeFieldDefinition === null ? [] : [ticketTypeFieldDefinition]),
  ];

  const teamspace: TeamspaceReference = {
    gid: project.gid,
    name: project.name,
    url: commandTeamspaceUrl(project.workspace.gid, project.gid),
  };

  const discovery: DiscoveryResult = {
    workspace: project.workspace,
    teamspace,
    ticket_custom_type: {
      gid: ticketCustomType.gid,
      name: ticketCustomType.name,
    },
    ticket_short_id_field: ticketShortIdField,
    ticket_type_field: ticketTypeFieldDefinition,
    labels_field: labelsFieldDefinition,
    predicted_start_date_field: predictedStartFieldDefinition,
    predicted_completion_date_field: predictedCompletionFieldDefinition,
    releases_field: releasesFieldDefinition,
    releases,
    fingerprint: computeDiscoveryFingerprint({
      projectGid: project.gid,
      ticketCustomTypeGid: ticketCustomType.gid,
      fields: fingerprintFields,
      releaseGids: releases.map((release) => release.gid),
    }),
    warnings,
    discovered_at: new Date().toISOString(),
  };

  return DiscoveryResultSchema.parse(discovery);
}

export async function readReferencedReleaseGids(
  executor: AsanaRequestExecutorPort,
  teamspaceId: string,
  releasesFieldGid: string,
  options: AsanaRequestOptions,
  trace: AsanaRequestTrace = executor.createTrace(),
): Promise<string[]> {
  const project = await readTeamspaceProject(executor, teamspaceId, options, trace);
  if (project.custom_fields === undefined) {
    throw new CommandError("schema_drift", "Asana project response omitted custom fields", {
      asanaRequestIds: [...trace.requestIds],
    });
  }
  const releasesValue = projectCustomFieldValue(project, releasesFieldGid);
  if (releasesValue === undefined) {
    throw new CommandError("schema_drift", "Asana project response omitted the Releases field", {
      asanaRequestIds: [...trace.requestIds],
    });
  }
  if (releasesValue.reference_value === undefined) {
    throw new CommandError(
      "schema_drift",
      "Asana project response omitted the Releases reference value",
      {
        asanaRequestIds: [...trace.requestIds],
      },
    );
  }
  return releasesValue.reference_value.map((reference) => reference.gid);
}

export function discoveryToProvenance(discovery: DiscoveryResult): Provenance {
  return ProvenanceSchema.parse({
    workspace: discovery.workspace,
    teamspace: discovery.teamspace,
  });
}

export function resolveEnumOptionName(field: FieldDefinition, optionName: string): FieldOption {
  const normalized = normalizeName(optionName);
  const matches = field.enum_options.filter((option) => normalizeName(option.name) === normalized);

  if (matches.length === 1) {
    const [match] = matches;
    if (match === undefined) {
      throw new CommandError("invalid_input", "Unknown enum option", {
        details: {
          field_gid: field.gid,
          field_name: field.name,
          allowed_option_names: field.enum_options.map((option) => option.name),
        },
      });
    }
    return match;
  }

  const allowedNames = field.enum_options.map((option) => option.name);
  throw new CommandError("invalid_input", "Unknown enum option", {
    details: {
      field_gid: field.gid,
      field_name: field.name,
      allowed_option_names: allowedNames,
      ...(matches.length > 1 ? { ambiguous_matches: matches.map((option) => option.name) } : {}),
    },
  });
}

export function resolveRelease(discovery: DiscoveryResult, identifier: string): ReleaseReference {
  const byGid = discovery.releases.filter((release) => release.gid === identifier);
  if (byGid.length === 1) {
    return byGid[0] as ReleaseReference;
  }
  if (byGid.length > 1) {
    throw new CommandError("unknown_release", "Release identifier is ambiguous", {
      details: {
        identifier,
        known_releases: discovery.releases.map((release) => ({
          gid: release.gid,
          name: release.name,
        })),
      },
    });
  }

  const normalized = normalizeName(identifier);
  const byName = discovery.releases.filter((release) => normalizeName(release.name) === normalized);
  if (byName.length === 1) {
    return byName[0] as ReleaseReference;
  }

  throw new CommandError("unknown_release", "Release was not found in the Teamspace snapshot", {
    details: {
      identifier,
      known_releases: discovery.releases.map((release) => ({
        gid: release.gid,
        name: release.name,
      })),
      ...(byName.length > 1 ? { ambiguous_matches: byName.map((release) => release.name) } : {}),
    },
  });
}

export type SchemaDiscoveryService = {
  discover(teamspaceId: string, deadlineMs: number): Promise<DiscoveryResult>;
};

export function createSchemaDiscoveryService(
  executor: AsanaRequestExecutorPort,
): SchemaDiscoveryService {
  return {
    discover(teamspaceId, deadlineMs) {
      const trace = executor.createTrace();
      return discoverTeamspaceSchema(executor, teamspaceId, { deadlineMs }, trace);
    },
  };
}
