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
import type { DiscoveryResult, ReleaseReference } from "../src/schema_discovery.js";
import { createReleaseService } from "../src/tools/releases.js";
import type { TicketService } from "../src/tools/tickets.js";
import { buildDiscoverySnapshot, DEADLINE_MS, TEAMSPACE_ID } from "./helpers/tool_test_helpers.js";

const TICKET_GID = "1700000000000001";
const RELEASE_GID = "1800000000000101";
const OTHER_RELEASE_GID = "1800000000000102";
const UNRELATED_PROJECT_GID = "1800000000000199";

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

type ResourceMethods = {
  getProject?: ProjectsApi["getProjectWithHttpInfo"];
  addProject?: TasksApi["addProjectForTaskWithHttpInfo"];
  removeProject?: TasksApi["removeProjectForTaskWithHttpInfo"];
};

function resources(methods: ResourceMethods): AsanaResourceBundle {
  const projects = throwingApi<ProjectsApi>("projects");
  const tasks = throwingApi<TasksApi>("tasks");
  if (methods.getProject !== undefined) {
    projects.getProjectWithHttpInfo = methods.getProject;
  }
  if (methods.addProject !== undefined) {
    tasks.addProjectForTaskWithHttpInfo = methods.addProject;
  }
  if (methods.removeProject !== undefined) {
    tasks.removeProjectForTaskWithHttpInfo = methods.removeProject;
  }
  return {
    tasks,
    projects,
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

type ExecutorState = {
  createTraces: number;
  reads: number[];
  writes: number[];
};

function executor(bundle: AsanaResourceBundle, observed: ExecutorState): AsanaRequestExecutorPort {
  async function invoke<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
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
      return invoke(schema, callback, trace);
    },
    write: async (schema, options, callback, trace) => {
      observed.writes.push(options.deadlineMs);
      return invoke(schema, callback, trace);
    },
    readPage: async () => unexpectedCall("executor.readPage"),
  };
}

function executorState(): ExecutorState {
  return { createTraces: 0, reads: [], writes: [] };
}

function release(gid: string = RELEASE_GID, name: string = "August 2026"): ReleaseReference {
  return {
    gid,
    name,
    due_on: "2026-08-31",
    completed: false,
    current_status_update: null,
  };
}

function snapshot(releases: ReleaseReference[] = [release()]): DiscoveryResult {
  const discovered = buildDiscoverySnapshot(TEAMSPACE_ID);
  discovered.releases = releases;
  return discovered;
}

function task(
  discovered: DiscoveryResult,
  projects: Array<{ gid: string; name?: string }> = [
    { gid: discovered.teamspace.gid, name: discovered.teamspace.name },
  ],
): Task {
  return {
    gid: TICKET_GID,
    name: "Ship release membership",
    created_at: "2026-07-31T10:00:00.000Z",
    completed: false,
    completed_at: null,
    resource_subtype: "custom",
    projects,
    custom_type: discovered.ticket_custom_type,
  };
}

function tickets(overrides: Partial<TicketService> = {}): TicketService {
  return {
    resolve: async () => unexpectedCall("TicketService.resolve"),
    readByGid: async () => unexpectedCall("TicketService.readByGid"),
    readTicket: async () => unexpectedCall("TicketService.readTicket"),
    createTicket: async () => unexpectedCall("TicketService.createTicket"),
    updateTicket: async () => unexpectedCall("TicketService.updateTicket"),
    ...overrides,
  };
}

function teamspaceProject(discovered: DiscoveryResult, releaseGids: string[]) {
  return {
    gid: discovered.teamspace.gid,
    name: discovered.teamspace.name,
    workspace: discovered.workspace,
    custom_fields: [
      {
        gid: discovered.releases_field.gid,
        name: discovered.releases_field.name,
        resource_subtype: "reference",
        reference_value: releaseGids.map((gid) => ({ gid })),
      },
    ],
  };
}

