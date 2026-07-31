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
import type { Task } from "../src/asana_contracts.js";
import type {
  AsanaHttpResult,
  AsanaRequestExecutorPort,
  AsanaRequestTrace,
  AsanaResourceBundle,
} from "../src/asana_gateway.js";
import { CommandError } from "../src/errors.js";
import type { DiscoveryResult } from "../src/schema_discovery.js";
import { PendingInitializationSchema } from "../src/ticket_inputs.js";
import {
  CREATE_PENDING_WARNING,
  createTicketService,
  UPDATE_PENDING_WARNING,
} from "../src/tools/tickets.js";
import { buildDiscoverySnapshot, DEADLINE_MS, TEAMSPACE_ID } from "./helpers/tool_test_helpers.js";

const TASK_GID = "1700000000000001";
const TYPE_FIELD_GID = "1900000000000010";
const FEATURE_GID = "1900000000000011";
const CUSTOMER_GID = "1900000000000012";
const URGENT_GID = "1900000000000013";

function unexpectedCall(name: string): never {
  throw new Error(`Unexpected call to ${name}`);
}

function throwingApi<T extends object>(name: string): T {
  const target = { apiClient: {} };
  return new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) {
        return Reflect.get(object, property, receiver);
      }
      if (property === "then") {
        return undefined;
      }
      return (..._args: unknown[]) => unexpectedCall(`${name}.${String(property)}`);
    },
  }) as T;
}

type TaskMethods = {
  createTask?: TasksApi["createTaskWithHttpInfo"];
  updateTask?: TasksApi["updateTaskWithHttpInfo"];
  getTask?: TasksApi["getTaskWithHttpInfo"];
};

function resources(methods: TaskMethods): AsanaResourceBundle {
  const tasks = throwingApi<TasksApi>("tasks");
  if (methods.createTask !== undefined) {
    tasks.createTaskWithHttpInfo = methods.createTask;
  }
  if (methods.updateTask !== undefined) {
    tasks.updateTaskWithHttpInfo = methods.updateTask;
  }
  if (methods.getTask !== undefined) {
    tasks.getTaskWithHttpInfo = methods.getTask;
  }
  return {
    tasks,
    projects: throwingApi<ProjectsApi>("projects"),
    stories: throwingApi<StoriesApi>("stories"),
    attachments: throwingApi<AttachmentsApi>("attachments"),
    customFieldSettings: throwingApi<CustomFieldSettingsApi>("customFieldSettings"),
    customTypes: throwingApi<CustomTypesApi>("customTypes"),
    typeahead: throwingApi<TypeaheadApi>("typeahead"),
    workspaces: throwingApi<WorkspacesApi>("workspaces"),
  };
}

function result(data: unknown, requestId?: string): AsanaHttpResult {
  return {
    response: { headers: requestId === undefined ? {} : { "x-asana-request-id": requestId } },
    data: { data },
  };
}

function executor(
  bundle: AsanaResourceBundle,
  observed: { reads: number[]; writes: number[]; createTraces: number },
): AsanaRequestExecutorPort {
  async function invoke<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    deadlineMs: number,
    callback: (resources: AsanaResourceBundle) => Promise<AsanaHttpResult>,
    trace: AsanaRequestTrace | undefined,
  ): Promise<z.infer<TSchema>> {
    const response = await callback(bundle);
    const requestId = response.response.headers?.["x-asana-request-id"];
    if (trace !== undefined && typeof requestId === "string") {
      trace.requestIds.push(requestId);
    }
    return z.object({ data: schema }).parse(response.data).data;
  }
  return {
    createTrace: () => {
      observed.createTraces += 1;
      return { requestIds: [] };
    },
    read: async (schema, options, callback, trace) => {
      observed.reads.push(options.deadlineMs);
      return invoke(schema, options.deadlineMs, callback, trace);
    },
    write: async (schema, options, callback, trace) => {
      observed.writes.push(options.deadlineMs);
      return invoke(schema, options.deadlineMs, callback, trace);
    },
    readPage: async () => unexpectedCall("executor.readPage"),
  };
}

