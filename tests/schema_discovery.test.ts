import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  AsanaHttpResult,
  AsanaRequestExecutorPort,
  AsanaRequestOptions,
  AsanaRequestTrace,
} from "../src/asana_gateway.js";
import { CommandError } from "../src/errors.js";
import {
  computeDiscoveryFingerprint,
  discoverTeamspaceSchema,
  type FieldDefinition,
  readReferencedReleaseGids,
} from "../src/schema_discovery.js";

const TEAMSPACE_ID = "1600000000000001";
const WORKSPACE = { gid: "1500000000000001", name: "Command Workspace" };
const DEADLINE_MS = 2_000_000;

function deadlineAfter(budgetMs: number): number {
  return DEADLINE_MS + budgetMs;
}

function unusedMethod(name: string): never {
  throw new Error(`Unexpected call to ${name}`);
}

type ProjectResponse = {
  gid: string;
  name: string;
  workspace: { gid: string; name: string };
  custom_fields?: Array<{
    gid: string;
    name: string;
    resource_subtype: string;
    type?: string;
    representation_type?: string;
    asana_created_field?: string | null;
    id_prefix?: string | null;
    enum_options?: Array<{ gid: string; name: string; enabled?: boolean }>;
    multi_enum_options?: Array<{ gid: string; name: string; enabled?: boolean }>;
    reference_value?: Array<{ gid: string; name: string; resource_type?: string }>;
  }>;
};

type CustomFieldSettingResponse = {
  gid?: string;
  custom_field: ProjectResponse["custom_fields"] extends Array<infer T> | undefined ? T : never;
};

type CustomTypeResponse = { gid: string; name: string };

type ReleaseProjectResponse = {
  gid: string;
  name: string;
  completed?: boolean;
  due_on?: string | null;
  current_status_update?: { gid: string; title?: string; text?: string } | null;
};

type FakeState = {
  project: ProjectResponse;
  customFieldSettings: CustomFieldSettingResponse[];
  customTypes: CustomTypeResponse[];
  releaseProjects: Record<string, ReleaseProjectResponse>;
  projectReads: number;
};

function httpResult(data: unknown): AsanaHttpResult {
  return { response: { headers: {} }, data };
}

function createFakeExecutor(state: FakeState): AsanaRequestExecutorPort {
  const trace: AsanaRequestTrace = { requestIds: [] };

  return {
    createTrace: () => trace,
    read: async (schema, _options, callback) => {
      const resources = {
        projects: {
          getProjectWithHttpInfo: async (projectGid: string) => {
            state.projectReads += 1;
            if (projectGid === state.project.gid) {
              return httpResult({ data: state.project });
            }
            const release = state.releaseProjects[projectGid];
            if (release === undefined) {
              const error = Object.assign(new Error("not found"), { status: 404 });
              throw error;
            }
            return httpResult({ data: release });
          },
        },
      };
      const result = await callback(resources as never);
      const envelope = z.object({ data: schema });
      return envelope.parse(result.data).data;
    },
    write: async () => unusedMethod("write"),
    readPage: async (schema, _options, callback) => {
      const resources = {
        customFieldSettings: {
          getCustomFieldSettingsForProjectWithHttpInfo: async (
            _projectGid: string,
            opts?: { offset?: string },
          ) => {
            const offset = opts?.offset ?? "0";
            if (offset !== "0") {
              return httpResult({ data: [], next_page: null });
            }
            return httpResult({
              data: state.customFieldSettings,
              next_page: null,
            });
          },
        },
        customTypes: {
          getCustomTypesWithHttpInfo: async (_projectGid: string, opts?: { offset?: string }) => {
            const offset = opts?.offset ?? "0";
            if (offset !== "0") {
              return httpResult({ data: [], next_page: null });
            }
            return httpResult({
              data: state.customTypes,
              next_page: null,
            });
          },
        },
      };
      const result = await callback(resources as never);
      const envelope = z.object({
        data: z.array(schema),
        next_page: z
          .object({
            offset: z.string(),
          })
          .nullable()
          .optional(),
      });
      const parsed = envelope.parse(result.data);
      return {
        items: parsed.data,
        nextPageOffset: parsed.next_page?.offset ?? null,
      };
    },
  };
}

