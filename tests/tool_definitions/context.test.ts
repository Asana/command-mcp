import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DiscoveryResultSchema, type SchemaDiscoveryService } from "../../src/schema_discovery.js";
import type { CommandServices } from "../../src/services.js";
import { contextToolDefinitions } from "../../src/tool_definitions/context.js";
import type { CallContext, ToolDefinition } from "../../src/tool_registry.js";
import type { ContextService } from "../../src/tools/context.js";
import { createContextService } from "../../src/tools/context.js";
import {
  buildDiscoverySnapshot,
  createUnexpectedExecutorFake,
  createUnexpectedPullRequestServiceFake,
  createUnexpectedTicketServiceFake,
  DEADLINE_MS,
  TEAMSPACE_ID,
} from "../helpers/tool_test_helpers.js";

const WORKSPACE_GID = "1500000000000001";

function unexpectedCall(name: string): never {
  throw new Error(`Unexpected call to ${name}`);
}

function findTool(name: string): ToolDefinition {
  const tool = contextToolDefinitions.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`Missing tool definition: ${name}`);
  }
  return tool;
}

function createUnexpectedContextService(overrides: Partial<ContextService> = {}): ContextService {
  return {
    listWorkspaces: async () => unexpectedCall("ContextService.listWorkspaces"),
    findTeamspaces: async () => unexpectedCall("ContextService.findTeamspaces"),
    getContext: () => unexpectedCall("ContextService.getContext"),
    ...overrides,
  };
}

function createUnexpectedDiscoveryService(): SchemaDiscoveryService {
  return {
    discover: async () => unexpectedCall("SchemaDiscoveryService.discover"),
  };
}

function createServices(options: {
  context?: ContextService;
  schemaDiscovery?: SchemaDiscoveryService;
}): CommandServices {
  return {
    executor: createUnexpectedExecutorFake(),
    context: options.context ?? createUnexpectedContextService(),
    schemaDiscovery: options.schemaDiscovery ?? createUnexpectedDiscoveryService(),
    pullRequests: createUnexpectedPullRequestServiceFake(),
    tickets: createUnexpectedTicketServiceFake(),
  };
}

function callContext(services: CommandServices): CallContext {
  return {
    deadlineMs: DEADLINE_MS,
    services,
  };
}

