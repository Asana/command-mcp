import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { UsersApi } from "asana";
import { z } from "zod";
import type { AsanaRequestExecutorPort } from "../src/asana_gateway.js";
import { loadConfig } from "../src/config.js";
import { CommandError } from "../src/errors.js";
import { createDefaultOAuthCredentialStore } from "../src/oauth_credentials.js";
import { buildServices, type CommandServices } from "../src/services.js";

type Status = "pass" | "fail" | "unknown";

type CapabilityResult = {
  capability: string;
  status: Status;
  detail: string;
};

type JsonObject = Record<string, unknown>;

const EXPECTED_TOOLS = [
  "get_context",
  "list_workspaces",
  "find_teamspaces",
  "get_teamspace_schema",
  "read_ticket",
  "list_tickets",
  "search_tickets",
  "get_comments",
  "list_teamspace_releases",
  "get_ticket_prs",
  "create_ticket",
  "update_ticket",
  "add_dependency",
  "remove_dependency",
  "add_comment",
  "add_ticket_to_release",
  "remove_ticket_from_release",
] as const;

const ADDITIONAL_CAPABILITIES = ["pending_initialization_resume"] as const;
const CALL_TIMEOUT_MS = 120_000;
const SEARCH_TIMEOUT_MS = 60_000;
const INITIALIZATION_TIMEOUT_MS = 60_000;
const CLEANUP_ATTEMPTS = 3;
const CurrentUserSchema = z.object({ gid: z.string().regex(/^\d+$/) });
const EmptyResponseSchema = z.object({}).strict();
const results = new Map<string, CapabilityResult>();
const createdTaskGids = new Set<string>();
let createOutcomeAmbiguous = false;
let createAttempted = false;

class EvidenceError extends Error {
  readonly status: Exclude<Status, "pass">;

  constructor(status: Exclude<Status, "pass">, message: string) {
    super(message);
    this.status = status;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: JsonObject, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new EvidenceError("unknown", `missing or invalid ${field}`);
  }
  return candidate;
}

function objectField(value: JsonObject, field: string): JsonObject {
  const candidate = value[field];
  if (!isObject(candidate)) {
    throw new EvidenceError("unknown", `missing or invalid ${field}`);
  }
  return candidate;
}

function arrayField(value: JsonObject, field: string): unknown[] {
  const candidate = value[field];
  if (!Array.isArray(candidate)) {
    throw new EvidenceError("unknown", `missing or invalid ${field}`);
  }
  return candidate;
}

function sanitize(message: string): string {
  return message.replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]").slice(0, 500);
}

function errorDetail(error: unknown): string {
  return sanitize(error instanceof Error ? error.message : String(error));
}

function record(capability: string, status: Status, detail: string): void {
  const previous = results.get(capability);
  const rank: Record<Status, number> = { pass: 0, unknown: 1, fail: 2 };
  if (previous !== undefined && rank[previous.status] > rank[status]) {
    return;
  }
  results.set(capability, { capability, status, detail: sanitize(detail) });
}

