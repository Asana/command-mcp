import type {
  AttachmentsApi,
  CustomFieldSettingsApi,
  CustomTypesApi,
  ProjectsApi,
  StoriesApi,
  TasksApi,
  TypeaheadApi,
  WorkspacesApi,
} from "asana";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FULL_TASK_FIELDS, type Task } from "../src/asana_contracts.js";
import type {
  AsanaHttpResult,
  AsanaRequestExecutorPort,
  AsanaRequestTrace,
  AsanaResourceBundle,
} from "../src/asana_gateway.js";
import type { DiscoveryResult } from "../src/schema_discovery.js";
import { createTicketService, projectTicketView, TicketViewSchema } from "../src/tools/tickets.js";
import { buildDiscoverySnapshot, DEADLINE_MS, TEAMSPACE_ID } from "./helpers/tool_test_helpers.js";

const TICKET_GID = "1700000000000001";

function unexpectedCall(name: string): never {
  throw new Error(`Unexpected call to ${name}`);
}

function createThrowingApi<T extends object>(apiName: string): T {
  const target = { apiClient: {} };
  return new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) {
        return Reflect.get(object, property, receiver);
      }
      if (property === "then") {
        return undefined;
      }
      return (..._args: unknown[]) => unexpectedCall(`${apiName}.${String(property)}`);
    },
  }) as T;
}

type TaskMethods = {
  getTask?: TasksApi["getTaskWithHttpInfo"];
  getTaskForCustomId?: TasksApi["getTaskForCustomIDWithHttpInfo"];
};

function createResourceBundle(methods: TaskMethods): AsanaResourceBundle {
  const tasks = createThrowingApi<TasksApi>("tasks");
  if (methods.getTask !== undefined) {
    tasks.getTaskWithHttpInfo = methods.getTask;
  }
  if (methods.getTaskForCustomId !== undefined) {
    tasks.getTaskForCustomIDWithHttpInfo = methods.getTaskForCustomId;
  }
  return {
    tasks,
    projects: createThrowingApi<ProjectsApi>("projects"),
    stories: createThrowingApi<StoriesApi>("stories"),
    attachments: createThrowingApi<AttachmentsApi>("attachments"),
    customFieldSettings: createThrowingApi<CustomFieldSettingsApi>("customFieldSettings"),
    customTypes: createThrowingApi<CustomTypesApi>("customTypes"),
    typeahead: createThrowingApi<TypeaheadApi>("typeahead"),
    workspaces: createThrowingApi<WorkspacesApi>("workspaces"),
  };
}

function singleResult(data: unknown): AsanaHttpResult {
  return {
    response: { headers: {} },
    data: { data },
  };
}

function createExecutor(
  resources: AsanaResourceBundle,
  traces: AsanaRequestTrace[] = [],
  createdRequestIds: string[] = [],
): AsanaRequestExecutorPort {
  return {
    createTrace: () => {
      const trace = { requestIds: [...createdRequestIds] };
      traces.push(trace);
      return trace;
    },
    read: async (schema, options, callback, trace) => {
      expect(options.deadlineMs).toBe(DEADLINE_MS);
      if (trace !== undefined) {
        traces.push(trace);
      }
      const result = await callback(resources);
      return z.object({ data: schema }).parse(result.data).data;
    },
    write: async () => unexpectedCall("AsanaRequestExecutor.write"),
    readPage: async () => unexpectedCall("AsanaRequestExecutor.readPage"),
  };
}

function task(snapshot: DiscoveryResult, overrides: Partial<Task> = {}): Task {
  return {
    gid: TICKET_GID,
    name: "Keep request IDs together",
    created_at: "2026-07-30T12:34:56.789Z",
    completed: false,
    completed_at: null,
    resource_subtype: "custom",
    notes: "Plain ticket description",
    due_on: "2026-08-15",
    permalink_url: `https://app.asana.com/0/0/${TICKET_GID}`,
    assignee: {
      gid: "1800000000000010",
      name: "Ada Lovelace",
      email: "ada@example.com",
    },
    projects: [{ gid: snapshot.teamspace.gid, name: snapshot.teamspace.name }],
    dependencies: [{ gid: "1700000000000011", name: "Ship request executor" }],
    custom_type: snapshot.ticket_custom_type,
    custom_fields: [],
    ...overrides,
  };
}