function snapshot(): DiscoveryResult {
  const value = buildDiscoverySnapshot(TEAMSPACE_ID);
  value.ticket_type_field = {
    gid: TYPE_FIELD_GID,
    name: "Type",
    resource_subtype: "enum",
    enum_options: [{ gid: FEATURE_GID, name: "Feature" }],
  };
  value.labels_field.enum_options = [
    { gid: CUSTOMER_GID, name: "Customer" },
    { gid: URGENT_GID, name: "Urgent" },
  ];
  return value;
}

function ticket(
  discovered: DiscoveryResult,
  overrides: Partial<Task> = {},
  labels: Array<{ gid: string; name: string }> = [],
): Task {
  return {
    gid: TASK_GID,
    name: "New ticket",
    created_at: "2026-07-31T10:00:00.000Z",
    completed: false,
    completed_at: null,
    resource_subtype: "custom",
    notes: "",
    due_on: null,
    permalink_url: `https://app.asana.com/0/0/${TASK_GID}`,
    assignee: null,
    projects: [{ gid: discovered.teamspace.gid, name: discovered.teamspace.name }],
    dependencies: [],
    custom_type: discovered.ticket_custom_type,
    custom_fields: [
      {
        gid: discovered.ticket_short_id_field.gid,
        name: "Short ID",
        resource_subtype: "text",
        custom_id_value: "ENG-42",
      },
      {
        gid: TYPE_FIELD_GID,
        name: "Type",
        resource_subtype: "enum",
        enum_value: null,
      },
      {
        gid: discovered.labels_field.gid,
        name: "Labels",
        resource_subtype: "multi_enum",
        multi_enum_values: labels,
      },
      {
        gid: discovered.predicted_start_date_field.gid,
        name: "Predicted Start",
        resource_subtype: "date",
        date_value: null,
      },
      {
        gid: discovered.predicted_completion_date_field.gid,
        name: "Predicted Completion",
        resource_subtype: "date",
        date_value: null,
      },
    ],
    ...overrides,
  };
}

function state() {
  return { reads: [] as number[], writes: [] as number[], createTraces: 0 };
}

