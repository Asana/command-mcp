import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ticketToolDefinitions,
  UpdateTicketProtocolInputSchema,
  UpdateTicketRuntimeInputSchema,
} from "../../src/tool_definitions/tickets.js";
import type { CallContext, ToolDefinition } from "../../src/tool_registry.js";
import type { TicketService } from "../../src/tools/tickets.js";
import {
  CREATE_PENDING_WARNING,
  CreateTicketOutputSchema,
  ReadTicketOutputSchema,
  UPDATE_PENDING_WARNING,
  UpdateTicketOutputSchema,
} from "../../src/tools/tickets.js";
import {
  buildDiscoverySnapshot,
  createDiscoveryState,
  createTestContainer,
  DEADLINE_MS,
  TEAMSPACE_ID,
} from "../helpers/tool_test_helpers.js";

const TICKET_GID = "1700000000000001";

function ticketView() {
  return {
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
  };
}

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
    createTicket: async () => unexpectedCall("TicketService.createTicket"),
    updateTicket: async () => unexpectedCall("TicketService.updateTicket"),
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
      {
        name: "create_ticket",
        title: "Create ticket",
        description:
          "Create a Command ticket and wait for asynchronous custom-type initialization. For natural-language ticketing requests, search the whole Teamspace first for active duplicates.",
      },
      {
        name: "update_ticket",
        title: "Update ticket",
        description: "Update one in-scope ticket and return a canonical post-write read.",
      },
    ]);
    expect(findTool("read_ticket").annotations).toEqual({
      title: "Read ticket",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(findTool("create_ticket").annotations).toEqual({
      title: "Create ticket",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(findTool("update_ticket").annotations).toEqual({
      title: "Update ticket",
      readOnlyHint: false,
      destructiveHint: true,
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
          ticket: ticketView(),
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

  it("keeps update_ticket flat and advertises the unrefined protocol shape", async () => {
    const noFields = { teamspace_id: TEAMSPACE_ID, task_gid: TICKET_GID };
    expect(UpdateTicketProtocolInputSchema.safeParse(noFields).success).toBe(true);
    expect(UpdateTicketRuntimeInputSchema.safeParse(noFields).success).toBe(false);
    expect(findTool("update_ticket").protocolInputSchema.safeParse(noFields).success).toBe(true);
    expect(findTool("update_ticket").inputSchema.safeParse(noFields).success).toBe(false);

    const state = createDiscoveryState();
    const context: CallContext = {
      deadlineMs: DEADLINE_MS,
      services: createTestContainer(state),
    };
    await expect(findTool("update_ticket").execute(noFields, context)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(state.discoverCalls).toBe(0);
  });

  it("rejects incompatible label operations during tool input validation", () => {
    expect(
      findTool("update_ticket").inputSchema.safeParse({
        teamspace_id: TEAMSPACE_ID,
        task_gid: TICKET_GID,
        labels: { set: [], add: ["Customer"] },
      }).success,
    ).toBe(false);
  });

  it("executes create_ticket with one discovered snapshot and validates its succeeded variant", async () => {
    const state = createDiscoveryState();
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    state.snapshot = snapshot;
    const tickets = ticketService({
      createTicket: async (fields, discovered, deadlineMs) => {
        expect(fields).toEqual({ name: "New ticket", description: "" });
        expect(discovered).toBe(snapshot);
        expect(deadlineMs).toBe(DEADLINE_MS);
        return {
          workspace: snapshot.workspace,
          teamspace: snapshot.teamspace,
          warnings: [],
          asana_request_ids: ["create-request"],
          status: "succeeded",
          outcome: "created",
          data: { ticket: { ...ticketView(), name: "New ticket" } },
        };
      },
    });
    const context: CallContext = {
      deadlineMs: DEADLINE_MS,
      services: createTestContainer(state, { tickets }),
    };

    const result = await findTool("create_ticket").execute(
      { teamspace_id: TEAMSPACE_ID, name: " New ticket ", description: "" },
      context,
    );

    expect(state.discoverCalls).toBe(1);
    expect(CreateTicketOutputSchema.parse(result)).toEqual(result);
  });

  it("executes update_ticket and validates its resumable pending variant and warning", async () => {
    const state = createDiscoveryState();
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    state.snapshot = snapshot;
    const tickets = ticketService({
      updateTicket: async (identifier, fields, discovered, deadlineMs) => {
        expect(identifier).toBe(TICKET_GID);
        expect(fields).toEqual({ description: "" });
        expect(discovered).toBe(snapshot);
        expect(deadlineMs).toBe(DEADLINE_MS);
        return {
          workspace: snapshot.workspace,
          teamspace: snapshot.teamspace,
          warnings: [UPDATE_PENDING_WARNING],
          asana_request_ids: ["read-request"],
          status: "pending",
          outcome: "initialization_pending",
          data: {
            teamspace_id: snapshot.teamspace.gid,
            task_gid: TICKET_GID,
            pending_updates: { update_ticket: { description: "" } },
            retry_with: "update_ticket",
          },
        };
      },
    });
    const context: CallContext = {
      deadlineMs: DEADLINE_MS,
      services: createTestContainer(state, { tickets }),
    };

    const result = await findTool("update_ticket").execute(
      { teamspace_id: TEAMSPACE_ID, task_gid: TICKET_GID, description: "" },
      context,
    );

    expect(state.discoverCalls).toBe(1);
    expect(result.warnings).toEqual([UPDATE_PENDING_WARNING]);
    expect(UpdateTicketOutputSchema.parse(result)).toEqual(result);
    expect(CREATE_PENDING_WARNING).toContain("Do not call create_ticket again");
  });
});
