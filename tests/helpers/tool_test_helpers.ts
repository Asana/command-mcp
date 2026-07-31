import type { AsanaRequestExecutorPort } from "../../src/asana_gateway.js";
import type { Config } from "../../src/config.js";
import type { ContextService } from "../../src/context.js";
import type { DiscoveryResult } from "../../src/schema_discovery.js";
import type { CommandServices } from "../../src/services.js";

export const CONFIG: Config = {
  accessToken: "test-token",
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

export function buildDiscoverySnapshot(teamspaceId: string): DiscoveryResult {
  return {
    workspace: { gid: "1500000000000001", name: "Command Workspace" },
    teamspace: { gid: teamspaceId, name: "Engineering Teamspace" },
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

export function createTestContainer(state: FakeSchemaDiscoveryState): CommandServices {
  return {
    executor: createUnexpectedExecutorFake(),
    context: createUnexpectedContextServiceFake(),
    schemaDiscovery: createFakeSchemaDiscoveryService(state),
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
