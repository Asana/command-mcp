import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import {
  CONFIG,
  createDiscoveryState,
  createTestContainer,
  createUnexpectedContextServiceFake,
  TEAMSPACE_ID,
  TEAMSPACE_URL,
} from "./helpers/tool_test_helpers.js";

function createDoctorServices() {
  return {
    ...createTestContainer(createDiscoveryState()),
    context: {
      ...createUnexpectedContextServiceFake(),
      listWorkspaces: async () => ({
        workspaces: [{ gid: "1500000000000001", name: "Command Workspace" }],
      }),
    },
  };
}

function createWriter(lines: string[]) {
  return {
    write(data: string) {
      lines.push(data);
    },
  };
}

class RecordingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly events: string[]) {}

  async start(): Promise<void> {
    this.events.push("connected");
  }

  async send(_message: JSONRPCMessage): Promise<void> {}

  async close(): Promise<void> {}
}

describe("CLI", () => {
  it("prints a no-Teamspace doctor report as JSON on stdout", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    await runCli({
      args: ["doctor"],
      env: { ASANA_ACCESS_TOKEN: CONFIG.accessToken },
      services: createDoctorServices(),
      requestContext: { deadlineMs: 8_000_000 },
      stdout: createWriter(stdout),
      stderr: createWriter(stderr),
    });

    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      status: "passed",
      authentication: { status: "passed" },
    });
  });

  it("accepts a Teamspace URL in the doctor subcommand", async () => {
    const stdout: string[] = [];

    await runCli({
      args: ["doctor", TEAMSPACE_URL],
      env: { ASANA_ACCESS_TOKEN: CONFIG.accessToken },
      services: createDoctorServices(),
      stdout: createWriter(stdout),
    });

    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      teamspace_schema: {
        status: "passed",
        teamspace: { gid: TEAMSPACE_ID },
      },
      asana_custom_types_opt_in: { status: "passed" },
    });
  });

  it("rejects malformed doctor arguments before loading configuration", async () => {
    await expect(
      runCli({
        args: ["doctor", TEAMSPACE_ID, TEAMSPACE_ID],
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "Usage: asana-command-mcp doctor [TEAMSPACE_ID_OR_URL]",
    });
  });

  it("rejects a malformed Teamspace argument before loading configuration", async () => {
    await expect(runCli({ args: ["doctor", "not-a-teamspace"], env: {} })).rejects.toMatchObject({
      code: "invalid_input",
      message: "Usage: asana-command-mcp doctor [TEAMSPACE_ID_OR_URL]",
    });
  });

  it("rejects unknown subcommands before loading configuration", async () => {
    await expect(runCli({ args: ["serve"], env: {} })).rejects.toMatchObject({
      code: "invalid_input",
      message: "Usage: asana-command-mcp [doctor [TEAMSPACE_ID_OR_URL]]",
    });
  });

  it("announces readiness on stderr only after stdio connects", async () => {
    const events: string[] = [];
    const stdout: string[] = [];
    const stderr = {
      write(data: string) {
        expect(events).toEqual(["connected"]);
        events.push(data);
      },
    };

    await runCli({
      args: [],
      env: {
        ASANA_ACCESS_TOKEN: CONFIG.accessToken,
        ASANA_READ_ONLY: "true",
      },
      services: createDoctorServices(),
      stdout: createWriter(stdout),
      stderr,
      transport: new RecordingTransport(events),
    });

    expect(stdout).toEqual([]);
    expect(events).toEqual(["connected", "Asana Command MCP server ready (read-only mode)\n"]);
  });
});
