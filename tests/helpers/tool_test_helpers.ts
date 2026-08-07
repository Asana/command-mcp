import type { AsanaRequestExecutorPort } from "../../src/asana_gateway.js";
import type { Config } from "../../src/config.js";
import type { DiscoveryResult } from "../../src/schema_discovery.js";
import type { CommandServices } from "../../src/services.js";
import type { CommentService } from "../../src/tools/comments.js";
import type { ContextService } from "../../src/tools/context.js";
import type { PullRequestService } from "../../src/tools/pull_requests.js";
import type { ReleaseService } from "../../src/tools/releases.js";
import type { TicketListingService } from "../../src/tools/ticket_listing.js";
import type { TicketService } from "../../src/tools/tickets.js";
import type { WorkflowService } from "../../src/tools/workflow.js";

export const CONFIG: Config = {
  authentication: {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    refreshToken: "test-refresh-token",
  },
  readOnly: false,
  maxScanTasks: 1000,
  createTimeoutMs: 30_000,
  requestTimeoutMs: 20_000,
  toolTimeoutMs: 120_000,
};

export const TEAMSPACE_ID = "1211850000337894";
export const TEAMSPACE_URL = `https://app.asana.com/1/15793206719/dev/space/${TEAMSPACE_ID}`;
export const DEADLINE_MS = 2_000_000;

export class UnexpectedExecutorCallError extends Error {
  constructor(method: string) {
    super(`Unexpected call to AsanaRequestExecutor.${method}`);
    this.name = "UnexpectedExecutorCallError";
  }
}

function unexpectedExecutorCall(method: string): never {
  throw new UnexpectedExecutorCallError(method);
}

export function createUnexpectedExecutorFake(): AsanaRequestExecutorPort {
  return {
    createTrace: () => unexpectedExecutorCall("createTrace"),
    read: async () => unexpectedExecutorCall("read"),
    write: async () => unexpectedExecutorCall("write"),
    readPage: async () => unexpectedExecutorCall("readPage"),
  };
}

export function createUnexpectedContextServiceFake(): ContextService {
  return {
    listWorkspaces: async () => unexpectedExecutorCall("ContextService.listWorkspaces"),
    findTeamspaces: async () => unexpectedExecutorCall("ContextService.findTeamspaces"),
    getContext: () => unexpectedExecutorCall("ContextService.getContext"),
  };
}

export function createUnexpectedCommentServiceFake(): CommentService {
  return {
    getComments: async () => unexpectedExecutorCall("CommentService.getComments"),
    addComment: async () => unexpectedExecutorCall("CommentService.addComment"),
  };
}

export function createUnexpectedTicketServiceFake(): TicketService {
  return {
    resolve: async () => unexpectedExecutorCall("TicketService.resolve"),
    readByGid: async () => unexpectedExecutorCall("TicketService.readByGid"),
    readTicket: async () => unexpectedExecutorCall("TicketService.readTicket"),
    createTicket: async () => unexpectedExecutorCall("TicketService.createTicket"),
    updateTicket: async () => unexpectedExecutorCall("TicketService.updateTicket"),
  };
}

export function createUnexpectedTicketListingServiceFake(): TicketListingService {
  return {
    listTickets: async () => unexpectedExecutorCall("TicketListingService.listTickets"),
    searchTickets: async () => unexpectedExecutorCall("TicketListingService.searchTickets"),
  };
}

export function createUnexpectedPullRequestServiceFake(): PullRequestService {
  return {
    getTicketPrs: async () => unexpectedExecutorCall("PullRequestService.getTicketPrs"),
  };
}

export function createUnexpectedReleaseServiceFake(): ReleaseService {
  return {
    listReleases: () => unexpectedExecutorCall("ReleaseService.listReleases"),
    addTicketToRelease: async () => unexpectedExecutorCall("ReleaseService.addTicketToRelease"),
    removeTicketFromRelease: async () =>
      unexpectedExecutorCall("ReleaseService.removeTicketFromRelease"),
  };
}

export function createUnexpectedWorkflowServiceFake(): WorkflowService {
  return {
    addDependency: async () => unexpectedExecutorCall("WorkflowService.addDependency"),
    removeDependency: async () => unexpectedExecutorCall("WorkflowService.removeDependency"),
  };
}

export function buildDiscoverySnapshot(teamspaceId: string): DiscoveryResult {
  const workspace = { gid: "1500000000000001", name: "Command Workspace" };
  return {
    workspace,
    teamspace: {
      gid: teamspaceId,
      name: "Engineering Teamspace",
      url: `https://app.asana.com/1/${workspace.gid}/dev/space/${teamspaceId}`,
    },
    ticket_custom_type: { gid: "1800000000000001", name: "Dev Ticket" },
    ticket_short_id_field: {
      gid: "1900000000000001",
      name: "Short ID",
      enum_options: [],
      id_prefix: "ENG",
    },
    ticket_type_field: null,
    labels_field: { gid: "1900000000000002", name: "Labels", enum_options: [] },
    predicted_start_date_field: {
      gid: "1900000000000003",
      name: "Predicted Start",
      enum_options: [],
    },
    predicted_completion_date_field: {
      gid: "1900000000000004",
      name: "Predicted Completion",
      enum_options: [],
    },
    releases_field: { gid: "1900000000000005", name: "Releases", enum_options: [] },
    releases: [],
    fingerprint: "abc123def4567890",
    warnings: [],
    discovered_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  };
}

export type FakeSchemaDiscoveryState = {
  discoverCalls: number;
  lastTeamspaceId: string | null;
  lastDeadlineMs: number | null;
  snapshot: DiscoveryResult;
};

export function createFakeSchemaDiscoveryService(state: FakeSchemaDiscoveryState) {
  return {
    discover: async (teamspaceId: string, deadlineMs: number) => {
      state.discoverCalls += 1;
      state.lastTeamspaceId = teamspaceId;
      state.lastDeadlineMs = deadlineMs;
      return state.snapshot;
    },
  };
}

export function createTestContainer(
  state: FakeSchemaDiscoveryState,
  overrides: {
    comments?: CommentService;
    pullRequests?: PullRequestService;
    releases?: ReleaseService;
    ticketListing?: TicketListingService;
    tickets?: TicketService;
    workflow?: WorkflowService;
  } = {},
): CommandServices {
  return {
    executor: createUnexpectedExecutorFake(),
    context: createUnexpectedContextServiceFake(),
    releases: overrides.releases ?? createUnexpectedReleaseServiceFake(),
    schemaDiscovery: createFakeSchemaDiscoveryService(state),
    comments: overrides.comments ?? createUnexpectedCommentServiceFake(),
    pullRequests: overrides.pullRequests ?? createUnexpectedPullRequestServiceFake(),
    tickets: overrides.tickets ?? createUnexpectedTicketServiceFake(),
    ticketListing: overrides.ticketListing ?? createUnexpectedTicketListingServiceFake(),
    workflow: overrides.workflow ?? createUnexpectedWorkflowServiceFake(),
  };
}

export function createDiscoveryState(teamspaceId: string = TEAMSPACE_ID): FakeSchemaDiscoveryState {
  return {
    discoverCalls: 0,
    lastTeamspaceId: null,
    lastDeadlineMs: null,
    snapshot: buildDiscoverySnapshot(teamspaceId),
  };
}