async function probe<T>(
  capability: string,
  operation: () => Promise<{ value: T; detail: string }>,
): Promise<T | undefined> {
  try {
    const outcome = await operation();
    record(capability, "pass", outcome.detail);
    return outcome.value;
  } catch (error) {
    const status = error instanceof EvidenceError ? error.status : "unknown";
    record(capability, status, errorDetail(error));
    return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function dateFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

async function createOAuthServices(): Promise<CommandServices> {
  const credentialStore = createDefaultOAuthCredentialStore();
  const oauthCredentials = await credentialStore.load();
  if (oauthCredentials === null) {
    throw new EvidenceError("unknown", "run asana-command-mcp auth login first");
  }
  const config = loadConfig({ ...process.env, ASANA_READ_ONLY: "false" }, { oauthCredentials });
  return buildServices(config, {
    persistOAuthRefreshToken: async (refreshToken) =>
      credentialStore.save({
        version: 1,
        clientId: config.authentication.clientId,
        clientSecret: config.authentication.clientSecret,
        refreshToken,
      }),
  });
}

async function currentUserGid(
  executor: AsanaRequestExecutorPort,
  workspaceGid: string,
): Promise<string> {
  const user = await executor.read(
    CurrentUserSchema,
    { deadlineMs: Date.now() + CALL_TIMEOUT_MS },
    async (resources) =>
      new UsersApi(resources.tasks.apiClient).getUserWithHttpInfo("me", {
        workspace: workspaceGid,
        opt_fields: "gid",
      }),
  );
  return user.gid;
}

async function deleteAndVerify(services: CommandServices, gid: string): Promise<void> {
  try {
    await services.executor.write(
      EmptyResponseSchema,
      { deadlineMs: Date.now() + CALL_TIMEOUT_MS },
      async (resources) => resources.tasks.deleteTaskWithHttpInfo(gid),
    );
  } catch (error) {
    if (!(error instanceof CommandError && error.code === "not_found")) {
      throw error;
    }
  }

  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await services.tickets.readByGid(gid, Date.now() + CALL_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof CommandError && error.code === "not_found") {
        return;
      }
      throw error;
    }
    if (attempt < CLEANUP_ATTEMPTS) {
      await delay(1_000);
    }
  }
  throw new Error("authoritative direct reads still return the deleted task");
}

async function cleanupCreatedTasks(): Promise<void> {
  if (createdTaskGids.size === 0) {
    if (createOutcomeAmbiguous) {
      record(
        "verified_cleanup",
        "unknown",
        "a create returned no parseable result, so its task GID and cleanup state are unknown",
      );
    } else if (!createAttempted) {
      record("verified_cleanup", "unknown", "no task was created, so cleanup was not exercised");
    }
    return;
  }

  const services = await createOAuthServices();
  const failed: string[] = [];
  for (const gid of [...createdTaskGids].reverse()) {
    try {
      await deleteAndVerify(services, gid);
      createdTaskGids.delete(gid);
    } catch (error) {
      failed.push(gid);
      process.stderr.write(
        `LIVE VALIDATION CLEANUP FAILED for task GID ${gid}: ${errorDetail(error)}\n`,
      );
    }
  }
  if (failed.length > 0) {
    record(
      "verified_cleanup",
      "fail",
      `authoritative cleanup verification failed for task GIDs ${failed.join(", ")}`,
    );
  } else if (createOutcomeAmbiguous) {
    record(
      "verified_cleanup",
      "unknown",
      "a create returned no parseable result, so its task GID and cleanup state are unknown",
    );
  } else {
    record("verified_cleanup", "pass", "every created task returned not_found on direct read");
  }
}