function mutationFixture(options: {
  direction: "add" | "remove";
  discovered?: DiscoveryResult;
  finalProjects?: Array<{ gid: string; name?: string }>;
  liveReleaseGids?: string[];
}) {
  const discovered = options.discovered ?? snapshot();
  const sequence: string[] = [];
  const writes: Array<{ direction: string; body: unknown; taskGid: string }> = [];
  const observed = executorState();
  const bundle = resources({
    getProject: async () => {
      sequence.push("revalidate");
      return result(
        teamspaceProject(discovered, options.liveReleaseGids ?? [RELEASE_GID]),
        "revalidate-request",
      );
    },
    addProject: async (body, taskGid) => {
      sequence.push("write");
      writes.push({ direction: "add", body, taskGid });
      return result({}, "write-request");
    },
    removeProject: async (body, taskGid) => {
      sequence.push("write");
      writes.push({ direction: "remove", body, taskGid });
      return result({}, "write-request");
    },
  });
  const ticketService = tickets({
    resolve: async (_identifier, resolvedSnapshot, _deadlineMs, resolutionOptions) => {
      sequence.push("resolve-ticket");
      expect(resolvedSnapshot).toBe(discovered);
      resolutionOptions?.trace?.requestIds.push("resolve-request");
      return task(discovered);
    },
    readByGid: async (_gid, _deadlineMs, trace) => {
      sequence.push("reread-ticket");
      trace?.requestIds.push("reread-request");
      return task(discovered, options.finalProjects);
    },
  });
  const service = createReleaseService(executor(bundle, observed), ticketService);
  return { discovered, observed, sequence, service, writes };
}

