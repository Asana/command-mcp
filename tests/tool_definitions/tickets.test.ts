import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { TicketService } from "../../src/tickets.js";
import { ReadTicketOutputSchema } from "../../src/tickets.js";
import { ticketToolDefinitions } from "../../src/tool_definitions/tickets.js";
import type { CallContext, ToolDefinition } from "../../src/tool_registry.js";
import {
  buildDiscoverySnapshot,
  createDiscoveryState,
  createTestContainer,
  DEADLINE_MS,
  TEAMSPACE_ID,
} from "../helpers/tool_test_helpers.js";

const TICKET_GID = "1700000000000001";

function unexpectedCall(name: string): never {
  throw new Error(`Unexpected call to ${name}`);
}

function findTool(name: string): ToolDefinition {
  const tool = ticketToolDefinitions.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`Missing tool definition: ${name}`);
  }
  return tool;
}

function ticketService(overrides: Partial<TicketService> = {}): TicketService {
  return {
    resolve: async () => unexpectedCall("TicketService.resolve"),
    readByGid: async () => unexpectedCall("TicketService.readByGid"),
    readTicket: async () => unexpectedCall("TicketService.readTicket"),
    ...overrides,
  };
}

describe("ticket tool definitions", () => {
  it("declares the exact read_ticket public contract and annotations", () => {
    expect(
      ticketToolDefinitions.map(({ name, title, description }) => ({ name, title, description })),
    ).toEqual([
      {
        name: "read_ticket",
        title: "Read ticket",
        description: "Read one Command ticket by Asana GID, Command short ID, or Asana task URL.",
      },
    ]);
    expect(findTool("read_ticket").annotations).toEqual({
      title: "Read ticket",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("publishes all three accepted ticket identifier forms in its input schema", () => {
    const input = findTool("read_ticket").inputSchema;
    if (!(input instanceof z.ZodObject)) {
      throw new Error("Expected read_ticket to declare an object input");
    }

    expect(input.shape.ticket_id.description).toContain("Asana task GID");
    expect(input.shape.ticket_id.description).toContain("Command short ID");
    expect(input.shape.ticket_id.description).toContain("Asana task URL");
  });

  it("returns a schema-valid ticket with workspace and Teamspace provenance", async () => {
    const state = createDiscoveryState();
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    state.snapshot = snapshot;
    let observedIdentifier: string | null = null;
    let observedDeadline: number | null = null;
    const tickets = ticketService({
      readTicket: async (identifier, discovered, deadlineMs) => {
        observedIdentifier = identifier;
        observedDeadline = deadlineMs;
        expect(discovered).toBe(snapshot);
        return {
          workspace: snapshot.workspace,
          teamspace: snapshot.teamspace,
          ticket: {
            gid: TICKET_GID,
            short_id: "ENG-42",
            name: "Keep request IDs together",
            description: "",
            created_at: "2026-07-30T12:34:56.789Z",
            completed: false,
            completed_at: null,
            type: null,
            labels: [],
            assignee: null,
            due_on: null,
            predicted_start_on: null,
            predicted_completion_on: null,
            dependencies: [],
            url: null,
          },
        };
      },
    });
    const services = createTestContainer(state, { tickets });
    const context: CallContext = { deadlineMs: DEADLINE_MS, services };

    const result = await findTool("read_ticket").execute(
      { teamspace_id: TEAMSPACE_ID, ticket_id: "  ENG-42  " },
      context,
    );

    expect(observedIdentifier).toBe("ENG-42");
    expect(observedDeadline).toBe(DEADLINE_MS);
    expect(state.discoverCalls).toBe(1);
    expect(result.workspace).toEqual(snapshot.workspace);
    expect(result.teamspace).toEqual(snapshot.teamspace);
    expect(ReadTicketOutputSchema.parse(result)).toEqual(result);
  });
});