describe("ticket resolver", () => {
  it("resolves a numeric GID directly with the full ticket field set", async () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const observed: Array<{ gid: string; options: Record<string, unknown> }> = [];
    const getTask: TasksApi["getTaskWithHttpInfo"] = async (gid, options) => {
      observed.push({ gid, options: options ?? {} });
      return singleResult(task(snapshot));
    };
    const service = createTicketService(createExecutor(createResourceBundle({ getTask })));

    await expect(service.resolve(TICKET_GID, snapshot, DEADLINE_MS)).resolves.toMatchObject({
      gid: TICKET_GID,
    });
    expect(observed).toEqual([{ gid: TICKET_GID, options: { opt_fields: FULL_TASK_FIELDS } }]);
  });

  it("resolves a short ID through the discovered workspace before the authoritative read", async () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const lookupCalls: string[][] = [];
    const getTaskForCustomId: TasksApi["getTaskForCustomIDWithHttpInfo"] = async (
      workspaceGid,
      customId,
    ) => {
      lookupCalls.push([workspaceGid, customId]);
      return singleResult({ gid: TICKET_GID });
    };
    const getTask: TasksApi["getTaskWithHttpInfo"] = async () => singleResult(task(snapshot));
    const service = createTicketService(
      createExecutor(createResourceBundle({ getTask, getTaskForCustomId })),
    );

    await service.resolve("ENG_2-42", snapshot, DEADLINE_MS);

    expect(lookupCalls).toEqual([[snapshot.workspace.gid, "ENG_2-42"]]);
  });

  it("takes the last numeric segment from an Asana task URL with trailing segments", async () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const observedGids: string[] = [];
    const getTask: TasksApi["getTaskWithHttpInfo"] = async (gid) => {
      observedGids.push(gid);
      return singleResult(task(snapshot));
    };
    const service = createTicketService(createExecutor(createResourceBundle({ getTask })));

    await service.resolve(
      `https://app.asana.com/0/123456789/${TICKET_GID}/f/overview`,
      snapshot,
      DEADLINE_MS,
    );

    expect(observedGids).toEqual([TICKET_GID]);
  });

  it("rejects a task outside the selected Teamspace", async () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const trace: AsanaRequestTrace = { requestIds: ["scope-request"] };
    const getTask: TasksApi["getTaskWithHttpInfo"] = async () =>
      singleResult(
        task(snapshot, {
          projects: [{ gid: "1600000000000099", name: "Different Teamspace" }],
        }),
      );
    const service = createTicketService(createExecutor(createResourceBundle({ getTask })));

    await expect(
      service.resolve(TICKET_GID, snapshot, DEADLINE_MS, { trace }),
    ).rejects.toMatchObject({
      code: "out_of_scope",
      asanaRequestIds: ["scope-request"],
    });
  });

  it("rejects an ordinary task inside the selected Teamspace", async () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const getTask: TasksApi["getTaskWithHttpInfo"] = async () =>
      singleResult(task(snapshot, { resource_subtype: "default_task", custom_type: null }));
    const service = createTicketService(createExecutor(createResourceBundle({ getTask })));

    await expect(service.resolve(TICKET_GID, snapshot, DEADLINE_MS)).rejects.toMatchObject({
      code: "schema_incompatible",
    });
  });

  it("rejects an unparseable identifier before using Asana", async () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const service = createTicketService(createExecutor(createResourceBundle({}), []));

    await expect(service.resolve("not a ticket", snapshot, DEADLINE_MS)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rejects an https URL on a non-Asana host through the shared validator", async () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const service = createTicketService(createExecutor(createResourceBundle({})));

    await expect(
      service.resolve(`https://example.com/0/0/${TICKET_GID}`, snapshot, DEADLINE_MS),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "Asana app URLs must use the app.asana.com host",
    });
  });

  it("lets relaxed identity accept an untyped task", async () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const getTask: TasksApi["getTaskWithHttpInfo"] = async () =>
      singleResult(task(snapshot, { resource_subtype: "default_task", custom_type: null }));
    const service = createTicketService(createExecutor(createResourceBundle({ getTask })));

    await expect(
      service.resolve(TICKET_GID, snapshot, DEADLINE_MS, { allowMissingCustomType: true }),
    ).resolves.toMatchObject({ gid: TICKET_GID, custom_type: null });
  });

  it("does not let relaxed identity accept a different custom type", async () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const getTask: TasksApi["getTaskWithHttpInfo"] = async () =>
      singleResult(
        task(snapshot, {
          custom_type: { gid: "1800000000000099", name: "Different type" },
        }),
      );
    const service = createTicketService(createExecutor(createResourceBundle({ getTask })));

    await expect(
      service.resolve(TICKET_GID, snapshot, DEADLINE_MS, { allowMissingCustomType: true }),
    ).rejects.toMatchObject({ code: "schema_incompatible" });
  });

  it("supports a direct GID read in an existing request trace", async () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const trace: AsanaRequestTrace = { requestIds: ["schema-request"] };
    const observedTraces: AsanaRequestTrace[] = [];
    const getTask: TasksApi["getTaskWithHttpInfo"] = async () => singleResult(task(snapshot));
    const service = createTicketService(
      createExecutor(createResourceBundle({ getTask }), observedTraces),
    );

    await service.readByGid(TICKET_GID, DEADLINE_MS, trace);

    expect(observedTraces).toContain(trace);
  });

  it("preserves request IDs when a read cannot be projected safely", async () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const getTask: TasksApi["getTaskWithHttpInfo"] = async () =>
      singleResult(task(snapshot, { due_on: "2026-02-30" }));
    const service = createTicketService(
      createExecutor(createResourceBundle({ getTask }), [], ["view-request"]),
    );

    await expect(service.readTicket(TICKET_GID, snapshot, DEADLINE_MS)).rejects.toMatchObject({
      code: "schema_drift",
      asanaRequestIds: ["view-request"],
    });
  });
});

