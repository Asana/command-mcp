import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { CommandError } from "../src/errors.js";
import {
  buildDiscoverySnapshot,
  CONFIG,
  createDiscoveryState,
  createTestContainer,
  createUnexpectedContextServiceFake,
  TEAMSPACE_ID,
  TEAMSPACE_URL,
} from "./helpers/tool_test_helpers.js";

const WORKSPACES = [
  { gid: "1500000000000001", name: "Command Workspace" },
  { gid: "1500000000000002", name: "Other Workspace" },
] as const;

function createDoctorServices() {
  const state = createDiscoveryState();
  const services = {
    ...createTestContainer(state),
    context: {
      ...createUnexpectedContextServiceFake(),
      listWorkspaces: async () => ({ workspaces: [...WORKSPACES] }),
    },
  };
  return { services, state };
}

describe("doctor", () => {
  it("reports successful authentication and accessible workspaces", async () => {
    const { services, state } = createDoctorServices();
    const result = await runDoctor([], CONFIG, {
      services,
      deadlineMs: 8_000_000,
      checkForUpdate: async () => null,
    });

    expect(result).toEqual({
      status: "passed",
      authentication: {
        status: "passed",
        workspaces: WORKSPACES,
      },
      update_available: null,
    });
    expect(state.discoverCalls).toBe(0);
  });

  it("reports schema, custom-types opt-in, fingerprint, and warnings", async () => {
    const { services, state } = createDoctorServices();
    state.snapshot = {
      ...buildDiscoverySnapshot(TEAMSPACE_ID),
      warnings: ["Discovery warning"],
    };

    const result = await runDoctor([TEAMSPACE_ID], CONFIG, {
      services,
      deadlineMs: 8_000_000,
      checkForUpdate: async () => null,
    });

    expect(result).toEqual({
      status: "passed",
      authentication: {
        status: "passed",
        workspaces: WORKSPACES,
      },
      teamspace_schema: {
        status: "passed",
        workspace: state.snapshot.workspace,
        teamspace: state.snapshot.teamspace,
        schema_fingerprint: state.snapshot.fingerprint,
        warnings: ["Discovery warning"],
      },
      asana_custom_types_opt_in: {
        status: "passed",
      },
      update_available: null,
    });
    expect(state.discoverCalls).toBe(1);
    expect(state.lastTeamspaceId).toBe(TEAMSPACE_ID);
    expect(state.lastDeadlineMs).toBe(8_000_000);
  });

  it("surfaces a newer version reported by the update checker", async () => {
    const { services } = createDoctorServices();

    const result = await runDoctor([], CONFIG, {
      services,
      deadlineMs: 8_000_000,
      checkForUpdate: async () => "9.9.9",
    });

    expect(result.update_available).toBe("9.9.9");
  });

  it("accepts and canonicalizes a Teamspace URL", async () => {
    const { services, state } = createDoctorServices();

    await runDoctor([TEAMSPACE_URL], CONFIG, {
      services,
      deadlineMs: 8_000_000,
      checkForUpdate: async () => null,
    });

    expect(state.lastTeamspaceId).toBe(TEAMSPACE_ID);
  });

  it.each([
    ["an unknown subcommand argument", ["unexpected"]],
    ["too many arguments", [TEAMSPACE_ID, TEAMSPACE_ID]],
  ])("rejects %s with invalid_input and usage", async (_label, args) => {
    const { services } = createDoctorServices();

    await expect(runDoctor(args, CONFIG, { services })).rejects.toMatchObject({
      code: "invalid_input",
      message: "Usage: asana-command-mcp doctor [TEAMSPACE_ID_OR_URL]",
    });
  });

  it("identifies authentication as the failing stage", async () => {
    const { services } = createDoctorServices();
    services.context.listWorkspaces = async () => {
      throw new CommandError("authentication_failed", "Authentication failed");
    };

    await expect(runDoctor([], CONFIG, { services })).rejects.toMatchObject({
      code: "authentication_failed",
      details: { stage: "authentication" },
    });
  });

  it("identifies Teamspace discovery as the failing stage", async () => {
    const { services } = createDoctorServices();
    services.schemaDiscovery.discover = async () => {
      throw new CommandError("required_api_change_unavailable", "Custom types API is unavailable");
    };

    await expect(
      runDoctor([TEAMSPACE_ID], CONFIG, { services, checkForUpdate: async () => null }),
    ).rejects.toMatchObject({
      code: "required_api_change_unavailable",
      details: { stage: "teamspace_schema_and_custom_types_opt_in" },
    });
  });
});
