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
import type {
  AsanaHttpResult,
  AsanaRequestExecutorPort,
  AsanaResourceBundle,
} from "../src/asana_gateway.js";
import { createContextService } from "../src/context.js";
import { TEAMSPACE_CANDIDATE_FIELDS } from "../src/asana_contracts.js";
import { buildDiscoverySnapshot, DEADLINE_MS } from "./helpers/tool_test_helpers.js";

const WORKSPACE_GID = "1500000000000001";
const TEAMSPACE_GID = "1600000000000001";

function unexpectedCall(name: string): never {
  throw new Error(`Unexpected call to ${name}`);
}

function createThrowingApi<T extends object>(apiName: string): T {
  const target = { apiClient: {} };
  return new Proxy(target, {
    get(object, property, receiver) {
      if (property === "apiClient") {
        return Reflect.get(object, property, receiver);
      }
      if (property === "then") {
        return undefined;
      }
      return (..._args: unknown[]) => unexpectedCall(`${apiName}.${String(property)}`);
    },
  }) as T;
}

type ResourceMethods = {
  getWorkspaces?: WorkspacesApi["getWorkspacesWithHttpInfo"];
  typeahead?: TypeaheadApi["typeaheadForWorkspaceWithHttpInfo"];
};

function createResourceBundle(methods: ResourceMethods): AsanaResourceBundle {
  const workspaces = createThrowingApi<WorkspacesApi>("workspaces");
  const typeahead = createThrowingApi<TypeaheadApi>("typeahead");
  if (methods.getWorkspaces !== undefined) {
    workspaces.getWorkspacesWithHttpInfo = methods.getWorkspaces;
  }
  if (methods.typeahead !== undefined) {
    typeahead.typeaheadForWorkspaceWithHttpInfo = methods.typeahead;
  }

  return {
    tasks: createThrowingApi<TasksApi>("tasks"),
    projects: createThrowingApi<ProjectsApi>("projects"),
    stories: createThrowingApi<StoriesApi>("stories"),
    attachments: createThrowingApi<AttachmentsApi>("attachments"),
    customFieldSettings: createThrowingApi<CustomFieldSettingsApi>("customFieldSettings"),
    customTypes: createThrowingApi<CustomTypesApi>("customTypes"),
    typeahead,
    workspaces,
  };
}

function collectionResult(items: unknown[], nextOffset?: string): AsanaHttpResult {
  return {
    response: { headers: {} },
    data: {
      data: items,
      next_page: nextOffset === undefined ? null : { offset: nextOffset },
    },
  };
}

function createExecutor(
  resources: AsanaResourceBundle,
  observedDeadlines: number[] = [],
): AsanaRequestExecutorPort {
  return {
    createTrace: () => ({ requestIds: [] }),
    read: async () => unexpectedCall("AsanaRequestExecutor.read"),
    write: async () => unexpectedCall("AsanaRequestExecutor.write"),
    readPage: async (schema, options, callback) => {
      observedDeadlines.push(options.deadlineMs);
      const result = await callback(resources);
      const parsed = z
        .object({
          data: z.array(schema),
          next_page: z
            .object({
              offset: z.string(),
            })
            .nullable()
            .optional(),
        })
        .parse(result.data);
      return {
        items: parsed.data,
        nextPageOffset: parsed.next_page?.offset ?? null,
      };
    },
  };
}

function createUnexpectedExecutor(): AsanaRequestExecutorPort {
  return {
    createTrace: () => unexpectedCall("AsanaRequestExecutor.createTrace"),
    read: async () => unexpectedCall("AsanaRequestExecutor.read"),
    write: async () => unexpectedCall("AsanaRequestExecutor.write"),
    readPage: async () => unexpectedCall("AsanaRequestExecutor.readPage"),
  };
}