function richTask(snapshot: DiscoveryResult): Task {
  snapshot.ticket_type_field = {
    gid: "1900000000000010",
    name: "Ticket type",
    resource_subtype: "enum",
    enum_options: [{ gid: "1900000000000011", name: "Feature" }],
  };
  snapshot.labels_field.enum_options = [
    { gid: "1900000000000012", name: "Customer" },
    { gid: "1900000000000013", name: "Urgent" },
  ];
  return task(snapshot, {
    completed: true,
    completed_at: "2026-07-31T08:00:00.000Z",
    custom_fields: [
      {
        gid: snapshot.ticket_short_id_field.gid,
        name: "Short ID",
        resource_subtype: "text",
        custom_id_value: "ENG-42",
        display_value: "ENG-0042",
      },
      {
        gid: snapshot.ticket_type_field.gid,
        name: "Ticket type",
        resource_subtype: "enum",
        enum_value: { gid: "1900000000000011", name: "Feature" },
      },
      {
        gid: snapshot.labels_field.gid,
        name: "Labels",
        resource_subtype: "multi_enum",
        multi_enum_values: [
          { gid: "1900000000000012", name: "Customer" },
          { gid: "1900000000000013", name: "Urgent" },
        ],
      },
      {
        gid: snapshot.predicted_start_date_field.gid,
        name: "Predicted start",
        resource_subtype: "date",
        date_value: { date: "2026-08-01", date_time: null },
      },
      {
        gid: snapshot.predicted_completion_date_field.gid,
        name: "Predicted completion",
        resource_subtype: "date",
        date_value: { date: null, date_time: "2026-08-10T17:00:00.000Z" },
      },
    ],
  });
}

describe("ticket view", () => {
  it("maps every field using discovered field GIDs", () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const source = richTask(snapshot);

    const view = projectTicketView(source, snapshot);

    expect(view).toEqual({
      gid: TICKET_GID,
      short_id: "ENG-42",
      name: "Keep request IDs together",
      description: "Plain ticket description",
      created_at: "2026-07-30T12:34:56.789Z",
      completed: true,
      completed_at: "2026-07-31T08:00:00.000Z",
      type: "Feature",
      labels: ["Customer", "Urgent"],
      assignee: {
        gid: "1800000000000010",
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
      due_on: "2026-08-15",
      predicted_start_on: "2026-08-01",
      predicted_completion_on: "2026-08-10",
      dependencies: [{ gid: "1700000000000011", name: "Ship request executor" }],
      url: `https://app.asana.com/0/0/${TICKET_GID}`,
    });
    expect(TicketViewSchema.parse(view)).toEqual(view);
  });

  it("falls back from the custom-ID value to its display value", () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const source = richTask(snapshot);
    const shortIdField = source.custom_fields?.find(
      (field) => field.gid === snapshot.ticket_short_id_field.gid,
    );
    if (shortIdField === undefined) {
      throw new Error("Missing short-ID fixture");
    }
    shortIdField.custom_id_value = null;

    expect(projectTicketView(source, snapshot).short_id).toBe("ENG-0042");
  });

  it("returns null type when the snapshot has no ticket type field", () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    expect(projectTicketView(task(snapshot), snapshot).type).toBeNull();
  });

  it("uses an empty description when notes are absent", () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    expect(projectTicketView(task(snapshot, { notes: undefined }), snapshot).description).toBe("");
  });

  it("omits absent optional dependency names and assignee emails", () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    const source = task(snapshot, {
      dependencies: [{ gid: "1700000000000011" }],
      assignee: { gid: "1800000000000010", name: "Ada Lovelace" },
    });

    const view = projectTicketView(source, snapshot);

    expect(view.dependencies).toEqual([{ gid: "1700000000000011" }]);
    expect(view.dependencies[0]).not.toHaveProperty("name");
    expect(view.assignee).toEqual({ gid: "1800000000000010", name: "Ada Lovelace" });
    expect(view.assignee).not.toHaveProperty("email");
  });
});