function shortIdField(overrides: Partial<CustomFieldSettingResponse["custom_field"]> = {}) {
  return {
    gid: "1200000000000001",
    name: "Ticket ID",
    resource_subtype: "text",
    type: "text",
    representation_type: "custom_id",
    id_prefix: "CMD",
    ...overrides,
  };
}

function labelsField(overrides: Partial<CustomFieldSettingResponse["custom_field"]> = {}) {
  return {
    gid: "1200000000000002",
    name: "Labels",
    resource_subtype: "multi_enum",
    type: "multi_enum",
    multi_enum_options: [
      { gid: "1200000000000101", name: "Bug", enabled: true },
      { gid: "1200000000000102", name: "Feature", enabled: true },
    ],
    ...overrides,
  };
}

function releasesField(
  references: Array<{ gid: string; name: string }>,
  overrides: Partial<CustomFieldSettingResponse["custom_field"]> = {},
) {
  return {
    gid: "1200000000000003",
    name: "Releases",
    resource_subtype: "reference",
    type: "reference",
    reference_value: references.map((reference) => ({
      ...reference,
      resource_type: "project",
    })),
    ...overrides,
  };
}

function predictedStartField(overrides: Partial<CustomFieldSettingResponse["custom_field"]> = {}) {
  return {
    gid: "1200000000000004",
    name: "Predicted start",
    resource_subtype: "date",
    type: "date",
    asana_created_field: "ASANA_DEV_PREDICTED_START_DATE",
    ...overrides,
  };
}

function predictedCompletionField(
  overrides: Partial<CustomFieldSettingResponse["custom_field"]> = {},
) {
  return {
    gid: "1200000000000005",
    name: "Predicted completion",
    resource_subtype: "date",
    type: "date",
    asana_created_field: "ASANA_DEV_PREDICTED_COMPLETION_DATE",
    ...overrides,
  };
}

function ticketTypeField(overrides: Partial<CustomFieldSettingResponse["custom_field"]> = {}) {
  return {
    gid: "1200000000000006",
    name: "Type",
    resource_subtype: "enum",
    type: "enum",
    asana_created_field: "dev_ticket_type",
    enum_options: [
      { gid: "1200000000000201", name: "Feature", enabled: true },
      { gid: "1200000000000202", name: "Bug", enabled: true },
      { gid: "1200000000000203", name: "Task", enabled: true },
    ],
    ...overrides,
  };
}

function completeTeamspaceState(
  overrides: {
    customFieldSettings?: CustomFieldSettingResponse[];
    customTypes?: CustomTypeResponse[];
    releaseProjects?: Record<string, ReleaseProjectResponse>;
    projectCustomFields?: ProjectResponse["custom_fields"];
  } = {},
): FakeState {
  const releaseOne = { gid: "1700000000000001", name: "Release One" };
  const releaseTwo = { gid: "1700000000000002", name: "Release Two" };
  const fieldDefinitions = overrides.customFieldSettings ?? [
    { custom_field: shortIdField() },
    { custom_field: labelsField() },
    { custom_field: releasesField([releaseOne, releaseTwo]) },
    { custom_field: predictedStartField() },
    { custom_field: predictedCompletionField() },
    { custom_field: ticketTypeField() },
  ];

  return {
    project: {
      gid: TEAMSPACE_ID,
      name: "Command Teamspace",
      workspace: WORKSPACE,
      custom_fields:
        overrides.projectCustomFields ?? fieldDefinitions.map((entry) => entry.custom_field),
    },
    customFieldSettings: fieldDefinitions,
    customTypes: overrides.customTypes ?? [{ gid: "1800000000000001", name: "Dev ticket" }],
    releaseProjects: overrides.releaseProjects ?? {
      [releaseOne.gid]: {
        gid: releaseOne.gid,
        name: releaseOne.name,
        completed: false,
        due_on: "2026-08-01",
        current_status_update: { gid: "1900000000000001", title: "On track" },
      },
      [releaseTwo.gid]: {
        gid: releaseTwo.gid,
        name: releaseTwo.name,
        completed: true,
        due_on: null,
        current_status_update: null,
      },
    },
    projectReads: 0,
  };
}