describe("context service", () => {
  it("collects every accessible workspace across 100-item pages", async () => {
    const requestedOptions: Array<{
      limit?: number;
      offset?: string;
      opt_fields?: string;
    }> = [];
    const getWorkspaces: WorkspacesApi["getWorkspacesWithHttpInfo"] = async (options) => {
      requestedOptions.push(options ?? {});
      if (options?.offset === undefined) {
        return collectionResult(
          [
            { gid: "1500000000000001", name: "First workspace" },
            { gid: "1500000000000002", name: "Second workspace" },
          ],
          "second-page",
        );
      }
      if (options.offset === "second-page") {
        return collectionResult([{ gid: "1500000000000003", name: "Third workspace" }]);
      }
      return unexpectedCall(`workspace offset ${options.offset}`);
    };
    const deadlines: number[] = [];
    const service = createContextService(
      createExecutor(createResourceBundle({ getWorkspaces }), deadlines),
    );

    await expect(service.listWorkspaces(DEADLINE_MS)).resolves.toEqual({
      workspaces: [
        { gid: "1500000000000001", name: "First workspace" },
        { gid: "1500000000000002", name: "Second workspace" },
        { gid: "1500000000000003", name: "Third workspace" },
      ],
    });
    expect(requestedOptions).toEqual([
      { limit: 100, opt_fields: "gid,name" },
      { limit: 100, offset: "second-page", opt_fields: "gid,name" },
    ]);
    expect(deadlines).toEqual([DEADLINE_MS, DEADLINE_MS]);
  });

  it("passes the requested typeahead count and query and constructs Teamspace URLs", async () => {
    let observedWorkspaceGid: string | null = null;
    let observedResourceType: string | null = null;
    let observedOptions: Record<string, unknown> | null = null;
    const typeahead: TypeaheadApi["typeaheadForWorkspaceWithHttpInfo"] = async (
      workspaceGid,
      resourceType,
      options,
    ) => {
      observedWorkspaceGid = workspaceGid;
      observedResourceType = resourceType;
      observedOptions = options ?? {};
      return collectionResult([
        { gid: TEAMSPACE_GID, name: "Platform" },
        { gid: "1600000000000002", name: "Mobile" },
      ]);
    };
    const service = createContextService(createExecutor(createResourceBundle({ typeahead })));

    const result = await service.findTeamspaces({
      workspaceGid: WORKSPACE_GID,
      query: "plat",
      limit: 2,
      deadlineMs: DEADLINE_MS,
    });

    expect(observedWorkspaceGid).toBe(WORKSPACE_GID);
    expect(observedResourceType).toBe("project");
    expect(observedOptions).toEqual({
      count: 2,
      query: "plat",
      opt_fields: TEAMSPACE_CANDIDATE_FIELDS,
    });
    expect(result).toEqual({
      candidates: [
        {
          gid: TEAMSPACE_GID,
          name: "Platform",
          url: `https://app.asana.com/1/${WORKSPACE_GID}/dev/space/${TEAMSPACE_GID}/development`,
        },
        {
          gid: "1600000000000002",
          name: "Mobile",
          url: `https://app.asana.com/1/${WORKSPACE_GID}/dev/space/1600000000000002/development`,
        },
      ],
      schema_validated: false,
      truncated: true,
    });
  });

  it("omits an absent typeahead query and is not truncated below the requested limit", async () => {
    let observedOptions: Record<string, unknown> | null = null;
    const typeahead: TypeaheadApi["typeaheadForWorkspaceWithHttpInfo"] = async (
      _workspaceGid,
      _resourceType,
      options,
    ) => {
      observedOptions = options ?? {};
      return collectionResult([{ gid: TEAMSPACE_GID, name: "Platform" }]);
    };
    const service = createContextService(createExecutor(createResourceBundle({ typeahead })));

    const result = await service.findTeamspaces({
      workspaceGid: WORKSPACE_GID,
      limit: 2,
      deadlineMs: DEADLINE_MS,
    });

    expect(observedOptions).toEqual({
      count: 2,
      opt_fields: TEAMSPACE_CANDIDATE_FIELDS,
    });
    expect(observedOptions).not.toHaveProperty("query");
    expect(result.schema_validated).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("projects every context field from the discovered snapshot without using Asana", () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_GID);
    snapshot.warnings = ["Ticket type is unavailable"];
    const service = createContextService(createUnexpectedExecutor());

    expect(service.getContext(snapshot)).toEqual({
      workspace: snapshot.workspace,
      teamspace: snapshot.teamspace,
      ticket_prefix: "ENG",
      schema_fingerprint: snapshot.fingerprint,
      validation_warnings: snapshot.warnings,
    });
  });

  it("projects a null prefix when discovery has no short-ID prefix", () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_GID);
    snapshot.ticket_short_id_field.id_prefix = null;
    const service = createContextService(createUnexpectedExecutor());

    expect(service.getContext(snapshot).ticket_prefix).toBeNull();
  });
});