async function callTool(
  client: Client,
  name: string,
  argumentsValue: JsonObject,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<JsonObject> {
  if (timeoutMs <= 0) {
    throw new EvidenceError("unknown", `${name} had no remaining validation time`);
  }
  let response: Awaited<ReturnType<Client["callTool"]>>;
  try {
    response = await client.callTool({ name, arguments: argumentsValue }, undefined, {
      timeout: timeoutMs,
    });
  } catch (error) {
    throw new EvidenceError("unknown", `${name} protocol call failed: ${errorDetail(error)}`);
  }

  if (response.isError === true) {
    const structured = response.structuredContent;
    const code =
      isObject(structured) &&
      isObject(structured.error) &&
      typeof structured.error.code === "string"
        ? structured.error.code
        : "unparseable_error";
    const retryable =
      isObject(structured) && isObject(structured.error) && structured.error.retryable === true;
    const status = retryable ? "unknown" : "fail";
    throw new EvidenceError(status, `${name} returned MCP error ${code}`);
  }
  if (!isObject(response.structuredContent)) {
    throw new EvidenceError("unknown", `${name} omitted structured content`);
  }

  if (!Array.isArray(response.content)) {
    throw new EvidenceError("unknown", `${name} content was unparseable`);
  }
  const textBlock = response.content.find(
    (entry): entry is { type: "text"; text: string } =>
      isObject(entry) && entry.type === "text" && typeof entry.text === "string",
  );
  if (textBlock === undefined) {
    throw new EvidenceError("unknown", `${name} omitted text content`);
  }
  let parsedText: unknown;
  try {
    parsedText = JSON.parse(textBlock.text);
  } catch {
    throw new EvidenceError("unknown", `${name} text content was unparseable`);
  }
  if (JSON.stringify(parsedText) !== JSON.stringify(response.structuredContent)) {
    throw new EvidenceError("fail", `${name} text and structured content disagree`);
  }
  return response.structuredContent;
}

function mutationTask(result: JsonObject): {
  gid: string;
  pendingFields?: JsonObject;
} {
  const status = stringField(result, "status");
  const data = objectField(result, "data");
  if (status === "succeeded") {
    return { gid: stringField(objectField(data, "ticket"), "gid") };
  }
  if (status !== "pending") {
    throw new EvidenceError("unknown", `unexpected mutation status ${status}`);
  }
  const pendingUpdates = objectField(data, "pending_updates");
  return {
    gid: stringField(data, "task_gid"),
    pendingFields: objectField(pendingUpdates, "update_ticket"),
  };
}

async function resumeInitialization(
  client: Client,
  teamspaceId: string,
  gid: string,
  initialFields: JsonObject,
): Promise<JsonObject> {
  const expiresAt = Date.now() + INITIALIZATION_TIMEOUT_MS;
  let fields = initialFields;
  while (Date.now() < expiresAt) {
    const result = await callTool(
      client,
      "update_ticket",
      {
        teamspace_id: teamspaceId,
        task_gid: gid,
        ...fields,
      },
      Math.min(CALL_TIMEOUT_MS, expiresAt - Date.now()),
    );
    if (result.status === "succeeded") {
      return result;
    }
    const data = objectField(result, "data");
    fields = objectField(objectField(data, "pending_updates"), "update_ticket");
    await delay(1_000);
  }
  throw new EvidenceError("unknown", "custom-type initialization did not finish within the bound");
}

function firstOptionName(schema: JsonObject, fieldName: string): string | undefined {
  const field = schema[fieldName];
  if (field === null || !isObject(field)) {
    return undefined;
  }
  const first = arrayField(field, "enum_options")[0];
  return isObject(first) && typeof first.name === "string" ? first.name : undefined;
}

async function createTicket(
  client: Client,
  teamspaceId: string,
  fields: JsonObject,
): Promise<{ gid: string; result: JsonObject }> {
  createAttempted = true;
  let result: JsonObject;
  let created: ReturnType<typeof mutationTask>;
  try {
    result = await callTool(client, "create_ticket", {
      teamspace_id: teamspaceId,
      ...fields,
    });
    created = mutationTask(result);
  } catch (error) {
    createOutcomeAmbiguous = true;
    throw error;
  }
  createdTaskGids.add(created.gid);
  if (created.pendingFields !== undefined) {
    const resumed = await resumeInitialization(
      client,
      teamspaceId,
      created.gid,
      created.pendingFields,
    );
    record(
      "pending_initialization_resume",
      "pass",
      "resumed a built-server pending create through update_ticket",
    );
    return { gid: created.gid, result: resumed };
  }
  return { gid: created.gid, result };
}

async function validate(): Promise<void> {
  const teamspaceId = process.env.ASANA_INTEGRATION_TEST_TEAMSPACE?.trim() ?? "";
  const disposable = process.env.ASANA_INTEGRATION_TEST_DISPOSABLE === "true";
  if (teamspaceId.length === 0 || !disposable) {
    const missing = [
      ...(teamspaceId.length === 0 ? ["ASANA_INTEGRATION_TEST_TEAMSPACE"] : []),
      ...(!disposable ? ["ASANA_INTEGRATION_TEST_DISPOSABLE=true"] : []),
    ];
    record("configuration", "unknown", `required live evidence unavailable: ${missing.join(", ")}`);
    for (const capability of [
      "protocol_initialize",
      "tool_discovery",
      ...EXPECTED_TOOLS,
      ...ADDITIONAL_CAPABILITIES,
    ]) {
      record(capability, "unknown", "validation did not run without the required safe environment");
    }
    record("verified_cleanup", "unknown", "no write was attempted");
    return;
  }
  let preflightServices: CommandServices;
  let preflightSchema: Awaited<ReturnType<CommandServices["schemaDiscovery"]["discover"]>>;
  let preflightAssigneeGid: string;
  try {
    preflightServices = await createOAuthServices();
    preflightSchema = await preflightServices.schemaDiscovery.discover(
      teamspaceId,
      Date.now() + CALL_TIMEOUT_MS,
    );
    preflightAssigneeGid = await currentUserGid(
      preflightServices.executor,
      preflightSchema.workspace.gid,
    );
  } catch (error) {
    record("configuration", "unknown", `OAuth preflight failed: ${errorDetail(error)}`);
    for (const capability of [
      "protocol_initialize",
      "tool_discovery",
      ...EXPECTED_TOOLS,
      ...ADDITIONAL_CAPABILITIES,
    ]) {
      record(capability, "unknown", "validation did not run without OAuth preflight evidence");
    }
    record("verified_cleanup", "unknown", "no write was attempted");
    return;
  }
  record(
    "configuration",
    "pass",
    "OAuth keychain credentials, Teamspace, and explicit disposable flag are present",
  );

  const childEnvironment = {
    ...getDefaultEnvironment(),
    ASANA_READ_ONLY: "false",
    ASANA_INTEGRATION_TEST_TEAMSPACE: teamspaceId,
    ASANA_INTEGRATION_TEST_DISPOSABLE: "true",
    ...(process.env.ASANA_MAX_SCAN_TASKS === undefined
      ? {}
      : { ASANA_MAX_SCAN_TASKS: process.env.ASANA_MAX_SCAN_TASKS }),
    ASANA_CREATE_TIMEOUT_SECONDS: process.env.ASANA_CREATE_TIMEOUT_SECONDS ?? "1",
    ...(process.env.ASANA_REQUEST_TIMEOUT_MS === undefined
      ? {}
      : { ASANA_REQUEST_TIMEOUT_MS: process.env.ASANA_REQUEST_TIMEOUT_MS }),
    ...(process.env.ASANA_TOOL_TIMEOUT_MS === undefined
      ? {}
      : { ASANA_TOOL_TIMEOUT_MS: process.env.ASANA_TOOL_TIMEOUT_MS }),
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(process.cwd(), "dist/index.js")],
    cwd: process.cwd(),
    env: childEnvironment,
    stderr: "pipe",
  });
  let serverStderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    serverStderr += chunk.toString();
  });
  const client = new Client({ name: "asana-command-live-validator", version: "1.0.0" });

  try {
    await probe("protocol_initialize", async () => {
      try {
        await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
      } catch {
        throw new EvidenceError("unknown", "built server did not complete MCP initialization");
      }
      const version = client.getServerVersion();
      if (version?.name !== "@asana/command-mcp" || typeof version.version !== "string") {
        throw new EvidenceError("unknown", "server identity was missing or unparseable");
      }
      return { value: undefined, detail: `initialized ${version.name} ${version.version}` };
    });
    if (
      !results.has("protocol_initialize") ||
      results.get("protocol_initialize")?.status !== "pass"
    ) {
      return;
    }

    await probe("tool_discovery", async () => {
      const discovery = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
      const names = discovery.tools.map((tool) => tool.name);
      if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
        throw new EvidenceError("fail", `advertised tools differ: ${names.join(", ")}`);
      }
      if (
        discovery.tools.some(
          (tool) =>
            tool.inputSchema === undefined ||
            tool.outputSchema === undefined ||
            tool.annotations === undefined,
        )
      ) {
        throw new EvidenceError("unknown", "one or more tool contracts were incomplete");
      }
      return { value: undefined, detail: `advertised all ${names.length} release tools` };
    });

    const workspaces = await probe("list_workspaces", async () => {
      const value = await callTool(client, "list_workspaces", {});
      const entries = arrayField(value, "workspaces");
      if (entries.length === 0) {
        throw new EvidenceError("fail", "authenticated identity has no accessible workspaces");
      }
      return { value, detail: `returned ${entries.length} accessible workspace(s)` };
    });

    const schema = await probe("get_teamspace_schema", async () => {
      const value = await callTool(client, "get_teamspace_schema", {
        teamspace_id: teamspaceId,
      });
      stringField(value, "fingerprint");
      objectField(value, "ticket_custom_type");
      return {
        value,
        detail: "fresh schema discovery returned the custom ticket type and fingerprint",
      };
    });

    if (schema === undefined) {
      return;
    }
    const workspace = objectField(schema, "workspace");
    const teamspace = objectField(schema, "teamspace");
    const workspaceGid = stringField(workspace, "gid");
    const teamspaceName = stringField(teamspace, "name");

    await probe("get_context", async () => {
      const value = await callTool(client, "get_context", { teamspace_id: teamspaceId });
      stringField(value, "schema_fingerprint");
      return { value, detail: "returned selected Teamspace context" };
    });

    await probe("find_teamspaces", async () => {
      const value = await callTool(client, "find_teamspaces", {
        workspace_gid: workspaceGid,
        query: teamspaceName,
        limit: 20,
      });
      const candidates = arrayField(value, "candidates");
      const found = candidates.some(
        (candidate) => isObject(candidate) && candidate.gid === teamspaceId,
      );
      if (!found) {
        throw new EvidenceError("unknown", "typeahead did not return the configured Teamspace");
      }
      if (value.truncated === true) {
        throw new EvidenceError("unknown", "Teamspace typeahead evidence was truncated");
      }
      return { value, detail: "found configured Teamspace through workspace typeahead" };
    });

    const releasesResult = await probe("list_teamspace_releases", async () => {
      const value = await callTool(client, "list_teamspace_releases", {
        teamspace_id: teamspaceId,
      });
      const releases = arrayField(value, "releases");
      return { value, detail: `returned ${releases.length} referenced Release(s)` };
    });

    let assigneeGid: string | undefined;
    await probe("current_user_for_ticket_fields", async () => {
      if (workspaceGid !== preflightSchema.workspace.gid) {
        throw new EvidenceError("fail", "preflight and MCP schema workspaces disagree");
      }
      assigneeGid = preflightAssigneeGid;
      return {
        value: preflightAssigneeGid,
        detail: "resolved current user through the OAuth request executor",
      };
    });

    const runId = `mcp-live-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const ticketType = firstOptionName(schema, "ticket_type_field");
    const label = firstOptionName(schema, "labels_field");
    const primaryFields =
      assigneeGid === undefined
        ? undefined
        : {
            name: `${runId} primary`,
            description: `${runId} release validation`,
            assignee: assigneeGid,
            predicted_start_on: dateFromNow(2),
            predicted_completion_on: dateFromNow(10),
            ...(ticketType === undefined ? {} : { type: ticketType }),
            ...(label === undefined ? {} : { labels: [label] }),
          };
    let primaryGid: string | undefined;
    let dependencyGid: string | undefined;

    const primary = await probe("create_ticket", async () => {
      if (primaryFields === undefined) {
        throw new EvidenceError("unknown", "assignee evidence is unavailable");
      }
      const created = await createTicket(client, teamspaceId, primaryFields);
      primaryGid = created.gid;
      return {
        value: created,
        detail: "created and initialized a ticket with every supported lifecycle field",
      };
    });

    if (primary !== undefined) {
      await probe("update_ticket", async () => {
        const value = await callTool(client, "update_ticket", {
          teamspace_id: teamspaceId,
          task_gid: primary.gid,
          name: `${runId} primary updated`,
        });
        if (value.status !== "succeeded") {
          throw new EvidenceError("unknown", "ticket update remained pending");
        }
        return { value, detail: "updated ticket and received authoritative post-write state" };
      });

      await probe("read_ticket", async () => {
        if (primaryFields === undefined) {
          throw new EvidenceError("unknown", "requested lifecycle fields were unavailable");
        }
        const value = await callTool(client, "read_ticket", {
          teamspace_id: teamspaceId,
          ticket_id: primary.gid,
        });
        const ticket = objectField(value, "ticket");
        if (ticket.name !== `${runId} primary updated`) {
          throw new EvidenceError("fail", "direct read did not return the updated name");
        }
        if (assigneeGid !== undefined && objectField(ticket, "assignee").gid !== assigneeGid) {
          throw new EvidenceError("fail", "direct read did not return the requested assignee");
        }
        const lifecycleFields = [
          "description",
          "predicted_start_on",
          "predicted_completion_on",
          "type",
        ] as const;
        for (const field of lifecycleFields) {
          if (field in primaryFields && ticket[field] !== primaryFields[field]) {
            throw new EvidenceError("fail", `direct read did not return requested ${field}`);
          }
        }
        if (
          "labels" in primaryFields &&
          JSON.stringify(ticket.labels) !== JSON.stringify(primaryFields.labels)
        ) {
          throw new EvidenceError("fail", "direct read did not return requested labels");
        }
        return { value, detail: "direct read confirmed the created ticket fields" };
      });

      const commentText = `${runId} verified comment`;
      await probe("add_comment", async () => {
        const value = await callTool(client, "add_comment", {
          teamspace_id: teamspaceId,
          ticket_id: primary.gid,
          text: commentText,
        });
        if (value.outcome !== "comment_added") {
          throw new EvidenceError("unknown", "comment mutation outcome was unparseable");
        }
        return { value, detail: "added and authoritatively verified a comment" };
      });

      await probe("get_comments", async () => {
        const value = await callTool(client, "get_comments", {
          teamspace_id: teamspaceId,
          ticket_id: primary.gid,
          limit: 100,
        });
        if (value.truncated === true) {
          throw new EvidenceError("unknown", "comment evidence was truncated");
        }
        const found = arrayField(value, "comments").some(
          (comment) => isObject(comment) && comment.text === commentText,
        );
        if (!found) {
          throw new EvidenceError("fail", "comment listing did not return the created comment");
        }
        return { value, detail: "comment listing returned the created comment" };
      });

      await probe("get_ticket_prs", async () => {
        const value = await callTool(client, "get_ticket_prs", {
          teamspace_id: teamspaceId,
          ticket_id: primary.gid,
        });
        arrayField(value, "results");
        if (arrayField(value, "warnings").length > 0) {
          throw new EvidenceError("unknown", "pull-request evidence was scan-limited");
        }
        return { value, detail: "completed bounded pull-request discovery" };
      });
    }

    const dependency = await probe("create_dependency_ticket", async () => {
      const created = await createTicket(client, teamspaceId, {
        name: `${runId} dependency`,
        description: `${runId} dependency validation`,
      });
      dependencyGid = created.gid;
      return { value: created, detail: "created the second bounded-work ticket" };
    });
    if (!results.has("pending_initialization_resume")) {
      record(
        "pending_initialization_resume",
        "unknown",
        "Asana initialized both creates before the one-second built-server polling bound",
      );
    }

    if (primary !== undefined && dependency !== undefined) {
      await probe("add_dependency", async () => {
        const value = await callTool(client, "add_dependency", {
          teamspace_id: teamspaceId,
          ticket: primary.gid,
          dependency: dependency.gid,
        });
        const found = arrayField(objectField(value, "data"), "dependencies").some(
          (entry) => isObject(entry) && entry.gid === dependency.gid,
        );
        if (!found) {
          throw new EvidenceError("fail", "dependency was absent from verified post-write state");
        }
        return { value, detail: "added dependency and verified authoritative state" };
      });
      await probe("remove_dependency", async () => {
        const value = await callTool(client, "remove_dependency", {
          teamspace_id: teamspaceId,
          ticket: primary.gid,
          dependency: dependency.gid,
        });
        const found = arrayField(objectField(value, "data"), "dependencies").some(
          (entry) => isObject(entry) && entry.gid === dependency.gid,
        );
        if (found) {
          throw new EvidenceError("fail", "dependency remained in verified post-write state");
        }
        return { value, detail: "removed dependency and verified authoritative state" };
      });
    }

    const releases = releasesResult === undefined ? [] : arrayField(releasesResult, "releases");
    const release = releases.find(isObject);
    if (primary !== undefined && release !== undefined) {
      const releaseGid = stringField(release, "gid");
      await probe("add_ticket_to_release", async () => {
        const value = await callTool(client, "add_ticket_to_release", {
          teamspace_id: teamspaceId,
          ticket_id: primary.gid,
          release: releaseGid,
        });
        const found = arrayField(objectField(value, "data"), "memberships").some(
          (entry) => isObject(entry) && entry.gid === releaseGid,
        );
        if (!found) {
          throw new EvidenceError("fail", "Release was absent from verified memberships");
        }
        return { value, detail: "added Release membership and verified direct state" };
      });
      await probe("remove_ticket_from_release", async () => {
        const value = await callTool(client, "remove_ticket_from_release", {
          teamspace_id: teamspaceId,
          ticket_id: primary.gid,
          release: releaseGid,
        });
        const found = arrayField(objectField(value, "data"), "memberships").some(
          (entry) => isObject(entry) && entry.gid === releaseGid,
        );
        if (found) {
          throw new EvidenceError("fail", "Release remained in verified memberships");
        }
        return { value, detail: "removed Release membership and verified direct state" };
      });
    } else {
      record("add_ticket_to_release", "unknown", "no referenced Release was available");
      record("remove_ticket_from_release", "unknown", "no referenced Release was available");
    }

    if (primaryGid !== undefined && dependencyGid !== undefined) {
      const expectedPrimaryGid = primaryGid;
      const expectedDependencyGid = dependencyGid;
      await probe("list_tickets", async () => {
        const expected = new Set([expectedPrimaryGid, expectedDependencyGid]);
        const expiresAt = Date.now() + SEARCH_TIMEOUT_MS;
        while (Date.now() < expiresAt) {
          const found = new Set<string>();
          let cursor: string | undefined;
          for (let page = 0; page < 20; page += 1) {
            const value = await callTool(
              client,
              "list_tickets",
              {
                teamspace_id: teamspaceId,
                limit: 100,
                ...(cursor === undefined ? {} : { cursor }),
              },
              Math.min(CALL_TIMEOUT_MS, expiresAt - Date.now()),
            );
            if (value.truncated === true) {
              throw new EvidenceError("unknown", "ticket listing evidence was truncated");
            }
            for (const ticket of arrayField(value, "tickets")) {
              if (isObject(ticket) && typeof ticket.gid === "string" && expected.has(ticket.gid)) {
                found.add(ticket.gid);
              }
            }
            if (found.size === expected.size) {
              return { value, detail: "bounded pagination returned both created tickets" };
            }
            if (value.next_cursor === null) {
              break;
            }
            if (typeof value.next_cursor !== "string") {
              throw new EvidenceError("unknown", "ticket listing cursor was unparseable");
            }
            cursor = value.next_cursor;
          }
          await delay(2_000);
        }
        throw new EvidenceError("unknown", "listing did not expose both tickets within the bound");
      });

      await probe("search_tickets", async () => {
        const expiresAt = Date.now() + SEARCH_TIMEOUT_MS;
        while (Date.now() < expiresAt) {
          const value = await callTool(
            client,
            "search_tickets",
            {
              teamspace_id: teamspaceId,
              text: runId,
              compact: true,
              limit: 20,
            },
            Math.min(CALL_TIMEOUT_MS, expiresAt - Date.now()),
          );
          if (value.truncated === true) {
            throw new EvidenceError("unknown", "search evidence was truncated");
          }
          const found = new Set(
            arrayField(value, "matches")
              .filter(isObject)
              .map((ticket) => ticket.gid)
              .filter((gid): gid is string => typeof gid === "string"),
          );
          if (found.has(expectedPrimaryGid) && found.has(expectedDependencyGid)) {
            return { value, detail: "bounded eventual-consistency retry found both tickets" };
          }
          await delay(3_000);
        }
        throw new EvidenceError("unknown", "search did not expose both tickets within the bound");
      });

      await probe("complete_ticket", async () => {
        const value = await callTool(client, "update_ticket", {
          teamspace_id: teamspaceId,
          task_gid: expectedPrimaryGid,
          completed: true,
        });
        const ticket = objectField(objectField(value, "data"), "ticket");
        if (ticket.completed !== true) {
          throw new EvidenceError(
            "fail",
            "completion was absent from authoritative post-write state",
          );
        }
        return { value, detail: "completed the primary ticket and verified direct state" };
      });
    }

    if (!serverStderr.includes("Asana Command MCP server ready (read-write mode)")) {
      record("protocol_initialize", "unknown", "built server readiness evidence was missing");
    }
    if (workspaces !== undefined) {
      const accessible = arrayField(workspaces, "workspaces").some(
        (candidate) => isObject(candidate) && candidate.gid === workspaceGid,
      );
      if (!accessible) {
        record("list_workspaces", "fail", "schema workspace was absent from workspace listing");
      }
    }
  } finally {
    await client.close().catch(() => undefined);
    await cleanupCreatedTasks();
  }
}

function fillMissingCapabilities(): void {
  for (const capability of [...EXPECTED_TOOLS, ...ADDITIONAL_CAPABILITIES]) {
    if (!results.has(capability)) {
      record(capability, "unknown", "prerequisite evidence was unavailable");
    }
  }
  for (const capability of ["protocol_initialize", "tool_discovery", "verified_cleanup"]) {
    if (!results.has(capability)) {
      record(capability, "unknown", "validation ended before evidence was collected");
    }
  }
}

async function main(): Promise<void> {
  try {
    await validate();
  } catch (error) {
    record("validation_runtime", "unknown", errorDetail(error));
    if (createdTaskGids.size > 0) {
      await cleanupCreatedTasks();
    }
  }

  fillMissingCapabilities();
  const orderedNames = [
    "configuration",
    "protocol_initialize",
    "tool_discovery",
    ...EXPECTED_TOOLS,
    ...ADDITIONAL_CAPABILITIES,
    "verified_cleanup",
    ...[...results.keys()].filter(
      (name) =>
        name !== "configuration" &&
        name !== "protocol_initialize" &&
        name !== "tool_discovery" &&
        name !== "verified_cleanup" &&
        !EXPECTED_TOOLS.includes(name as (typeof EXPECTED_TOOLS)[number]) &&
        !ADDITIONAL_CAPABILITIES.includes(name as (typeof ADDITIONAL_CAPABILITIES)[number]),
    ),
  ];
  const ordered = orderedNames
    .map((name) => results.get(name))
    .filter((result): result is CapabilityResult => result !== undefined);
  for (const result of ordered) {
    process.stdout.write(
      `${result.status.toUpperCase().padEnd(7)} ${result.capability}: ${result.detail}\n`,
    );
  }
  const summary = {
    pass: ordered.filter((result) => result.status === "pass").length,
    fail: ordered.filter((result) => result.status === "fail").length,
    unknown: ordered.filter((result) => result.status === "unknown").length,
  };
  process.stdout.write(
    `SUMMARY pass=${summary.pass} fail=${summary.fail} unknown=${summary.unknown}\n`,
  );
  process.exitCode = summary.fail === 0 && summary.unknown === 0 ? 0 : 1;
}

await main();
