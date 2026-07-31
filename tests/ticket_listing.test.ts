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
import {
  COMPACT_SEARCH_TASK_FIELDS,
  collectionEnvelope,
  FULL_TASK_FIELDS,
  type Task,
} from "../src/asana_contracts.js";
import type {
  AsanaHttpResult,
  AsanaRequestExecutorPort,
  AsanaRequestTrace,
  AsanaResourceBundle,
} from "../src/asana_gateway.js";
import type { DiscoveryResult } from "../src/schema_discovery.js";
import { createTicketListingService } from "../src/tools/ticket_listing.js";
import { buildDiscoverySnapshot, DEADLINE_MS, TEAMSPACE_ID } from "./helpers/tool_test_helpers.js";

const RELEASE_GID = "1700000000000099";
const ASSIGNEE_GID = "1800000000000010";

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
  getTasksForProject?: TasksApi["getTasksForProjectWithHttpInfo"];
  searchTasksForWorkspace?: TasksApi["searchTasksForWorkspaceWithHttpInfo"];
};

type WorkspaceSearchOptions = NonNullable<
  Parameters<TasksApi["searchTasksForWorkspaceWithHttpInfo"]>[1]
> & {
  limit?: number;
};

function createResourceBundle(methods: TaskMethods): AsanaResourceBundle {
  const tasks = createThrowingApi<TasksApi>("tasks");
  if (methods.getTasksForProject !== undefined) {
    tasks.getTasksForProjectWithHttpInfo = methods.getTasksForProject;
  }
  if (methods.searchTasksForWorkspace !== undefined) {
    tasks.searchTasksForWorkspaceWithHttpInfo = methods.searchTasksForWorkspace;
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

function pageResult(items: Task[], nextOffset?: string): AsanaHttpResult {
  return {
    response: { headers: {} },
    data: {
      data: items,
      next_page: nextOffset === undefined ? null : { offset: nextOffset },
    },
  };
}

function createExecutor(resources: AsanaResourceBundle): AsanaRequestExecutorPort {
  return {
    createTrace: (): AsanaRequestTrace => ({ requestIds: [] }),
    read: async () => unexpectedCall("AsanaRequestExecutor.read"),
    write: async () => unexpectedCall("AsanaRequestExecutor.write"),
    readPage: async (schema, options, callback) => {
      expect(options.deadlineMs).toBe(DEADLINE_MS);
      const response = await callback(resources);
      const parsed = collectionEnvelope(schema).parse(response.data);
      return {
        items: parsed.data,
        nextPageOffset: parsed.next_page?.offset ?? null,
      };
    },
  };
}

function snapshot(): DiscoveryResult {
  const discovered = buildDiscoverySnapshot(TEAMSPACE_ID);
  return {
    ...discovered,
    ticket_type_field: {
      gid: "1900000000000010",
      name: "Type",
      enum_options: [
        { gid: "1900000000000011", name: "Bug" },
        { gid: "1900000000000012", name: "Feature" },
      ],
    },
    labels_field: {
      ...discovered.labels_field,
      enum_options: [{ gid: "1900000000000013", name: "Customer" }],
    },
    releases: [
      {
        gid: RELEASE_GID,
        name: "August Release",
        due_on: null,
        completed: false,
        current_status_update: null,
      },
    ],
  };
}

function ticket(discovered: DiscoveryResult, gid: string, overrides: Partial<Task> = {}): Task {
  return {
    gid,
    name: `Ticket ${gid}`,
    created_at: `2026-07-30T12:34:${gid.slice(-2)}.000Z`,
    completed: false,
    completed_at: null,
    resource_subtype: "custom",
    notes: "",
    due_on: null,
    permalink_url: `https://app.asana.com/0/0/${gid}`,
    assignee: {
      gid: ASSIGNEE_GID,
      name: "Ada Lovelace",
      email: "ada@example.com",
    },
    projects: [
      { gid: discovered.teamspace.gid, name: discovered.teamspace.name },
      { gid: RELEASE_GID, name: "August Release" },
    ],
    dependencies: [],
    custom_type: discovered.ticket_custom_type,
    custom_fields: [
      {
        gid: discovered.ticket_short_id_field.gid,
        name: discovered.ticket_short_id_field.name,
        resource_subtype: "text",
        custom_id_value: `ENG-${gid.slice(-2)}`,
      },
      {
        gid: discovered.ticket_type_field?.gid ?? "0",
        name: "Type",
        resource_subtype: "enum",
        enum_value: { gid: "1900000000000011", name: "Bug" },
      },
      {
        gid: discovered.labels_field.gid,
        name: discovered.labels_field.name,
        resource_subtype: "multi_enum",
        multi_enum_values: [{ gid: "1900000000000013", name: "Customer" }],
      },
      {
        gid: discovered.predicted_start_date_field.gid,
        name: discovered.predicted_start_date_field.name,
        resource_subtype: "date",
        date_value: null,
      },
      {
        gid: discovered.predicted_completion_date_field.gid,
        name: discovered.predicted_completion_date_field.name,
        resource_subtype: "date",
        date_value: null,
      },
    ],
    ...overrides,
  };
}

describe("ticket listing service", () => {
  it("excludes non-tickets and combines every list filter case-insensitively", async () => {
    const discovered = snapshot();
    const matching = ticket(discovered, "1700000000000001");
    const ordinary = ticket(discovered, "1700000000000002", {
      resource_subtype: "default_task",
      custom_type: null,
    });
    const completed = ticket(discovered, "1700000000000003", {
      completed: true,
      completed_at: "2026-07-31T00:00:00.000Z",
    });
    const wrongType = ticket(discovered, "1700000000000004", {
      custom_fields: ticket(discovered, "1700000000000004").custom_fields?.map((field) =>
        field.gid === discovered.ticket_type_field?.gid
          ? { ...field, enum_value: { gid: "1900000000000012", name: "Feature" } }
          : field,
      ),
    });
    const wrongLabel = ticket(discovered, "1700000000000005", {
      custom_fields: ticket(discovered, "1700000000000005").custom_fields?.map((field) =>
        field.gid === discovered.labels_field.gid ? { ...field, multi_enum_values: [] } : field,
      ),
    });
    const wrongAssignee = ticket(discovered, "1700000000000006", {
      assignee: {
        gid: "1800000000000099",
        name: "Grace Hopper",
        email: "grace@example.com",
      },
    });
    const wrongRelease = ticket(discovered, "1700000000000007", {
      projects: [{ gid: discovered.teamspace.gid, name: discovered.teamspace.name }],
    });
    const observedOptions: Record<string, unknown>[] = [];
    const getTasksForProject: TasksApi["getTasksForProjectWithHttpInfo"] = async (
      projectGid,
      options,
    ) => {
      expect(projectGid).toBe(TEAMSPACE_ID);
      observedOptions.push(options ?? {});
      return pageResult([
        ordinary,
        completed,
        wrongType,
        wrongLabel,
        wrongAssignee,
        wrongRelease,
        matching,
      ]);
    };
    const service = createTicketListingService(
      createExecutor(createResourceBundle({ getTasksForProject })),
      { maxScanTasks: 20 },
    );

    for (const assignee of [ASSIGNEE_GID, "ADA LOVELACE", "ADA@EXAMPLE.COM"]) {
      const result = await service.listTickets(
        {
          completed: false,
          type: "BUG",
          label: "CUSTOMER",
          assignee,
          release: "AUGUST RELEASE",
          limit: 50,
        },
        discovered,
        DEADLINE_MS,
      );
      expect(result.tickets.map(({ gid }) => gid)).toEqual([matching.gid]);
      expect(result.tickets[0]?.releases).toEqual([{ gid: RELEASE_GID, name: "August Release" }]);
      expect(result.scanned_count).toBe(7);
      expect(result.truncated).toBe(false);
      expect(result.has_more).toBe(false);
      expect(result.next_cursor).toBeNull();
    }
    expect(observedOptions[0]).toMatchObject({
      limit: 20,
      opt_fields: FULL_TASK_FIELDS,
    });

    const byReleaseGid = await service.listTickets(
      { release: RELEASE_GID, limit: 50 },
      discovered,
      DEADLINE_MS,
    );
    expect(byReleaseGid.tickets.some(({ gid }) => gid === matching.gid)).toBe(true);
  });

  it("resolves Release membership and reports unknown Releases", async () => {
    const discovered = snapshot();
    const service = createTicketListingService(createExecutor(createResourceBundle({})), {
      maxScanTasks: 20,
    });

    await expect(
      service.listTickets({ release: "Missing release", limit: 50 }, discovered, DEADLINE_MS),
    ).rejects.toMatchObject({
      code: "unknown_release",
      details: {
        known_releases: [{ gid: RELEASE_GID, name: "August Release" }],
      },
    });
  });

  it("fails closed when a type filter is used without a ticket type field", async () => {
    const discovered = buildDiscoverySnapshot(TEAMSPACE_ID);
    const service = createTicketListingService(createExecutor(createResourceBundle({})), {
      maxScanTasks: 20,
    });

    await expect(
      service.listTickets({ type: "Bug", limit: 50 }, discovered, DEADLINE_MS),
    ).rejects.toMatchObject({ code: "schema_incompatible" });
  });

  it("returns and resumes an opaque filter-bound cursor", async () => {
    const discovered = snapshot();
    const pages = new Map<string | undefined, { items: Task[]; next?: string }>([
      [undefined, { items: [ticket(discovered, "1700000000000001")], next: "second-page" }],
      ["second-page", { items: [ticket(discovered, "1700000000000002")] }],
    ]);
    const offsets: Array<string | undefined> = [];
    const getTasksForProject: TasksApi["getTasksForProjectWithHttpInfo"] = async (
      _projectGid,
      options,
    ) => {
      offsets.push(options?.offset);
      const page = pages.get(options?.offset);
      if (page === undefined) {
        return unexpectedCall("unknown project-task offset");
      }
      return pageResult(page.items, page.next);
    };
    const service = createTicketListingService(
      createExecutor(createResourceBundle({ getTasksForProject })),
      { maxScanTasks: 20 },
    );
    const first = await service.listTickets({ type: "BUG", limit: 1 }, discovered, DEADLINE_MS);
    expect(first.tickets).toHaveLength(1);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.has_more).toBe(true);
    expect(first.truncated).toBe(false);

    const second = await service.listTickets(
      { type: "bug", limit: 1, cursor: first.next_cursor ?? undefined },
      discovered,
      DEADLINE_MS,
    );
    expect(second.tickets.map(({ gid }) => gid)).toEqual(["1700000000000002"]);
    expect(offsets).toEqual([undefined, "second-page"]);

    await expect(
      service.listTickets(
        { type: "Feature", limit: 1, cursor: first.next_cursor ?? undefined },
        discovered,
        DEADLINE_MS,
      ),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    await expect(
      service.listTickets(
        { type: "bug", limit: 2, cursor: first.next_cursor ?? undefined },
        discovered,
        DEADLINE_MS,
      ),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    await expect(
      service.listTickets(
        { type: "bug", limit: 1, cursor: first.next_cursor ?? undefined },
        {
          ...discovered,
          teamspace: { gid: "1211850000337999", name: "Different Teamspace" },
        },
        DEADLINE_MS,
      ),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
  });

  it("reports only safety-bound filtering as truncated", async () => {
    const discovered = snapshot();
    const getTasksForProject: TasksApi["getTasksForProjectWithHttpInfo"] = async () =>
      pageResult(
        [
          ticket(discovered, "1700000000000001", {
            resource_subtype: "default_task",
            custom_type: null,
          }),
          ticket(discovered, "1700000000000002", {
            resource_subtype: "default_task",
            custom_type: null,
          }),
        ],
        "more",
      );
    const bounded = createTicketListingService(
      createExecutor(createResourceBundle({ getTasksForProject })),
      { maxScanTasks: 2 },
    );
    const truncated = await bounded.listTickets({ limit: 10 }, discovered, DEADLINE_MS);
    expect(truncated.scanned_count).toBe(2);
    expect(truncated.truncated).toBe(true);

    const matchingPage: TasksApi["getTasksForProjectWithHttpInfo"] = async () =>
      pageResult([ticket(discovered, "1700000000000003")], "more");
    const limited = createTicketListingService(
      createExecutor(createResourceBundle({ getTasksForProject: matchingPage })),
      { maxScanTasks: 2 },
    );
    const limitReached = await limited.listTickets({ limit: 1 }, discovered, DEADLINE_MS);
    expect(limitReached.tickets).toHaveLength(1);
    expect(limitReached.truncated).toBe(false);
  });
});

describe("ticket search service", () => {
  it("queries the required search shape, advances its boundary, deduplicates, and verifies scope", async () => {
    const discovered = snapshot();
    const first = ticket(discovered, "1700000000000001", {
      created_at: "2026-07-30T12:00:00.000Z",
    });
    const wrongType = ticket(discovered, "1700000000000002", {
      created_at: "2026-07-30T12:00:01.000Z",
      custom_type: { gid: "1800000000000099", name: "Other" },
    });
    const outside = ticket(discovered, "1700000000000003", {
      created_at: "2026-07-30T12:00:02.000Z",
      projects: [{ gid: "1600000000000099", name: "Elsewhere" }],
    });
    const duplicate = { ...first, created_at: "2026-07-30T12:00:03.000Z" };
    const second = ticket(discovered, "1700000000000004", {
      created_at: "2026-07-30T12:00:04.000Z",
    });
    const calls: Record<string, unknown>[] = [];
    const searchTasksForWorkspace: TasksApi["searchTasksForWorkspaceWithHttpInfo"] = async (
      workspaceGid,
      options,
    ) => {
      expect(workspaceGid).toBe(discovered.workspace.gid);
      calls.push(options ?? {});
      return calls.length === 1
        ? pageResult([first, wrongType, outside, duplicate])
        : pageResult([duplicate, second]);
    };
    const service = createTicketListingService(
      createExecutor(createResourceBundle({ searchTasksForWorkspace })),
      { maxScanTasks: 20 },
    );

    const result = await service.searchTickets(
      {
        text: "request id",
        assignee: "ada@example.com",
        completed: false,
        "due_on.before": "2026-08-31",
        "due_on.after": "2026-08-01",
        "completed_on.before": "2026-08-31",
        "completed_on.after": "2026-08-01",
        compact: false,
        limit: 3,
      },
      discovered,
      DEADLINE_MS,
    );

    expect(result.matches.map(({ gid }) => gid)).toEqual([first.gid, second.gid]);
    expect(result.matches).toMatchObject([
      { releases: [{ gid: RELEASE_GID, name: "August Release" }] },
      { releases: [{ gid: RELEASE_GID, name: "August Release" }] },
    ]);
    expect(result.truncated).toBe(false);
    expect(calls[0]).toMatchObject({
      text: "request id",
      "assignee.any": "ada@example.com",
      completed: false,
      "projects.any": TEAMSPACE_ID,
      resource_subtype: "custom",
      sort_by: "created_at",
      sort_ascending: true,
      opt_fields: FULL_TASK_FIELDS,
      limit: 4,
    });
    expect(calls[1]).toMatchObject({
      "created_at.after": "2026-07-30T12:00:02.999Z",
      limit: 3,
    });
  });

  it("returns only four compact fields and marks an over-limit result truncated", async () => {
    const discovered = snapshot();
    const searchTasksForWorkspace: TasksApi["searchTasksForWorkspaceWithHttpInfo"] = async (
      _workspaceGid,
      options,
    ) => {
      expect(options?.opt_fields).toBe(COMPACT_SEARCH_TASK_FIELDS);
      return pageResult([
        ticket(discovered, "1700000000000001"),
        ticket(discovered, "1700000000000002"),
      ]);
    };
    const service = createTicketListingService(
      createExecutor(createResourceBundle({ searchTasksForWorkspace })),
      { maxScanTasks: 20 },
    );

    const result = await service.searchTickets(
      { compact: true, limit: 1 },
      discovered,
      DEADLINE_MS,
    );
    expect(result.truncated).toBe(true);
    expect(result.matches).toEqual([
      {
        gid: "1700000000000001",
        name: "Ticket 1700000000000001",
        created_at: "2026-07-30T12:34:01.000Z",
        completed_at: null,
      },
    ]);
    expect(Object.keys(result.matches[0] ?? {}).sort()).toEqual([
      "completed_at",
      "created_at",
      "gid",
      "name",
    ]);
  });

  it("terminates on a non-advancing duplicate page and caps work at the scan bound", async () => {
    const discovered = snapshot();
    const repeated = ticket(discovered, "1700000000000001");
    let calls = 0;
    const searchTasksForWorkspace: TasksApi["searchTasksForWorkspaceWithHttpInfo"] = async (
      _workspaceGid,
      options,
    ) => {
      calls += 1;
      const request = options as WorkspaceSearchOptions;
      return pageResult(Array.from({ length: Number(request.limit) }, () => repeated));
    };
    const service = createTicketListingService(
      createExecutor(createResourceBundle({ searchTasksForWorkspace })),
      { maxScanTasks: 7 },
    );

    const result = await service.searchTickets(
      { compact: true, limit: 3 },
      discovered,
      DEADLINE_MS,
    );
    expect(calls).toBe(2);
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(calls).toBeLessThanOrEqual(7);
  });

  it("never examines more records than the configured scan bound", async () => {
    const discovered = snapshot();
    let requested = 0;
    const searchTasksForWorkspace: TasksApi["searchTasksForWorkspaceWithHttpInfo"] = async (
      _workspaceGid,
      options,
    ) => {
      const request = options as WorkspaceSearchOptions;
      requested += Number(request.limit);
      return pageResult(
        Array.from({ length: Number(request.limit) }, (_, index) =>
          ticket(discovered, `170000000000000${index + 1}`, {
            custom_type: { gid: "1800000000000099", name: "Other" },
          }),
        ),
      );
    };
    const service = createTicketListingService(
      createExecutor(createResourceBundle({ searchTasksForWorkspace })),
      { maxScanTasks: 2 },
    );

    const result = await service.searchTickets(
      { compact: false, limit: 50 },
      discovered,
      DEADLINE_MS,
    );
    expect(requested).toBe(2);
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
  });
});