const requestOptions: AsanaRequestOptions = { deadlineMs: deadlineAfter(10_000) };

describe("discoverTeamspaceSchema", () => {
  it("resolves every required field for a complete Teamspace", async () => {
    const state = completeTeamspaceState();
    const discovery = await discoverTeamspaceSchema(
      createFakeExecutor(state),
      TEAMSPACE_ID,
      requestOptions,
    );

    expect(discovery.teamspace.gid).toBe(TEAMSPACE_ID);
    expect(discovery.teamspace.url).toBe(
      `https://app.asana.com/1/${WORKSPACE.gid}/dev/space/${TEAMSPACE_ID}`,
    );
    expect(discovery.ticket_custom_type.name).toBe("Dev ticket");
    expect(discovery.ticket_short_id_field.id_prefix).toBe("CMD");
    expect(discovery.ticket_type_field?.gid).toBe("1200000000000006");
    expect(discovery.labels_field.name).toBe("Labels");
    expect(discovery.releases).toHaveLength(2);
    expect(discovery.releases[0]?.name).toBe("Release One");
    expect(discovery.warnings).toContain(
      "Discovery relies on English-language field and option heuristics in this beta.",
    );
    expect(discovery.fingerprint).toHaveLength(16);
  });

  it("returns null ticket type plus a warning when the field is missing", async () => {
    const state = completeTeamspaceState({
      customFieldSettings: [
        { custom_field: shortIdField() },
        { custom_field: labelsField() },
        { custom_field: releasesField([]) },
        { custom_field: predictedStartField() },
        { custom_field: predictedCompletionField() },
      ],
      projectCustomFields: [
        shortIdField(),
        labelsField(),
        releasesField([]),
        predictedStartField(),
        predictedCompletionField(),
      ],
    });

    const discovery = await discoverTeamspaceSchema(
      createFakeExecutor(state),
      TEAMSPACE_ID,
      requestOptions,
    );

    expect(discovery.ticket_type_field).toBeNull();
    expect(discovery.warnings).toContain(
      "Ticket type field was not found; type reads return null and type filters and type mutations are unavailable.",
    );
  });

  it("throws schema_ambiguous when two fields match the same role", async () => {
    const state = completeTeamspaceState({
      customFieldSettings: [
        { custom_field: shortIdField({ gid: "1200000000000091" }) },
        { custom_field: shortIdField({ gid: "1200000000000092", name: "Other Ticket ID" }) },
        { custom_field: labelsField() },
        { custom_field: releasesField([]) },
        { custom_field: predictedStartField() },
        { custom_field: predictedCompletionField() },
      ],
    });

    await expect(
      discoverTeamspaceSchema(createFakeExecutor(state), TEAMSPACE_ID, requestOptions),
    ).rejects.toMatchObject({
      code: "schema_ambiguous",
      details: {
        candidates: expect.arrayContaining([
          { gid: "1200000000000091", name: "Ticket ID" },
          { gid: "1200000000000092", name: "Other Ticket ID" },
        ]),
      },
    });
  });

  it("throws schema_incompatible when the short-ID field is missing", async () => {
    const state = completeTeamspaceState({
      customFieldSettings: [
        { custom_field: labelsField() },
        { custom_field: releasesField([]) },
        { custom_field: predictedStartField() },
        { custom_field: predictedCompletionField() },
      ],
    });

    await expect(
      discoverTeamspaceSchema(createFakeExecutor(state), TEAMSPACE_ID, requestOptions),
    ).rejects.toMatchObject({ code: "schema_incompatible" });
  });

  it("throws invalid_teamspace when the project read is not found", async () => {
    const state = completeTeamspaceState();
    const executor = createFakeExecutor(state);
    executor.read = async () => {
      throw new CommandError("not_found", "The requested Asana resource was not found");
    };

    await expect(
      discoverTeamspaceSchema(executor, TEAMSPACE_ID, requestOptions),
    ).rejects.toMatchObject({ code: "invalid_teamspace" });
  });

  it("excludes options marked not enabled from resolved field definitions", async () => {
    const state = completeTeamspaceState({
      customFieldSettings: [
        { custom_field: shortIdField() },
        {
          custom_field: labelsField({
            multi_enum_options: [
              { gid: "1200000000000101", name: "Bug", enabled: true },
              { gid: "1200000000000102", name: "Retired", enabled: false },
            ],
          }),
        },
        { custom_field: releasesField([]) },
        { custom_field: predictedStartField() },
        { custom_field: predictedCompletionField() },
      ],
    });

    const discovery = await discoverTeamspaceSchema(
      createFakeExecutor(state),
      TEAMSPACE_ID,
      requestOptions,
    );

    expect(discovery.labels_field.enum_options).toEqual([{ gid: "1200000000000101", name: "Bug" }]);
  });

  it("uses multi_enum_options when enum_options is an empty array on a multi_enum field", async () => {
    const state = completeTeamspaceState({
      customFieldSettings: [
        { custom_field: shortIdField() },
        {
          custom_field: labelsField({
            enum_options: [],
            multi_enum_options: [
              { gid: "1200000000000101", name: "Bug", enabled: true },
              { gid: "1200000000000102", name: "Feature", enabled: true },
            ],
          }),
        },
        { custom_field: releasesField([]) },
        { custom_field: predictedStartField() },
        { custom_field: predictedCompletionField() },
        { custom_field: ticketTypeField() },
      ],
      projectCustomFields: [
        shortIdField(),
        labelsField({
          enum_options: [],
          multi_enum_options: [
            { gid: "1200000000000101", name: "Bug", enabled: true },
            { gid: "1200000000000102", name: "Feature", enabled: true },
          ],
        }),
        releasesField([]),
        predictedStartField(),
        predictedCompletionField(),
        ticketTypeField(),
      ],
    });

    const discovery = await discoverTeamspaceSchema(
      createFakeExecutor(state),
      TEAMSPACE_ID,
      requestOptions,
    );

    expect(discovery.labels_field.enum_options).toEqual([
      { gid: "1200000000000101", name: "Bug" },
      { gid: "1200000000000102", name: "Feature" },
    ]);
  });

  it("does not treat an enum superset as the ticket type field", async () => {
    const state = completeTeamspaceState({
      customFieldSettings: [
        { custom_field: shortIdField() },
        { custom_field: labelsField() },
        { custom_field: releasesField([]) },
        { custom_field: predictedStartField() },
        { custom_field: predictedCompletionField() },
        {
          custom_field: {
            gid: "1200000000000099",
            name: "Priority",
            resource_subtype: "enum",
            type: "enum",
            enum_options: [
              { gid: "1200000000000301", name: "Feature", enabled: true },
              { gid: "1200000000000302", name: "Bug", enabled: true },
              { gid: "1200000000000303", name: "Task", enabled: true },
              { gid: "1200000000000304", name: "Chore", enabled: true },
            ],
          },
        },
      ],
      projectCustomFields: [
        shortIdField(),
        labelsField(),
        releasesField([]),
        predictedStartField(),
        predictedCompletionField(),
        {
          gid: "1200000000000099",
          name: "Priority",
          resource_subtype: "enum",
          type: "enum",
          enum_options: [
            { gid: "1200000000000301", name: "Feature", enabled: true },
            { gid: "1200000000000302", name: "Bug", enabled: true },
            { gid: "1200000000000303", name: "Task", enabled: true },
            { gid: "1200000000000304", name: "Chore", enabled: true },
          ],
        },
      ],
    });

    const discovery = await discoverTeamspaceSchema(
      createFakeExecutor(state),
      TEAMSPACE_ID,
      requestOptions,
    );

    expect(discovery.ticket_type_field).toBeNull();
    expect(discovery.warnings).toContain(
      "Ticket type field was not found; type reads return null and type filters and type mutations are unavailable.",
    );
  });
});

