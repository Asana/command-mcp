import { ApiClient, UsersApi } from "asana";
import { z } from "zod";
import type { AsanaRequestExecutorPort } from "../../src/asana_gateway.js";
import { INCLUDE_ASANA_CREATED_CUSTOM_TYPES } from "../../src/asana_gateway.js";
import type { Config } from "../../src/config.js";
import { CommandError } from "../../src/errors.js";
import type { CommandServices } from "../../src/services.js";

const CLEANUP_ATTEMPTS = 3;
const CLEANUP_RETRY_DELAY_MS = 1_000;

export type IntegrationEnvironment = {
  accessToken: string;
  teamspaceId: string;
  secondTeamspaceId?: string;
  disposable: boolean;
};

export type EnvironmentGate =
  | { ready: true; environment: IntegrationEnvironment }
  | { ready: false; reason: string };

const CurrentUserSchema = z.object({
  gid: z.string().regex(/^\d+$/),
  name: z.string(),
});

const EmptyResponseSchema = z.object({}).strict();

export function readIntegrationEnvironment(env: NodeJS.ProcessEnv): EnvironmentGate {
  const accessToken = env.ASANA_ACCESS_TOKEN?.trim();
  const teamspaceId = env.ASANA_INTEGRATION_TEST_TEAMSPACE?.trim();
  if (!accessToken || !teamspaceId) {
    return {
      ready: false,
      reason:
        "live Asana tests skipped: set ASANA_ACCESS_TOKEN and ASANA_INTEGRATION_TEST_TEAMSPACE",
    };
  }

  const secondTeamspaceId = env.ASANA_INTEGRATION_TEST_SECOND_TEAMSPACE?.trim();
  return {
    ready: true,
    environment: {
      accessToken,
      teamspaceId,
      ...(secondTeamspaceId ? { secondTeamspaceId } : {}),
      disposable: env.ASANA_INTEGRATION_TEST_DISPOSABLE === "true",
    },
  };
}

export function integrationConfig(environment: IntegrationEnvironment): Config {
  return {
    accessToken: environment.accessToken,
    readOnly: false,
    maxScanTasks: 1_000,
    createTimeoutMs: 30_000,
    requestTimeoutMs: 20_000,
    toolTimeoutMs: 120_000,
  };
}

export function deadline(milliseconds = 120_000): number {
  return Date.now() + milliseconds;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function currentUser(
  environment: IntegrationEnvironment,
  workspaceGid: string,
): Promise<z.infer<typeof CurrentUserSchema>> {
  const client = new ApiClient();
  const tokenAuth = client.authentications.token;
  if (tokenAuth === undefined) {
    throw new Error("The Asana SDK client is missing token authentication");
  }
  tokenAuth.accessToken = environment.accessToken;
  client.defaultHeaders["Asana-Enable"] = INCLUDE_ASANA_CREATED_CUSTOM_TYPES;
  client.timeout = 20_000;
  const users = new UsersApi(client);
  const response = await users.getUserWithHttpInfo("me", {
    workspace: workspaceGid,
    opt_fields: "gid,name",
  });
  return CurrentUserSchema.parse(response.data.data);
}

export class CreatedTaskCleanup {
  private readonly gids = new Set<string>();

  constructor(
    private readonly executor: AsanaRequestExecutorPort,
    private readonly services: CommandServices,
  ) {}

  track(gid: string): string {
    this.gids.add(gid);
    return gid;
  }

  async run(): Promise<void> {
    const failures: string[] = [];
    for (const gid of [...this.gids].reverse()) {
      try {
        await this.deleteAndVerify(gid);
        this.gids.delete(gid);
      } catch (error) {
        failures.push(gid);
        console.error(`LIVE ASANA CLEANUP FAILED for task GID ${gid}: ${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Live Asana cleanup failed for task GIDs: ${failures.join(", ")}. Remove them manually.`,
      );
    }
  }

  private async deleteAndVerify(gid: string): Promise<void> {
    try {
      await this.executor.write(
        EmptyResponseSchema,
        { deadlineMs: deadline(30_000) },
        async (resources) => resources.tasks.deleteTaskWithHttpInfo(gid),
      );
    } catch (error) {
      if (!(error instanceof CommandError && error.code === "not_found")) {
        throw error;
      }
    }

    for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await this.services.tickets.readByGid(gid, deadline(30_000));
      } catch (error) {
        if (error instanceof CommandError && error.code === "not_found") {
          return;
        }
        throw error;
      }
      if (attempt < CLEANUP_ATTEMPTS) {
        await delay(CLEANUP_RETRY_DELAY_MS);
      }
    }
    throw new Error("authoritative direct reads still return the deleted task");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