describe("Release service", () => {
  it("projects the snapshot Releases unchanged without issuing an Asana request", () => {
    const discovered = snapshot([
      release(),
      {
        ...release(OTHER_RELEASE_GID, "September 2026"),
        due_on: null,
        completed: true,
        current_status_update: {
          gid: "1800000000000201",
          title: "Complete",
          text: "Released",
        },
      },
    ]);
    const observed = executorState();
    const service = createReleaseService(executor(resources({}), observed), tickets());

    expect(service.listReleases(discovered)).toEqual({
      workspace: discovered.workspace,
      teamspace: discovered.teamspace,
      releases: discovered.releases,
    });
    expect(observed).toEqual({ createTraces: 0, reads: [], writes: [] });
  });

  it.each([
    ["exact GID", RELEASE_GID],
    ["case-insensitive name", "aUgUsT 2026"],
  ])("resolves a Release by %s", async (_label, identifier) => {
    const fixture = mutationFixture({
      direction: "add",
      finalProjects: [
        { gid: TEAMSPACE_ID, name: "Engineering Teamspace" },
        { gid: RELEASE_GID, name: "August 2026" },
      ],
    });

    const output = await fixture.service.addTicketToRelease(
      TICKET_GID,
      identifier,
      fixture.discovered,
      DEADLINE_MS,
    );

    expect(fixture.sequence).toEqual(["resolve-ticket", "revalidate", "write", "reread-ticket"]);
    expect(fixture.writes).toEqual([
      {
        direction: "add",
        body: { data: { project: RELEASE_GID } },
        taskGid: TICKET_GID,
      },
    ]);
    expect(output).toMatchObject({
      status: "succeeded",
      outcome: "release_added",
      data: {
        ticket_gid: TICKET_GID,
        memberships: [{ gid: RELEASE_GID, name: "August 2026" }],
      },
    });
  });

  it.each([
    ["unknown", "Not a release", [release()]],
    ["ambiguous", "August 2026", [release(), release(OTHER_RELEASE_GID, "AUGUST 2026")]],
  ])("rejects an %s Release and lists known Releases", async (_label, identifier, releases) => {
    const discovered = snapshot(releases);
    const observed = executorState();
    const service = createReleaseService(
      executor(resources({}), observed),
      tickets({
        resolve: async (_identifier, _snapshot, _deadlineMs, options) => {
          options?.trace?.requestIds.push("resolve-request");
          return task(discovered);
        },
      }),
    );

    await expect(
      service.addTicketToRelease(TICKET_GID, identifier, discovered, DEADLINE_MS),
    ).rejects.toMatchObject({
      code: "unknown_release",
      details: {
        identifier,
        known_releases: releases.map(({ gid, name }) => ({ gid, name })),
      },
    });
    expect(observed.reads).toEqual([]);
    expect(observed.writes).toEqual([]);
  });

  it("rejects a snapshot Release no longer referenced by the Teamspace before membership write", async () => {
    const fixture = mutationFixture({
      direction: "add",
      liveReleaseGids: [],
    });

    await expect(
      fixture.service.addTicketToRelease(TICKET_GID, RELEASE_GID, fixture.discovered, DEADLINE_MS),
    ).rejects.toMatchObject({
      code: "unknown_release",
      message: "Release is no longer referenced by the selected Teamspace",
      asanaRequestIds: ["resolve-request", "revalidate-request"],
    });
    expect(fixture.sequence).toEqual(["resolve-ticket", "revalidate"]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.observed.writes).toEqual([]);
  });

  it("reports a successful add and only memberships in the snapshot", async () => {
    const otherRelease = release(OTHER_RELEASE_GID, "September 2026");
    const discovered = snapshot([release(), otherRelease]);
    const fixture = mutationFixture({
      direction: "add",
      discovered,
      liveReleaseGids: [RELEASE_GID, OTHER_RELEASE_GID],
      finalProjects: [
        { gid: TEAMSPACE_ID, name: "Engineering Teamspace" },
        { gid: RELEASE_GID, name: "August 2026" },
        { gid: UNRELATED_PROJECT_GID, name: "Unrelated project" },
      ],
    });

    const output = await fixture.service.addTicketToRelease(
      TICKET_GID,
      RELEASE_GID,
      discovered,
      DEADLINE_MS,
    );

    expect(output.data).toEqual({
      ticket_gid: TICKET_GID,
      memberships: [{ gid: RELEASE_GID, name: "August 2026" }],
    });
    expect(output.asana_request_ids).toEqual([
      "resolve-request",
      "revalidate-request",
      "write-request",
      "reread-request",
    ]);
  });

  it("reports a successful remove with the target absent", async () => {
    const fixture = mutationFixture({
      direction: "remove",
      finalProjects: [{ gid: TEAMSPACE_ID, name: "Engineering Teamspace" }],
    });

    const output = await fixture.service.removeTicketFromRelease(
      TICKET_GID,
      RELEASE_GID,
      fixture.discovered,
      DEADLINE_MS,
    );

    expect(fixture.writes).toEqual([
      {
        direction: "remove",
        body: { data: { project: RELEASE_GID } },
        taskGid: TICKET_GID,
      },
    ]);
    expect(output).toMatchObject({
      status: "succeeded",
      outcome: "release_removed",
      data: { ticket_gid: TICKET_GID, memberships: [] },
    });
  });

  it.each([
    ["add", [{ gid: TEAMSPACE_ID, name: "Engineering Teamspace" }], "addTicketToRelease"],
    [
      "remove",
      [
        { gid: TEAMSPACE_ID, name: "Engineering Teamspace" },
        { gid: RELEASE_GID, name: "August 2026" },
      ],
      "removeTicketFromRelease",
    ],
  ] as const)(
    "fails an unconfirmed %s with the collected request IDs",
    async (_direction, finalProjects, method) => {
      const fixture = mutationFixture({
        direction: method === "addTicketToRelease" ? "add" : "remove",
        finalProjects: [...finalProjects],
      });

      await expect(
        fixture.service[method](TICKET_GID, RELEASE_GID, fixture.discovered, DEADLINE_MS),
      ).rejects.toMatchObject({
        code: "asana_api_error",
        asanaRequestIds: [
          "resolve-request",
          "revalidate-request",
          "write-request",
          "reread-request",
        ],
      });
    },
  );

  it("stops when the ticket resolver rejects an out-of-scope ticket", async () => {
    const observed = executorState();
    const sequence: string[] = [];
    const service = createReleaseService(
      executor(resources({}), observed),
      tickets({
        resolve: async () => {
          sequence.push("resolve-ticket");
          throw new CommandError("out_of_scope", "Ticket is outside the selected Teamspace");
        },
      }),
    );

    await expect(
      service.addTicketToRelease(TICKET_GID, RELEASE_GID, snapshot(), DEADLINE_MS),
    ).rejects.toMatchObject({ code: "out_of_scope" });
    expect(sequence).toEqual(["resolve-ticket"]);
    expect(observed.reads).toEqual([]);
    expect(observed.writes).toEqual([]);
  });
});
