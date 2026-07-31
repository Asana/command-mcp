import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ListTicketsInputSchema,
  SearchTicketsInputSchema,
  ticketToolDefinitions,
  UpdateTicketProtocolInputSchema,
  UpdateTicketRuntimeInputSchema,
} from "../../src/tool_definitions/tickets.js";
import type { CallContext, ToolDefinition } from "../../src/tool_registry.js";
import type { PullRequestService } from "../../src/tools/pull_requests.js";
import {
  GetTicketPullRequestsOutputSchema,
  PullRequestResultSchema,
} from "../../src/tools/pull_requests.js";
import type { TicketListingService } from "../../src/tools/ticket_listing.js";
import {
  ListTicketsOutputSchema,
  SearchTicketsOutputSchema,
} from "../../src/tools/ticket_listing.js";
import type { TicketService } from "../../src/tools/tickets.js";
import {
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

function ticketListingService(overrides: Partial<TicketListingService> = {}): TicketListingService {
  return {
    listTickets: async () => unexpectedCall("TicketListingService.listTickets"),
    searchTickets: async () => unexpectedCall("TicketListingService.searchTickets"),
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
        name: "list_tickets",
        title: "List tickets",
        description:
          "Enumerate tickets in the selected Teamspace with bounded type, label, assignee, Release, and completion-status filtering plus opaque pagination. Use search_tickets instead for completion-date or due-date ranges.",
      },
      {
        name: "search_tickets",
        title: "Search tickets",
        description:
          "Search tickets in the selected Teamspace using eventually consistent Asana workspace search, with a total result limit up to 1,000. Use this tool for completion-date or due-date ranges; results include created_at and completed_at. Set compact=true to return only gid, name, and those timestamps.",
      },
      {
        name: "get_ticket_prs",
        title: "Get ticket pull requests",
        description:
          "Best-effort discovery of GitHub pull-request URLs in ticket attachments and stories.",
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
    for (const name of ["list_tickets", "search_tickets"]) {
      expect(findTool(name).annotations).toEqual({
        title: name === "list_tickets" ? "List tickets" : "Search tickets",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
    expect(findTool("get_ticket_prs").annotations).toEqual({
      title: "Get ticket pull requests",
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

  it("advertises deliberately distinct strict list and search inputs", () => {
    expect(ListTicketsInputSchema.parse({ teamspace_id: TEAMSPACE_ID })).toMatchObject({
      limit: 50,
    });
    expect(SearchTicketsInputSchema.parse({ teamspace_id: TEAMSPACE_ID })).toMatchObject({
      compact: false,
      limit: 50,
    });
    expect(
      ListTicketsInputSchema.safeParse({
        teamspace_id: TEAMSPACE_ID,
        limit: 101,
      }).success,
    ).toBe(false);
    expect(
      SearchTicketsInputSchema.safeParse({
        teamspace_id: TEAMSPACE_ID,
        limit: 1001,
      }).success,
    ).toBe(false);
    expect(
      SearchTicketsInputSchema.safeParse({
        teamspace_id: TEAMSPACE_ID,
        assignee: "Ada Lovelace",
      }).success,
    ).toBe(false);
    for (const assignee of ["me", "ada@example.com", "1800000000000010"]) {
      expect(
        SearchTicketsInputSchema.safeParse({
          teamspace_id: TEAMSPACE_ID,
          assignee,
        }).success,
      ).toBe(true);
    }

    const searchInput = findTool("search_tickets").protocolInputSchema;
    if (!(searchInput instanceof z.ZodObject)) {
      throw new Error("Expected search_tickets to declare an object input");
    }
    for (const absent of ["cursor", "type", "label", "release", "offset"]) {
      expect(searchInput.shape).not.toHaveProperty(absent);
    }
    expect(searchInput.shape).toHaveProperty("due_on.before");
    expect(searchInput.shape).toHaveProperty("completed_on.after");
    expect(
      searchInput.safeParse({
        teamspace_id: TEAMSPACE_ID,
        cursor: "not-supported",
      }).success,
    ).toBe(false);
  });

  it("executes list_tickets with one snapshot and validates provenance output", async () => {
    const state = createDiscoveryState();
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    state.snapshot = snapshot;
    const ticketListing = ticketListingService({
      listTickets: async (input, discovered, deadlineMs) => {
        expect(input).toEqual({ limit: 50 });
        expect(discovered).toBe(snapshot);
        expect(deadlineMs).toBe(DEADLINE_MS);
        return {
          workspace: snapshot.workspace,
          teamspace: snapshot.teamspace,
          tickets: [],
          next_cursor: null,
          has_more: false,
          scanned_count: 0,
          truncated: false,
        };
      },
    });
    const context: CallContext = {
      deadlineMs: DEADLINE_MS,
      services: createTestContainer(state, { ticketListing }),
    };

    const result = await findTool("list_tickets").execute({ teamspace_id: TEAMSPACE_ID }, context);
    expect(state.discoverCalls).toBe(1);
    expect(ListTicketsOutputSchema.parse(result)).toEqual(result);
  });

  it("executes search_tickets with defaults and validates compact output", async () => {
    const state = createDiscoveryState();
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    state.snapshot = snapshot;
    const ticketListing = ticketListingService({
      searchTickets: async (input, discovered, deadlineMs) => {
        expect(input).toEqual({ compact: true, limit: 50 });
        expect(discovered).toBe(snapshot);
        expect(deadlineMs).toBe(DEADLINE_MS);
        return {
          workspace: snapshot.workspace,
          teamspace: snapshot.teamspace,
          matches: [
            {
              gid: TICKET_GID,
              name: "Keep request IDs together",
              created_at: "2026-07-30T12:34:56.789Z",
              completed_at: null,
            },
          ],
          truncated: false,
        };
      },
    });
    const context: CallContext = {
      deadlineMs: DEADLINE_MS,
      services: createTestContainer(state, { ticketListing }),
    };

    const result = await findTool("search_tickets").execute(
      { teamspace_id: TEAMSPACE_ID, compact: true },
      context,
    );
    expect(state.discoverCalls).toBe(1);
    expect(SearchTicketsOutputSchema.parse(result)).toEqual(result);
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

  it("declares a strict get_ticket_prs input and the required output descriptions", () => {
    const input = findTool("get_ticket_prs").inputSchema;
    if (!(input instanceof z.ZodObject)) {
      throw new Error("Expected get_ticket_prs to declare an object input");
    }

    expect(input.shape.ticket_id.description).toBe(
      "The ticket whose attachments and stories should be scanned for GitHub pull-request URLs",
    );
    expect(
      input.safeParse({
        teamspace_id: TEAMSPACE_ID,
        ticket_id: TICKET_GID,
        extra: true,
      }).success,
    ).toBe(false);
    expect(PullRequestResultSchema.shape.provenance.description).toBe("Where the URL was observed");
    expect(PullRequestResultSchema.shape.title.description).toBe(
      "The attachment title when available",
    );
    expect(GetTicketPullRequestsOutputSchema.shape.warnings.description).toBe(
      "Scan-limit warnings the caller must surface",
    );
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

  it("discovers ticket pull requests with one Teamspace schema snapshot", async () => {
    const state = createDiscoveryState();
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    state.snapshot = snapshot;
    const observed: Array<{ identifier: string; deadlineMs: number }> = [];
    const pullRequests: PullRequestService = {
      getTicketPrs: async (identifier, discovered, deadlineMs) => {
        observed.push({ identifier, deadlineMs });
        expect(discovered).toBe(snapshot);
        return {
          workspace: snapshot.workspace,
          teamspace: snapshot.teamspace,
          results: [
            {
              url: "https://github.com/asana/command-mcp/pull/123",
              provenance: "attachment",
              title: "Improve retries",
            },
          ],
          warnings: [],
        };
      },
    };
    const context: CallContext = {
      deadlineMs: DEADLINE_MS,
      services: createTestContainer(state, { pullRequests }),
    };

    const result = await findTool("get_ticket_prs").execute(
      { teamspace_id: TEAMSPACE_ID, ticket_id: " ENG-42 " },
      context,
    );

    expect(observed).toEqual([{ identifier: "ENG-42", deadlineMs: DEADLINE_MS }]);
    expect(state.discoverCalls).toBe(1);
    expect(GetTicketPullRequestsOutputSchema.parse(result)).toEqual(result);
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
    expect(findTool("create_ticket").protocolOutputSchema.parse(result)).toEqual(result);
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
    expect(findTool("update_ticket").protocolOutputSchema.parse(result)).toEqual(result);
  });
});
