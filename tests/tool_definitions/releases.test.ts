import { describe, expect, it } from "vitest";
import {
  releaseMutationToolDefinitions,
  releaseReadToolDefinitions,
} from "../../src/tool_definitions/releases.js";
import type { CallContext, ToolDefinition } from "../../src/tool_registry.js";
import type { ReleaseService } from "../../src/tools/releases.js";
import {
  buildDiscoverySnapshot,
  createDiscoveryState,
  createTestContainer,
  DEADLINE_MS,
  TEAMSPACE_ID,
} from "../helpers/tool_test_helpers.js";

const TICKET_GID = "1700000000000001";
const RELEASE_GID = "1800000000000101";

function unexpectedCall(name: string): never {
  throw new Error(`Unexpected call to ${name}`);
}

function releaseService(overrides: Partial<ReleaseService> = {}): ReleaseService {
  return {
    listReleases: () => unexpectedCall("ReleaseService.listReleases"),
    addTicketToRelease: async () => unexpectedCall("ReleaseService.addTicketToRelease"),
    removeTicketFromRelease: async () => unexpectedCall("ReleaseService.removeTicketFromRelease"),
    ...overrides,
  };
}

function findTool(name: string): ToolDefinition {
  const tool = [...releaseReadToolDefinitions, ...releaseMutationToolDefinitions].find(
    (candidate) => candidate.name === name,
  );
  if (tool === undefined) {
    throw new Error(`Missing tool definition: ${name}`);
  }
  return tool;
}

describe("Release tool definitions", () => {
  it("exports the read and mutation tools as separate groups with exact contracts", () => {
    expect(
      releaseReadToolDefinitions.map(({ name, title, description }) => ({
        name,
        title,
        description,
      })),
    ).toEqual([
      {
        name: "list_teamspace_releases",
        title: "List Teamspace releases",
        description: "List only Releases referenced by the selected Teamspace.",
      },
    ]);
    expect(
      releaseMutationToolDefinitions.map(({ name, title, description }) => ({
        name,
        title,
        description,
      })),
    ).toEqual([
      {
        name: "add_ticket_to_release",
        title: "Add ticket to Release",
        description: "Multi-home a ticket into a currently referenced Teamspace Release.",
      },
      {
        name: "remove_ticket_from_release",
        title: "Remove ticket from Release",
        description: "Remove a ticket from a currently referenced Teamspace Release.",
      },
    ]);
  });

  it("declares the required annotations", () => {
    expect(findTool("list_teamspace_releases").annotations).toEqual({
      title: "List Teamspace releases",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(findTool("add_ticket_to_release").annotations).toEqual({
      title: "Add ticket to Release",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(findTool("remove_ticket_from_release").annotations).toEqual({
      title: "Remove ticket from Release",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("uses strict mutation inputs for a ticket and Release name or GID", () => {
    const valid = {
      teamspace_id: TEAMSPACE_ID,
      ticket_id: TICKET_GID,
      release: " August 2026 ",
    };
    expect(findTool("add_ticket_to_release").inputSchema.parse(valid)).toEqual({
      teamspace_id: TEAMSPACE_ID,
      ticket_id: TICKET_GID,
      release: "August 2026",
    });
    expect(
      findTool("remove_ticket_from_release").inputSchema.safeParse({
        ...valid,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("lists Releases from the one discovered snapshot", async () => {
    const state = createDiscoveryState();
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    snapshot.releases = [
      {
        gid: RELEASE_GID,
        name: "August 2026",
        due_on: null,
        completed: false,
        current_status_update: null,
      },
    ];
    state.snapshot = snapshot;
    const releases = releaseService({
      listReleases: (discovered) => {
        expect(discovered).toBe(snapshot);
        return {
          workspace: snapshot.workspace,
          teamspace: snapshot.teamspace,
          releases: snapshot.releases,
        };
      },
    });
    const context: CallContext = {
      deadlineMs: DEADLINE_MS,
      services: createTestContainer(state, { releases }),
    };

    await expect(
      findTool("list_teamspace_releases").execute({ teamspace_id: TEAMSPACE_ID }, context),
    ).resolves.toEqual({
      workspace: snapshot.workspace,
      teamspace: snapshot.teamspace,
      releases: snapshot.releases,
    });
    expect(state.discoverCalls).toBe(1);
  });

  it.each([
    ["add_ticket_to_release", "release_added"],
    ["remove_ticket_from_release", "release_removed"],
  ] as const)("executes %s with one snapshot and validates its output", async (name, outcome) => {
    const state = createDiscoveryState();
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    state.snapshot = snapshot;
    function expectArguments(
      ticketId: string,
      releaseIdentifier: string,
      discovered: typeof snapshot,
      deadlineMs: number,
    ) {
      expect(ticketId).toBe(TICKET_GID);
      expect(releaseIdentifier).toBe("August 2026");
      expect(discovered).toBe(snapshot);
      expect(deadlineMs).toBe(DEADLINE_MS);
    }
    const mutationData = {
      ticket_gid: TICKET_GID,
      memberships: [{ gid: RELEASE_GID, name: "August 2026" }],
    };
    const releases = releaseService({
      addTicketToRelease: async (...args) => {
        expectArguments(...args);
        return {
          workspace: snapshot.workspace,
          teamspace: snapshot.teamspace,
          warnings: [],
          asana_request_ids: ["write-request"],
          status: "succeeded",
          outcome: "release_added",
          data: mutationData,
        };
      },
      removeTicketFromRelease: async (...args) => {
        expectArguments(...args);
        return {
          workspace: snapshot.workspace,
          teamspace: snapshot.teamspace,
          warnings: [],
          asana_request_ids: ["write-request"],
          status: "succeeded",
          outcome: "release_removed",
          data: mutationData,
        };
      },
    });
    const context: CallContext = {
      deadlineMs: DEADLINE_MS,
      services: createTestContainer(state, { releases }),
    };

    const output = await findTool(name).execute(
      {
        teamspace_id: TEAMSPACE_ID,
        ticket_id: TICKET_GID,
        release: " August 2026 ",
      },
      context,
    );

    expect(output).toMatchObject({ status: "succeeded", outcome });
    expect(findTool(name).outputSchema.parse(output)).toEqual(output);
    expect(findTool(name).protocolOutputSchema.parse(output)).toEqual(output);
    expect(state.discoverCalls).toBe(1);
  });
});
