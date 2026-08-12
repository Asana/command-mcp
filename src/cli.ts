import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type AsanaOAuthLoginOptions,
  loadAsanaOAuthLoginConfig,
  runAsanaOAuthLogin,
} from "./asana_oauth.js";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { runDoctor, validateDoctorArguments } from "./doctor.js";
import { CommandError } from "./errors.js";
import {
  createDefaultOAuthCredentialStore,
  type OAuthCredentialStore,
} from "./oauth_credentials.js";
import { buildMcpServer, type InjectedRequestContext } from "./server.js";
import { buildServices, type CommandServices } from "./services.js";

export const CLI_USAGE = "Usage: asana-command-mcp [doctor [TEAMSPACE_ID_OR_URL] | auth login]";

type OutputWriter = {
  write(data: string): unknown;
};

export type RunCliOptions = {
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: OutputWriter;
  readonly stderr?: OutputWriter;
  readonly services?: CommandServices;
  readonly requestContext?: InjectedRequestContext;
  readonly transport?: Transport;
  readonly credentialStore?: OAuthCredentialStore;
  readonly authLogin?: (options: AsanaOAuthLoginOptions) => Promise<void>;
};

function invalidCliUsage(): CommandError {
  return new CommandError("invalid_input", CLI_USAGE, {
    details: { usage: CLI_USAGE },
  });
}

export async function runCli(options: RunCliOptions = {}): Promise<void> {
  const args = options.args ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const [subcommand, ...subcommandArgs] = args;
  if (subcommand !== undefined && subcommand !== "doctor" && subcommand !== "auth") {
    throw invalidCliUsage();
  }
  if (subcommand === "auth") {
    if (subcommandArgs.length !== 1 || subcommandArgs[0] !== "login") {
      throw invalidCliUsage();
    }
    const env = options.env ?? process.env;
    const credentialStore = options.credentialStore ?? createDefaultOAuthCredentialStore();
    await (options.authLogin ?? runAsanaOAuthLogin)({
      app: loadAsanaOAuthLoginConfig(env),
      credentialStore,
      stdout,
      stderr,
    });
    return;
  }
  if (subcommand === "doctor") {
    validateDoctorArguments(subcommandArgs);
  }

  const env = options.env ?? process.env;
  const credentialStore = options.credentialStore ?? createDefaultOAuthCredentialStore();
  const oauthCredentials = await credentialStore.load();
  const config: Config = loadConfig(env, { oauthCredentials });
  const services =
    options.services ??
    buildServices(config, {
      persistOAuthRefreshToken: async (refreshToken) => {
        await credentialStore.save({
          version: 1,
          clientId: config.authentication.clientId,
          clientSecret: config.authentication.clientSecret,
          refreshToken,
        });
      },
    });
  if (subcommand === "doctor") {
    const report = await runDoctor(subcommandArgs, config, {
      services,
      ...(options.requestContext?.deadlineMs === undefined
        ? {}
        : { deadlineMs: options.requestContext.deadlineMs }),
    });
    stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  const server = buildMcpServer(config, {
    services,
    ...(options.requestContext === undefined ? {} : { requestContext: options.requestContext }),
  });
  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);
  const mode = config.readOnly ? "read-only" : "read-write";
  stderr.write(`Asana Command MCP server ready (${mode} mode)\n`);
}