describe("computeDiscoveryFingerprint", () => {
  const baseField = (overrides: Partial<FieldDefinition> = {}): FieldDefinition => ({
    gid: "1200000000000001",
    name: "Ticket ID",
    resource_subtype: "text",
    representation_type: "custom_id",
    enum_options: [],
    ...overrides,
  });

  it("is unchanged when fields are provided in a different order", () => {
    const first = computeDiscoveryFingerprint({
      projectGid: "1600000000000001",
      ticketCustomTypeGid: "1800000000000001",
      fields: [baseField({ gid: "1", name: "A" }), baseField({ gid: "2", name: "B" })],
      releaseGids: ["9", "8"],
    });
    const second = computeDiscoveryFingerprint({
      projectGid: "1600000000000001",
      ticketCustomTypeGid: "1800000000000001",
      fields: [baseField({ gid: "2", name: "B" }), baseField({ gid: "1", name: "A" })],
      releaseGids: ["8", "9"],
    });

    expect(first).toBe(second);
  });

  it("changes when an option name changes", () => {
    const unchanged = computeDiscoveryFingerprint({
      projectGid: "1600000000000001",
      ticketCustomTypeGid: "1800000000000001",
      fields: [
        baseField({
          gid: "3",
          name: "Type",
          enum_options: [{ gid: "10", name: "Feature" }],
        }),
      ],
      releaseGids: [],
    });
    const changed = computeDiscoveryFingerprint({
      projectGid: "1600000000000001",
      ticketCustomTypeGid: "1800000000000001",
      fields: [
        baseField({
          gid: "3",
          name: "Type",
          enum_options: [{ gid: "10", name: "Bug" }],
        }),
      ],
      releaseGids: [],
    });

    expect(unchanged).not.toBe(changed);
  });
});

