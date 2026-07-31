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
import type { TicketService } from "../src/tools/tickets.js";
import { createWorkflowService } from "../src/tools/workflow.js";
import {
  buildDiscoverySnapshot,
  createUnexpectedTicketServiceFake,
  DEADLINE_MS,
  TEAMSPACE_ID,
} from "./helpers/tool_test_helpers.js";

const TICKET_GID = "1700000000000001";
const DEPENDENCY_GID = "1700000000000002";
const OTHER_GID = "1700000000000003";

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
  getDependencies?: TasksApi["getDependenciesForTaskWithHttpInfo"];
  addDependencies?: TasksApi["addDependenciesForTaskWithHttpInfo"];
  removeDependencies?: TasksApi["removeDependenciesForTaskWithHttpInfo"];
};

function resources(methods: TaskMethods): AsanaResourceBundle {
  const tasks = throwingApi<TasksApi>("tasks");
  if (methods.getDependencies !== undefined) {
    tasks.getDependenciesForTaskWithHttpInfo = methods.getDependencies;
  }
  if (methods.addDependencies !== undefined) {
    tasks.addDependenciesForTaskWithHttpInfo = methods.addDependencies;
  }
  if (methods.removeDependencies !== undefined) {
    tasks.removeDependenciesForTaskWithHttpInfo = methods.removeDependencies;
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

function collectionResult(
  items: unknown[],
  requestId?: string,
  nextOffset?: string,
): AsanaHttpResult {
  return {
    response: { headers: requestId === undefined ? {} : { "x-asana-request-id": requestId } },
    data: {
      data: items,
      next_page: nextOffset === undefined ? null : { offset: nextOffset },
    },
  };
}

type ExecutorState = {
  reads: number[];
  writes: number[];
  createTraces: number;
};

function executor(bundle: AsanaResourceBundle, observed: ExecutorState): AsanaRequestExecutorPort {
  function collectRequestId(response: AsanaHttpResult, trace: AsanaRequestTrace | undefined): void {
    const requestId = response.response.headers?.["x-asana-request-id"];
    if (trace !== undefined && typeof requestId === "string") {
      trace.requestIds.push(requestId);
    }
  }

  return {
    createTrace: () => {
      observed.createTraces += 1;
      return { requestIds: [] };
    },
    read: async () => unexpectedCall("AsanaRequestExecutor.read"),
    write: async (schema, options, callback, trace) => {
      observed.writes.push(options.deadlineMs);
      const response = await callback(bundle);
      collectRequestId(response, trace);
      return z.object({ data: schema }).parse(response.data).data;
    },
    readPage: async (schema, options, callback, trace) => {
      observed.reads.push(options.deadlineMs);
      const response = await callback(bundle);
      collectRequestId(response, trace);
      const parsed = z
        .object({
          data: z.array(schema),
          next_page: z.object({ offset: z.string() }).nullable().optional(),
        })
        .parse(response.data);
      return {
        items: parsed.data,
        nextPageOffset: parsed.next_page?.offset ?? null,
      };
    },
  };
}

function state(): ExecutorState {
  return { reads: [], writes: [], createTraces: 0 };
}

function ticket(discovered: DiscoveryResult, gid: string): Task {
  return {
    gid,
    name: gid === TICKET_GID ? "Blocked ticket" : "Blocking ticket",
    created_at: "2026-07-31T10:00:00.000Z",
    completed: false,
    completed_at: null,
    resource_subtype: "custom",
    projects: [{ gid: discovered.teamspace.gid, name: discovered.teamspace.name }],
    custom_type: discovered.ticket_custom_type,
  };
}

function ticketService(
  discovered: DiscoveryResult,
  observedIdentifiers: string[] = [],
): TicketService {
  return {
    ...createUnexpectedTicketServiceFake(),
    resolve: async (identifier, snapshot, deadlineMs, options) => {
      observedIdentifiers.push(identifier);
      expect(snapshot).toBe(discovered);
      expect(deadlineMs).toBe(DEADLINE_MS);
      expect(options?.trace).toBeDefined();
      if (identifier === "ENG-1") {
        return ticket(discovered, TICKET_GID);
      }
      if (identifier === "ENG-2") {
        return ticket(discovered, DEPENDENCY_GID);
      }
      return unexpectedCall(`TicketService.resolve(${identifier})`);
    },
  };
}

describe("workflow dependency mutations", () => {
  it("resolves both identifiers and rejects an out-of-scope dependency before any write", async () => {
    const discovered = buildDiscoverySnapshot(TEAMSPACE_ID);
    const observed = state();
    const identifiers: string[] = [];
    const tickets: TicketService = {
      ...createUnexpectedTicketServiceFake(),
      resolve: async (identifier, _snapshot, _deadlineMs, options) => {
        identifiers.push(identifier);
        expect(options?.trace).toBeDefined();
        if (identifier === "ENG-1") {
          options?.trace?.requestIds.push("ticket-read");
          return ticket(discovered, TICKET_GID);
        }
        throw new CommandError("out_of_scope", "Ticket is outside the selected Teamspace");
      },
    };
    const service = createWorkflowService(executor(resources({}), observed), tickets);

    await expect(
      service.addDependency("ENG-1", "OTHER-2", discovered, DEADLINE_MS),
    ).rejects.toMatchObject({
      code: "out_of_scope",
      asanaRequestIds: ["ticket-read"],
    });

    expect(identifiers).toEqual(["ENG-1", "OTHER-2"]);
    expect(observed.reads).toEqual([]);
    expect(observed.writes).toEqual([]);
  });

  it("returns an already-present dependency without writing", async () => {
    const discovered = buildDiscoverySnapshot(TEAMSPACE_ID);
    const observed = state();
    const bundle = resources({
      getDependencies: async () =>
        collectionResult([{ gid: DEPENDENCY_GID, name: "Blocking ticket" }], "current-read"),
    });
    const service = createWorkflowService(executor(bundle, observed), ticketService(discovered));

    const mutation = await service.addDependency("ENG-1", "ENG-2", discovered, DEADLINE_MS);

    expect(observed.writes).toEqual([]);
    expect(observed.reads).toEqual([DEADLINE_MS]);
    expect(mutation).toMatchObject({
      status: "succeeded",
      outcome: "dependency_added",
      asana_request_ids: ["current-read"],
      data: {
        ticket_gid: TICKET_GID,
        dependencies: [{ gid: DEPENDENCY_GID, name: "Blocking ticket" }],
      },
    });
  });

  it("returns an already-absent dependency without writing", async () => {
    const discovered = buildDiscoverySnapshot(TEAMSPACE_ID);
    const observed = state();
    const bundle = resources({
      getDependencies: async () =>
        collectionResult([{ gid: OTHER_GID, name: "Other blocker" }], "current-read"),
    });
    const service = createWorkflowService(executor(bundle, observed), ticketService(discovered));

    const mutation = await service.removeDependency("ENG-1", "ENG-2", discovered, DEADLINE_MS);

    expect(observed.writes).toEqual([]);
    expect(observed.reads).toEqual([DEADLINE_MS]);
    expect(mutation).toMatchObject({
      status: "succeeded",
      outcome: "dependency_removed",
      data: { ticket_gid: TICKET_GID, dependencies: [{ gid: OTHER_GID }] },
    });
  });

  it("adds the blocking ticket in the declared direction and reports the verified list", async () => {
    const discovered = buildDiscoverySnapshot(TEAMSPACE_ID);
    const observed = state();
    const writes: Array<{ body: unknown; ticketGid: string }> = [];
    const pages = [
      collectionResult([], "initial-read"),
      collectionResult([{ gid: DEPENDENCY_GID, name: "Blocking ticket" }], "verified-read"),
    ];
    const bundle = resources({
      getDependencies: async () => pages.shift() ?? unexpectedCall("extra dependency read"),
      addDependencies: async (body, ticketGid) => {
        writes.push({ body, ticketGid });
        return result({}, "add-write");
      },
    });
    const service = createWorkflowService(executor(bundle, observed), ticketService(discovered));

    const mutation = await service.addDependency("ENG-1", "ENG-2", discovered, DEADLINE_MS);

    expect(writes).toEqual([
      {
        body: { data: { dependencies: [DEPENDENCY_GID] } },
        ticketGid: TICKET_GID,
      },
    ]);
    expect(mutation).toMatchObject({
      status: "succeeded",
      outcome: "dependency_added",
      asana_request_ids: ["initial-read", "add-write", "verified-read"],
      data: { dependencies: [{ gid: DEPENDENCY_GID, name: "Blocking ticket" }] },
    });
  });

  it("removes the blocking ticket in the declared direction and reports the verified list", async () => {
    const discovered = buildDiscoverySnapshot(TEAMSPACE_ID);
    const observed = state();
    const writes: Array<{ body: unknown; ticketGid: string }> = [];
    const pages = [
      collectionResult([{ gid: DEPENDENCY_GID }], "initial-read"),
      collectionResult([], "verified-read"),
    ];
    const bundle = resources({
      getDependencies: async () => pages.shift() ?? unexpectedCall("extra dependency read"),
      removeDependencies: async (body, ticketGid) => {
        writes.push({ body, ticketGid });
        return result({}, "remove-write");
      },
    });
    const service = createWorkflowService(executor(bundle, observed), ticketService(discovered));

    const mutation = await service.removeDependency("ENG-1", "ENG-2", discovered, DEADLINE_MS);

    expect(writes).toEqual([
      {
        body: { data: { dependencies: [DEPENDENCY_GID] } },
        ticketGid: TICKET_GID,
      },
    ]);
    expect(mutation).toMatchObject({
      status: "succeeded",
      outcome: "dependency_removed",
      asana_request_ids: ["initial-read", "remove-write", "verified-read"],
      data: { dependencies: [] },
    });
  });

  it.each([
    {
      operation: "add",
      initial: [],
      verified: [],
      writeRequestId: "add-write",
    },
    {
      operation: "remove",
      initial: [{ gid: DEPENDENCY_GID }],
      verified: [{ gid: DEPENDENCY_GID }],
      writeRequestId: "remove-write",
    },
  ] as const)(
    "fails an unconfirmed $operation with every collected request ID",
    async ({ operation, initial, verified, writeRequestId }) => {
      const discovered = buildDiscoverySnapshot(TEAMSPACE_ID);
      const observed = state();
      const pages = [
        collectionResult([...initial], "initial-read"),
        collectionResult([...verified], "verified-read"),
      ];
      const bundle = resources({
        getDependencies: async () => pages.shift() ?? unexpectedCall("extra dependency read"),
        ...(operation === "add"
          ? { addDependencies: async () => result({}, writeRequestId) }
          : { removeDependencies: async () => result({}, writeRequestId) }),
      });
      const service = createWorkflowService(executor(bundle, observed), ticketService(discovered));

      const promise =
        operation === "add"
          ? service.addDependency("ENG-1", "ENG-2", discovered, DEADLINE_MS)
          : service.removeDependency("ENG-1", "ENG-2", discovered, DEADLINE_MS);

      await expect(promise).rejects.toMatchObject({
        code: "asana_api_error",
        asanaRequestIds: ["initial-read", writeRequestId, "verified-read"],
        details: {
          ticket_gid: TICKET_GID,
          dependency_gid: DEPENDENCY_GID,
        },
      });
    },
  );

  it("fully enumerates paginated dependencies and omits an absent name", async () => {
    const discovered = buildDiscoverySnapshot(TEAMSPACE_ID);
    const observed = state();
    const requestedOptions: Array<{
      limit?: number;
      offset?: string;
      opt_fields?: string;
    }> = [];
    const bundle = resources({
      getDependencies: async (_ticketGid, options) => {
        requestedOptions.push(options ?? {});
        if (options?.offset === undefined) {
          return collectionResult(
            [{ gid: OTHER_GID, name: "Other blocker" }],
            "first-page",
            "second-page",
          );
        }
        if (options.offset === "second-page") {
          return collectionResult([{ gid: DEPENDENCY_GID }], "second-page-request");
        }
        return unexpectedCall(`dependency offset ${options.offset}`);
      },
    });
    const service = createWorkflowService(executor(bundle, observed), ticketService(discovered));

    const mutation = await service.addDependency("ENG-1", "ENG-2", discovered, DEADLINE_MS);

    expect(observed.writes).toEqual([]);
    expect(requestedOptions).toEqual([
      { limit: 100, opt_fields: "gid,name" },
      { limit: 100, offset: "second-page", opt_fields: "gid,name" },
    ]);
    expect(mutation.data.dependencies).toEqual([
      { gid: OTHER_GID, name: "Other blocker" },
      { gid: DEPENDENCY_GID },
    ]);
  });
});
