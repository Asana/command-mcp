import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { OAuthCredentialStore } from "../src/oauth_credentials.js";
import {
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

function createCredentialStore(): OAuthCredentialStore {
  return {
    location: "operating system keychain",
    load: async () => ({
      version: 1,
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    }),
    save: async () => undefined,
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
  it("runs auth login without loading normal server configuration", async () => {
    const calls: string[] = [];
    const credentialStore: OAuthCredentialStore = {
      location: "operating system keychain",
      load: async () => null,
      save: async () => undefined,
    };

    await runCli({
      args: ["auth", "login"],
      env: {
        ASANA_OAUTH_CLIENT_ID: "client-id",
        ASANA_OAUTH_CLIENT_SECRET: "client-secret",
      },
      credentialStore,
      authLogin: async (options) => {
        expect(options.credentialStore).toBe(credentialStore);
        calls.push("login");
      },
    });

    expect(calls).toEqual(["login"]);
  });

  it("loads the stored refresh token before starting in OAuth mode", async () => {
    const events: string[] = [];
    const credentialStore: OAuthCredentialStore = {
      location: "operating system keychain",
      load: async () => ({
        version: 1,
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      }),
      save: async () => undefined,
    };

    await runCli({
      args: [],
      env: {},
      credentialStore,
      services: createDoctorServices(),
      transport: new RecordingTransport(events),
      stdout: createWriter([]),
      stderr: createWriter([]),
    });

    expect(events).toEqual(["connected"]);
  });

  it("loads OAuth credentials from the keychain when a legacy access-token variable exists", async () => {
    const events: string[] = [];
    let loads = 0;
    const credentialStore: OAuthCredentialStore = {
      location: "operating system keychain",
      load: async () => {
        loads += 1;
        return {
          version: 1,
          clientId: "client-id",
          clientSecret: "client-secret",
          refreshToken: "refresh-token",
        };
      },
      save: async () => undefined,
    };

    await runCli({
      args: [],
      env: { ASANA_ACCESS_TOKEN: "test-token" },
      credentialStore,
      services: createDoctorServices(),
      transport: new RecordingTransport(events),
      stdout: createWriter([]),
      stderr: createWriter([]),
    });

    expect(loads).toBe(1);
    expect(events).toEqual(["connected"]);
  });

  it("rejects incomplete auth subcommands before loading configuration", async () => {
    await expect(runCli({ args: ["auth"], env: {} })).rejects.toMatchObject({
      code: "invalid_input",
      message: "Usage: asana-command-mcp [doctor [TEAMSPACE_ID_OR_URL] | auth login]",
    });
  });

  it("prints a no-Teamspace doctor report as JSON on stdout", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    await runCli({
      args: ["doctor"],
      env: {},
      credentialStore: createCredentialStore(),
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
      env: {},
      credentialStore: createCredentialStore(),
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
      message: "Usage: asana-command-mcp [doctor [TEAMSPACE_ID_OR_URL] | auth login]",
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
      env: { ASANA_READ_ONLY: "true" },
      credentialStore: createCredentialStore(),
      services: createDoctorServices(),
      stdout: createWriter(stdout),
      stderr,
      transport: new RecordingTransport(events),
    });

    expect(stdout).toEqual([]);
    expect(events).toEqual(["connected", "Asana Command MCP server ready (read-only mode)\n"]);
  });
});
