import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type AsanaOAuthLoginOptions,
  loadAsanaOAuthLoginConfig,
  runAsanaOAuthLogin,
} from "./asana_oauth.js";
import {
  type AsanaPersonalAccessTokenLoginOptions,
  runAsanaPersonalAccessTokenLogin,
} from "./asana_pat.js";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { runDoctor, validateDoctorArguments } from "./doctor.js";
import { CommandError } from "./errors.js";
import {
  createDefaultOAuthCredentialStore,
  createDefaultPersonalAccessTokenStore,
  type OAuthCredentialStore,
  type PersonalAccessTokenStore,
} from "./oauth_credentials.js";
import { buildMcpServer, type InjectedRequestContext } from "./server.js";
import { buildServices, type CommandServices } from "./services.js";
import type { UpdateChecker } from "./update_check.js";

export const CLI_USAGE =
  "Usage: asana-command-mcp [doctor [TEAMSPACE_ID_OR_URL] | auth login [--oauth]]";

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
  readonly oauthCredentialStore?: OAuthCredentialStore;
  readonly personalAccessTokenStore?: PersonalAccessTokenStore;
  readonly oauthLogin?: (options: AsanaOAuthLoginOptions) => Promise<void>;
  readonly personalAccessTokenLogin?: (
    options: AsanaPersonalAccessTokenLoginOptions,
  ) => Promise<void>;
  readonly checkForUpdate?: UpdateChecker;
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
    const isPersonalAccessTokenLogin = subcommandArgs.length === 1 && subcommandArgs[0] === "login";
    const isOAuthLogin =
      subcommandArgs.length === 2 &&
      subcommandArgs[0] === "login" &&
      subcommandArgs[1] === "--oauth";
    if (!isPersonalAccessTokenLogin && !isOAuthLogin) {
      throw invalidCliUsage();
    }
    if (isOAuthLogin) {
      const env = options.env ?? process.env;
      const credentialStore = options.oauthCredentialStore ?? createDefaultOAuthCredentialStore();
      await (options.oauthLogin ?? runAsanaOAuthLogin)({
        app: loadAsanaOAuthLoginConfig(env),
        credentialStore,
        stdout,
        stderr,
      });
    } else {
      const credentialStore =
        options.personalAccessTokenStore ?? createDefaultPersonalAccessTokenStore();
      await (options.personalAccessTokenLogin ?? runAsanaPersonalAccessTokenLogin)({
        credentialStore,
        stdout,
        stderr,
      });
    }
    return;
  }
  if (subcommand === "doctor") {
    validateDoctorArguments(subcommandArgs);
  }

  const env = options.env ?? process.env;
  const personalAccessTokenStore =
    options.personalAccessTokenStore ?? createDefaultPersonalAccessTokenStore();
  const personalAccessToken = await personalAccessTokenStore.load();
  const oauthCredentialStore = options.oauthCredentialStore ?? createDefaultOAuthCredentialStore();
  const oauthCredentials = personalAccessToken === null ? await oauthCredentialStore.load() : null;
  const config: Config = loadConfig(env, { personalAccessToken, oauthCredentials });
  const services =
    options.services ??
    buildServices(config, {
      persistOAuthRefreshToken: async (refreshToken) => {
        if (config.authentication.type !== "oauth") {
          return;
        }
        await oauthCredentialStore.save({
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
      ...(options.checkForUpdate === undefined ? {} : { checkForUpdate: options.checkForUpdate }),
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
