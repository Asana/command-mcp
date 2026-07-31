import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandError } from "../src/errors.js";
import { buildMcpServer, SERVER_INSTRUCTIONS, toolDefinitions } from "../src/server.js";
import type { CommandServices } from "../src/services.js";
import {
  CONFIG,
  createDiscoveryState,
  createTestContainer,
  createUnexpectedContextServiceFake,
} from "./helpers/tool_test_helpers.js";

const EXPECTED_TOOL_ORDER = [
  "get_context",
  "list_workspaces",
  "find_teamspaces",
  "get_teamspace_schema",
  "read_ticket",
  "list_tickets",
  "search_tickets",
  "get_comments",
  "list_teamspace_releases",
  "get_ticket_prs",
  "create_ticket",
  "update_ticket",
  "add_dependency",
  "remove_dependency",
  "add_comment",
  "add_ticket_to_release",
  "remove_ticket_from_release",
] as const;

async function connectClient(options: Parameters<typeof buildMcpServer>[1] = {}, config = CONFIG) {
  const server = buildMcpServer(config, options);
  const client = new Client({ name: "server-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("MCP server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assembles and advertises every tool in the contract order", async () => {
    expect(toolDefinitions.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_ORDER);

    const { client, server } = await connectClient();
    try {
      const discovery = await client.listTools();
      expect(discovery.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_ORDER);
      for (const [index, advertised] of discovery.tools.entries()) {
        const declared = toolDefinitions[index];
        expect(declared).toBeDefined();
        expect(advertised.annotations?.title).toBe(declared?.title);
        expect(advertised.description?.trim()).not.toBe("");
        expect(advertised.inputSchema).toBeDefined();
        expect(advertised.outputSchema).toBeDefined();
        expect(advertised.annotations).toBeDefined();
        expect(advertised.annotations?.readOnlyHint).toBe(declared?.readOnly);
      }
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("omits every write tool from read-only discovery", async () => {
    const { client, server } = await connectClient({}, { ...CONFIG, readOnly: true });
    try {
      const discovery = await client.listTools();
      expect(discovery.tools.map((tool) => tool.name)).toEqual(
        toolDefinitions.filter((tool) => tool.readOnly).map((tool) => tool.name),
      );
      expect(discovery.tools).toHaveLength(toolDefinitions.filter((tool) => tool.readOnly).length);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns matching text and structured content", async () => {
    const services: CommandServices = {
      ...createTestContainer(createDiscoveryState()),
      context: {
        ...createUnexpectedContextServiceFake(),
        listWorkspaces: async () => ({
          workspaces: [{ gid: "1500000000000001", name: "Command Workspace" }],
        }),
      },
    };
    const { client, server } = await connectClient({ services });
    try {
      const result = await client.callTool({ name: "list_workspaces", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        workspaces: [{ gid: "1500000000000001", name: "Command Workspace" }],
      });
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify(result.structuredContent) },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("normalizes failures into stable MCP error results", async () => {
    const services: CommandServices = {
      ...createTestContainer(createDiscoveryState()),
      context: {
        ...createUnexpectedContextServiceFake(),
        listWorkspaces: async () => {
          throw new CommandError("permission_denied", "Workspace access denied");
        },
      },
    };
    const { client, server } = await connectClient({ services });
    try {
      const result = await client.callTool({ name: "list_workspaces", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: "permission_denied",
          message: "Workspace access denied",
          retryable: false,
          suggested_action: "verify that the configured Asana identity can access this resource",
        },
        asana_request_ids: [],
      });
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify(result.structuredContent) },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("establishes one absolute deadline for each call", async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    let receivedDeadline: number | null = null;
    const services: CommandServices = {
      ...createTestContainer(createDiscoveryState()),
      context: {
        ...createUnexpectedContextServiceFake(),
        listWorkspaces: async (deadlineMs) => {
          receivedDeadline = deadlineMs;
          return { workspaces: [] };
        },
      },
    };
    const { client, server } = await connectClient({ services });
    try {
      await client.callTool({ name: "list_workspaces", arguments: {} });
      expect(receivedDeadline).toBe(now + CONFIG.toolTimeoutMs);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("prefers an injected request-context deadline", async () => {
    const injectedDeadline = 9_000_000;
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    let receivedDeadline: number | null = null;
    const services: CommandServices = {
      ...createTestContainer(createDiscoveryState()),
      context: {
        ...createUnexpectedContextServiceFake(),
        listWorkspaces: async (deadlineMs) => {
          receivedDeadline = deadlineMs;
          return { workspaces: [] };
        },
      },
    };
    const { client, server } = await connectClient({
      services,
      requestContext: { deadlineMs: injectedDeadline },
    });
    try {
      await client.callTool({ name: "list_workspaces", arguments: {} });
      expect(receivedDeadline).toBe(injectedDeadline);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