describe("readReferencedReleaseGids", () => {
  it("reads each referenced Release from the project and reflects current state", async () => {
    const release = { gid: "1700000000000001", name: "Release One" };
    const state = completeTeamspaceState({
      projectCustomFields: [
        shortIdField(),
        labelsField(),
        releasesField([release]),
        predictedStartField(),
        predictedCompletionField(),
        ticketTypeField(),
      ],
    });

    const executor = createFakeExecutor(state);
    const releasesFieldGid = "1200000000000003";

    const initial = await readReferencedReleaseGids(
      executor,
      TEAMSPACE_ID,
      releasesFieldGid,
      requestOptions,
    );
    expect(initial).toEqual([release.gid]);

    state.project.custom_fields = [
      shortIdField(),
      labelsField(),
      releasesField([release, { gid: "1700000000000003", name: "Release Three" }]),
      predictedStartField(),
      predictedCompletionField(),
      ticketTypeField(),
    ];

    const updated = await readReferencedReleaseGids(
      executor,
      TEAMSPACE_ID,
      releasesFieldGid,
      requestOptions,
    );
    expect(updated).toEqual([release.gid, "1700000000000003"]);
    expect(state.projectReads).toBeGreaterThan(1);
  });

  it("fails closed when the Releases reference value is omitted", async () => {
    const releasesFieldGid = "1200000000000003";
    const state = completeTeamspaceState({
      projectCustomFields: [
        {
          gid: releasesFieldGid,
          name: "Releases",
          resource_subtype: "reference",
          type: "reference",
        },
      ],
    });

    await expect(
      readReferencedReleaseGids(
        createFakeExecutor(state),
        TEAMSPACE_ID,
        releasesFieldGid,
        requestOptions,
      ),
    ).rejects.toMatchObject({
      code: "schema_drift",
      message: "Asana project response omitted the Releases reference value",
    });
  });
});