describe("context tool definitions", () => {
  it("declares the exact public names, titles, descriptions, and order", () => {
    expect(
      contextToolDefinitions.map(({ name, title, description }) => ({
        name,
        title,
        description,
      })),
    ).toEqual([
      {
        name: "get_context",
        title: "Get Asana Command Teamspace context",
        description:
          "Confirm one selected Teamspace at the start of an Asana workflow or when diagnosing schema warnings; do not call before every tool.",
      },
      {
        name: "list_workspaces",
        title: "List Asana workspaces",
        description:
          "List workspaces accessible to the configured Asana Personal Access Token for Teamspace discovery or access diagnosis.",
      },
      {
        name: "find_teamspaces",
        title: "Find Command Teamspaces",
        description:
          "Find recent or query-matched Teamspace candidates in one workspace; candidates are not schema-validated.",
      },
      {
        name: "get_teamspace_schema",
        title: "Get Teamspace schema",
        description: "Return the freshly discovered Command schema used for this tool call.",
      },
    ]);
  });

  it("marks every tool as read-only", () => {
    for (const tool of contextToolDefinitions) {
      expect(tool.readOnly).toBe(true);
      expect(tool.annotations).toEqual({
        title: tool.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it("describes every get_context output field as part of the public contract", () => {
    const output = findTool("get_context").outputSchema;
    if (!(output instanceof z.ZodObject)) {
      throw new Error("Expected get_context to declare an object output");
    }

    expect(output.shape.workspace.description).toBe("The selected workspace");
    expect(output.shape.teamspace.description).toBe("The selected Command Teamspace");
    expect(output.shape.ticket_prefix.description).toBe(
      "The short-ID prefix or null when unavailable",
    );
    expect(output.shape.schema_fingerprint.description).toBe(
      "The fingerprint of the freshly discovered schema",
    );
    expect(output.shape.validation_warnings.description).toBe(
      "Schema limitations the caller must surface",
    );
  });

  it("requires a URL on every find_teamspaces candidate", () => {
    const output = findTool("find_teamspaces").outputSchema;
    const resultWithoutUrl = output.safeParse({
      candidates: [{ gid: TEAMSPACE_ID, name: "Engineering Teamspace" }],
      schema_validated: false,
      truncated: false,
    });

    expect(resultWithoutUrl.success).toBe(false);
  });

  it("lists workspaces without triggering schema discovery", async () => {
    let observedDeadline: number | null = null;
    const context = createUnexpectedContextService({
      listWorkspaces: async (deadlineMs) => {
        observedDeadline = deadlineMs;
        return {
          workspaces: [{ gid: WORKSPACE_GID, name: "Command workspace" }],
        };
      },
    });
    const tool = findTool("list_workspaces");

    await expect(tool.execute({}, callContext(createServices({ context })))).resolves.toEqual({
      workspaces: [{ gid: WORKSPACE_GID, name: "Command workspace" }],
    });
    expect(observedDeadline).toBe(DEADLINE_MS);
  });

  it("uses a strict empty schema for list_workspaces", async () => {
    const tool = findTool("list_workspaces");

    await expect(
      tool.execute(
        { unexpected: true },
        callContext(
          createServices({
            context: createUnexpectedContextService(),
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("defaults find_teamspaces to ten results and does no schema discovery", async () => {
    let observedInput: Parameters<ContextService["findTeamspaces"]>[0] | null = null;
    const context = createUnexpectedContextService({
      findTeamspaces: async (input) => {
        observedInput = input;
        return {
          candidates: [],
          schema_validated: false,
          truncated: false,
        };
      },
    });
    const tool = findTool("find_teamspaces");

    await expect(
      tool.execute({ workspace_gid: WORKSPACE_GID }, callContext(createServices({ context }))),
    ).resolves.toEqual({
      candidates: [],
      schema_validated: false,
      truncated: false,
    });
    expect(observedInput).toEqual({
      workspaceGid: WORKSPACE_GID,
      limit: 10,
      deadlineMs: DEADLINE_MS,
    });
  });

  it("trims and passes through a supplied find_teamspaces query and limit", async () => {
    let observedInput: Parameters<ContextService["findTeamspaces"]>[0] | null = null;
    const context = createUnexpectedContextService({
      findTeamspaces: async (input) => {
        observedInput = input;
        return {
          candidates: [],
          schema_validated: false,
          truncated: false,
        };
      },
    });

    await findTool("find_teamspaces").execute(
      {
        workspace_gid: WORKSPACE_GID,
        query: "  platform  ",
        limit: 4,
      },
      callContext(createServices({ context })),
    );

    expect(observedInput).toEqual({
      workspaceGid: WORKSPACE_GID,
      query: "platform",
      limit: 4,
      deadlineMs: DEADLINE_MS,
    });
  });

  it.each([
    ["a zero limit", { workspace_gid: WORKSPACE_GID, limit: 0 }],
    ["a limit above twenty", { workspace_gid: WORKSPACE_GID, limit: 21 }],
    ["a non-numeric workspace GID", { workspace_gid: "not-a-gid" }],
    ["an empty query", { workspace_gid: WORKSPACE_GID, query: "   " }],
  ])("rejects %s", async (_label, input) => {
    await expect(
      findTool("find_teamspaces").execute(
        input,
        callContext(
          createServices({
            context: createUnexpectedContextService(),
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("projects get_context from the one discovered snapshot without an executor request", async () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    snapshot.warnings = ["Ticket type is unavailable"];
    let discoveryCalls = 0;
    const schemaDiscovery: SchemaDiscoveryService = {
      discover: async (teamspaceId, deadlineMs) => {
        discoveryCalls += 1;
        expect(teamspaceId).toBe(TEAMSPACE_ID);
        expect(deadlineMs).toBe(DEADLINE_MS);
        return snapshot;
      },
    };
    const executor = createUnexpectedExecutorFake();
    const services: CommandServices = {
      executor,
      context: createContextService(executor),
      schemaDiscovery,
      pullRequests: createUnexpectedPullRequestServiceFake(),
      tickets: createUnexpectedTicketServiceFake(),
    };

    await expect(
      findTool("get_context").execute({ teamspace_id: TEAMSPACE_ID }, callContext(services)),
    ).resolves.toEqual({
      workspace: snapshot.workspace,
      teamspace: snapshot.teamspace,
      ticket_prefix: snapshot.ticket_short_id_field.id_prefix,
      schema_fingerprint: snapshot.fingerprint,
      validation_warnings: snapshot.warnings,
    });
    expect(discoveryCalls).toBe(1);
  });

  it("returns the get_teamspace_schema snapshot unchanged with field options", async () => {
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    snapshot.labels_field.enum_options = [{ gid: "1900000000000101", name: "Customer request" }];
    let discoveryCalls = 0;
    const schemaDiscovery: SchemaDiscoveryService = {
      discover: async () => {
        discoveryCalls += 1;
        return snapshot;
      },
    };

    const result = await findTool("get_teamspace_schema").execute(
      { teamspace_id: TEAMSPACE_ID },
      callContext(createServices({ schemaDiscovery })),
    );

    expect(result).toEqual(snapshot);
    expect(result.labels_field).toEqual(snapshot.labels_field);
    expect(result.ticket_type_field).toBeNull();
    expect(DiscoveryResultSchema.parse(result)).toEqual(snapshot);
    expect(discoveryCalls).toBe(1);
  });
});