describe("create ticket mutation", () => {
  it.each([
    [{ name: "New ticket", type: "Unknown" }, "type"],
    [{ name: "New ticket", labels: ["Unknown"] }, "label"],
  ] as const)("rejects an unknown %s before creating a task", async (fields) => {
    const observed = state();
    let creates = 0;
    const service = createTicketService(
      executor(
        resources({
          createTask: async () => {
            creates += 1;
            return result({ gid: TASK_GID });
          },
        }),
        observed,
      ),
    );

    await expect(service.createTicket(fields, snapshot(), DEADLINE_MS)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(creates).toBe(0);
    expect(observed.createTraces).toBe(0);
  });

  it("creates once, waits for initialization, applies deferred fields, and verifies all fields", async () => {
    const discovered = snapshot();
    const observed = state();
    const createBodies: unknown[] = [];
    const updateBodies: unknown[] = [];
    const reads = [
      ticket(discovered),
      ticket(
        discovered,
        {
          notes: "Details",
          due_on: "2026-08-10",
          assignee: { gid: "1800000000000001", name: "Ada", email: "ada@example.com" },
          custom_fields: [
            ...(ticket(discovered).custom_fields ?? []).filter(
              (field) =>
                field.gid !== TYPE_FIELD_GID &&
                field.gid !== discovered.labels_field.gid &&
                field.gid !== discovered.predicted_start_date_field.gid,
            ),
            {
              gid: TYPE_FIELD_GID,
              name: "Type",
              resource_subtype: "enum",
              enum_value: { gid: FEATURE_GID, name: "Feature" },
            },
            {
              gid: discovered.labels_field.gid,
              name: "Labels",
              resource_subtype: "multi_enum",
              multi_enum_values: [{ gid: CUSTOMER_GID, name: "Customer" }],
            },
            {
              gid: discovered.predicted_start_date_field.gid,
              name: "Predicted Start",
              resource_subtype: "date",
              date_value: { date: "2026-08-01", date_time: null },
            },
          ],
        },
      ),
    ];
    let creates = 0;
    const service = createTicketService(
      executor(
        resources({
          createTask: async (body) => {
            creates += 1;
            createBodies.push(body);
            return result({ gid: TASK_GID }, "create-request");
          },
          updateTask: async (body) => {
            updateBodies.push(body);
            return result({ gid: TASK_GID }, "update-request");
          },
          getTask: async () => result(reads.shift() ?? unexpectedCall("extra task read")),
        }),
        observed,
      ),
      { clock: () => 1_000 },
    );

    const mutation = await service.createTicket(
      {
        name: "New ticket",
        description: "Details",
        type: "feature",
        labels: ["customer"],
        assignee: "ada@example.com",
        due_on: "2026-08-10",
        predicted_start_on: "2026-08-01",
      },
      discovered,
      DEADLINE_MS,
    );

    expect(creates).toBe(1);
    expect(createBodies).toEqual([
      {
        data: {
          projects: [discovered.teamspace.gid],
          name: "New ticket",
          notes: "Details",
          assignee: "ada@example.com",
          due_on: "2026-08-10",
        },
      },
    ]);
    expect(updateBodies).toEqual([
      {
        data: {
          name: "New ticket",
          custom_fields: {
            [TYPE_FIELD_GID]: FEATURE_GID,
            [discovered.predicted_start_date_field.gid]: { date: "2026-08-01" },
            [discovered.labels_field.gid]: [CUSTOMER_GID],
          },
        },
      },
    ]);
    expect(mutation).toMatchObject({
      status: "succeeded",
      outcome: "created",
      data: { ticket: { gid: TASK_GID, type: "Feature", labels: ["Customer"] } },
      asana_request_ids: ["create-request", "update-request"],
    });
  });

  it("returns a valid resumable payload when initialization exhausts the bounded budget", async () => {
    const discovered = snapshot();
    const observed = state();
    let now = 100;
    const sleeps: number[] = [];
    let creates = 0;
    const service = createTicketService(
      executor(
        resources({
          createTask: async () => {
            creates += 1;
            return result({ gid: TASK_GID });
          },
          getTask: async () =>
            result(
              ticket(discovered, {
                resource_subtype: "default_task",
                custom_type: null,
              }),
            ),
        }),
        observed,
      ),
      {
        createTimeoutMs: 20,
        pollIntervalMs: 7,
        clock: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    );

    const mutation = await service.createTicket({ name: "New ticket" }, discovered, 1_000);

    expect(creates).toBe(1);
    expect(sleeps).toEqual([7, 7, 6]);
    expect(observed.reads).toEqual([120, 120, 120]);
    expect(mutation).toMatchObject({
      status: "pending",
      outcome: "initialization_pending",
      warnings: [CREATE_PENDING_WARNING],
      data: {
        teamspace_id: discovered.teamspace.gid,
        task_gid: TASK_GID,
        pending_updates: { update_ticket: { name: "New ticket" } },
        retry_with: "update_ticket",
      },
    });
    expect(PendingInitializationSchema.parse(mutation.data)).toEqual(mutation.data);
  });

  it("fails when the created task initializes as a different custom type", async () => {
    const discovered = snapshot();
    const observed = state();
    let creates = 0;
    const service = createTicketService(
      executor(
        resources({
          createTask: async () => {
            creates += 1;
            return result({ gid: TASK_GID });
          },
          getTask: async () =>
            result(
              ticket(discovered, {
                custom_type: { gid: "1800000000000099", name: "Other" },
              }),
            ),
        }),
        observed,
      ),
    );

    await expect(
      service.createTicket({ name: "New ticket" }, discovered, DEADLINE_MS),
    ).rejects.toMatchObject({
      code: "schema_incompatible",
      details: {
        task_gid: TASK_GID,
        observed_custom_type_gid: "1800000000000099",
      },
    });
    expect(creates).toBe(1);
  });

  it("returns pending rather than creating again when deferred updates time out", async () => {
    const discovered = snapshot();
    const observed = state();
    let creates = 0;
    const service = createTicketService(
      executor(
        resources({
          createTask: async () => {
            creates += 1;
            return result({ gid: TASK_GID });
          },
          getTask: async () => result(ticket(discovered)),
          updateTask: async () => {
            throw new CommandError("request_timeout", "timed out");
          },
        }),
        observed,
      ),
      { clock: () => 1_000 },
    );

    const mutation = await service.createTicket(
      { name: "New ticket", type: "Feature" },
      discovered,
      DEADLINE_MS,
    );

    expect(creates).toBe(1);
    expect(mutation).toMatchObject({
      status: "pending",
      data: {
        pending_updates: { update_ticket: { name: "New ticket", type: "Feature" } },
      },
    });
  });
});

describe("update ticket mutation", () => {
  it("returns the caller's fields unchanged while initialization is pending", async () => {
    const discovered = snapshot();
    const observed = state();
    const requested = { description: "", assignee: null };
    const service = createTicketService(
      executor(
        resources({
          getTask: async () =>
            result(
              ticket(discovered, {
                resource_subtype: "default_task",
                custom_type: null,
              }),
            ),
        }),
        observed,
      ),
    );

    const mutation = await service.updateTicket(TASK_GID, requested, discovered, DEADLINE_MS);

    expect(mutation).toMatchObject({
      status: "pending",
      outcome: "initialization_pending",
      warnings: [UPDATE_PENDING_WARNING],
      data: { pending_updates: { update_ticket: requested } },
    });
    expect(observed.writes).toEqual([]);
  });

  it("skips a no-op label write but still performs an authoritative re-read", async () => {
    const discovered = snapshot();
    const observed = state();
    const reads = [
      ticket(discovered, {}, [{ gid: CUSTOMER_GID, name: "Customer" }]),
      ticket(discovered, {}, [{ gid: CUSTOMER_GID, name: "Customer" }]),
    ];
    const service = createTicketService(
      executor(
        resources({
          getTask: async () => result(reads.shift() ?? unexpectedCall("extra task read")),
        }),
        observed,
      ),
    );

    const mutation = await service.updateTicket(
      TASK_GID,
      { labels: { add: ["Customer"], remove: ["Urgent"] } },
      discovered,
      DEADLINE_MS,
    );

    expect(observed.writes).toEqual([]);
    expect(observed.reads).toHaveLength(2);
    expect(mutation).toMatchObject({ status: "succeeded", outcome: "updated" });
  });

  it.each([
    [{ set: ["Urgent"] }, [URGENT_GID]],
    [{ set: [] }, []],
    [{ add: ["Urgent"], remove: ["Customer"] }, [URGENT_GID]],
  ] as const)("maps label update %j to the complete multi-enum value", async (labels, expected) => {
    const discovered = snapshot();
    const observed = state();
    const writes: unknown[] = [];
    const finalLabels = expected.map((gid) => ({
      gid,
      name: gid === URGENT_GID ? "Urgent" : "Customer",
    }));
    const reads = [
      ticket(discovered, {}, [{ gid: CUSTOMER_GID, name: "Customer" }]),
      ticket(discovered, {}, finalLabels),
    ];
    const service = createTicketService(
      executor(
        resources({
          getTask: async () => result(reads.shift() ?? unexpectedCall("extra task read")),
          updateTask: async (body) => {
            writes.push(body);
            return result({ gid: TASK_GID });
          },
        }),
        observed,
      ),
    );

    await service.updateTicket(TASK_GID, { labels }, discovered, DEADLINE_MS);

    expect(writes).toEqual([
      { data: { custom_fields: { [discovered.labels_field.gid]: [...expected] } } },
    ]);
  });

  it("maps nullable clearing values and verifies the authoritative read", async () => {
    const discovered = snapshot();
    const observed = state();
    const writes: unknown[] = [];
    const current = ticket(discovered, {
      due_on: "2026-08-10",
      assignee: { gid: "1800000000000001", name: "Ada" },
    });
    const reads = [current, ticket(discovered)];
    const service = createTicketService(
      executor(
        resources({
          getTask: async () => result(reads.shift() ?? unexpectedCall("extra task read")),
          updateTask: async (body) => {
            writes.push(body);
            return result({ gid: TASK_GID });
          },
        }),
        observed,
      ),
    );

    await service.updateTicket(
      TASK_GID,
      {
        assignee: null,
        due_on: null,
        predicted_start_on: null,
        predicted_completion_on: null,
      },
      discovered,
      DEADLINE_MS,
    );

    expect(writes).toEqual([
      {
        data: {
          assignee: null,
          due_on: null,
          custom_fields: {
            [discovered.predicted_start_date_field.gid]: null,
            [discovered.predicted_completion_date_field.gid]: null,
          },
        },
      },
    ]);
  });

  it("reports exactly every requested field that the post-write read does not confirm", async () => {
    const discovered = snapshot();
    const observed = state();
    const unchanged = ticket(discovered);
    const service = createTicketService(
      executor(
        resources({
          getTask: async () => result(unchanged),
          updateTask: async () => result({ gid: TASK_GID }, "write-request"),
        }),
        observed,
      ),
    );

    await expect(
      service.updateTicket(
        TASK_GID,
        {
          name: "Changed",
          description: "Changed",
          completed: true,
          type: "feature",
          labels: { add: ["Urgent"] },
          assignee: "ada@example.com",
          due_on: "2026-08-10",
          predicted_start_on: "2026-08-11",
          predicted_completion_on: "2026-08-12",
        },
        discovered,
        DEADLINE_MS,
      ),
    ).rejects.toMatchObject({
      code: "asana_api_error",
      details: {
        ticket_gid: TASK_GID,
        mismatched_fields: [
          "name",
          "description",
          "completed",
          "type",
          "labels",
          "assignee",
          "due_on",
          "predicted_start_on",
          "predicted_completion_on",
        ],
      },
      asanaRequestIds: ["write-request"],
    });
  });

  it("verifies canonical type and label casing and an email-address assignee", async () => {
    const discovered = snapshot();
    const observed = state();
    const initial = ticket(discovered);
    const verified = ticket(
      discovered,
      {
        assignee: { gid: "1800000000000001", name: "Ada", email: "ADA@EXAMPLE.COM" },
        custom_fields: [
          ...(initial.custom_fields ?? []).filter(
            (field) => field.gid !== TYPE_FIELD_GID && field.gid !== discovered.labels_field.gid,
          ),
          {
            gid: TYPE_FIELD_GID,
            name: "Type",
            resource_subtype: "enum",
            enum_value: { gid: FEATURE_GID, name: "Feature" },
          },
          {
            gid: discovered.labels_field.gid,
            name: "Labels",
            resource_subtype: "multi_enum",
            multi_enum_values: [{ gid: CUSTOMER_GID, name: "Customer" }],
          },
        ],
      },
    );
    const reads = [initial, verified];
    const service = createTicketService(
      executor(
        resources({
          getTask: async () => result(reads.shift() ?? unexpectedCall("extra task read")),
          updateTask: async () => result({ gid: TASK_GID }),
        }),
        observed,
      ),
    );

    await expect(
      service.updateTicket(
        TASK_GID,
        {
          type: "FEATURE",
          labels: { set: ["CUSTOMER"] },
          assignee: "ada@example.com",
        },
        discovered,
        DEADLINE_MS,
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("fails verification when a removed label remains present", async () => {
    const discovered = snapshot();
    const observed = state();
    const unchanged = ticket(discovered, {}, [{ gid: CUSTOMER_GID, name: "Customer" }]);
    const service = createTicketService(
      executor(
        resources({
          getTask: async () => result(unchanged),
          updateTask: async () => result({ gid: TASK_GID }),
        }),
        observed,
      ),
    );

    await expect(
      service.updateTicket(
        TASK_GID,
        { labels: { remove: ["customer"] } },
        discovered,
        DEADLINE_MS,
      ),
    ).rejects.toMatchObject({
      code: "asana_api_error",
      details: { mismatched_fields: ["labels"] },
    });
  });
});
