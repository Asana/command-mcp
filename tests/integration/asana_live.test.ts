import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/doctor.js";
import type { DiscoveryResult } from "../../src/schema_discovery.js";
import { buildServices, type CommandServices } from "../../src/services.js";
import type { CreateTicketFields, UpdateTicketFields } from "../../src/ticket_inputs.js";
import { createTicketService, type TicketService } from "../../src/tools/tickets.js";
import {
  CreatedTaskCleanup,
  currentUser,
  deadline,
  delay,
  integrationConfig,
  readIntegrationEnvironment,
} from "./live_asana.js";

const SUITE_TIMEOUT_MS = 240_000;
const SEARCH_TIMEOUT_MS = 60_000;
const INITIALIZATION_TIMEOUT_MS = 60_000;
const LIFECYCLE_WORK_TIMEOUT_MS = 300_000;
const LIFECYCLE_TEST_TIMEOUT_MS = 600_000;
const gate = readIntegrationEnvironment(process.env);
const environment = gate.ready ? gate.environment : undefined;
const writesEnabled = environment?.disposable === true;

if (!gate.ready) {
  console.warn(gate.reason);
} else if (!writesEnabled) {
  console.warn(
    "live Asana write tests skipped: set ASANA_INTEGRATION_TEST_DISPOSABLE=true only for a disposable Teamspace",
  );
}

function dateFromNow(days: number): string {
  const value = new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  if (value.length === 0) {
    throw new Error("Could not construct integration-test date");
  }
  return value;
}

async function resumePendingTicket(
  services: CommandServices,
  snapshot: DiscoveryResult,
  taskGid: string,
  fields: UpdateTicketFields,
  workDeadlineMs: number,
): Promise<void> {
  const expiresAt = Math.min(workDeadlineMs, Date.now() + INITIALIZATION_TIMEOUT_MS);
  let pendingFields = fields;
  while (Date.now() < expiresAt) {
    const result = await services.tickets.updateTicket(
      taskGid,
      pendingFields,
      snapshot,
      workDeadlineMs,
    );
    if (result.status === "succeeded") {
      return;
    }
    pendingFields = result.data.pending_updates.update_ticket;
    await delay(1_000);
  }
  throw new Error(`Ticket ${taskGid} did not finish custom-type initialization within the bound`);
}

async function createAndInitialize(
  creator: TicketService,
  services: CommandServices,
  cleanup: CreatedTaskCleanup,
  snapshot: DiscoveryResult,
  fields: CreateTicketFields,
  workDeadlineMs: number,
): Promise<{ gid: string; wasPending: boolean }> {
  const result = await creator.createTicket(fields, snapshot, workDeadlineMs);
  const gid = result.status === "succeeded" ? result.data.ticket.gid : result.data.task_gid;
  cleanup.track(gid);
  if (result.status === "pending") {
    await resumePendingTicket(
      services,
      snapshot,
      gid,
      result.data.pending_updates.update_ticket,
      workDeadlineMs,
    );
  }
  return { gid, wasPending: result.status === "pending" };
}

async function expectListed(
  services: CommandServices,
  snapshot: DiscoveryResult,
  expectedGids: readonly string[],
  workDeadlineMs: number,
): Promise<void> {
  const expiresAt = Math.min(workDeadlineMs, Date.now() + SEARCH_TIMEOUT_MS);
  while (Date.now() < expiresAt) {
    const found = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await services.ticketListing.listTickets(
        {
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
        snapshot,
        workDeadlineMs,
      );
      expect(result.truncated).toBe(false);
      for (const ticket of result.tickets) {
        if (expectedGids.includes(ticket.gid)) {
          found.add(ticket.gid);
        }
      }
      if (found.size === expectedGids.length) {
        return;
      }
      if (result.next_cursor === null) {
        break;
      }
      cursor = result.next_cursor;
    }
    await delay(2_000);
  }
  throw new Error("Created tickets did not become visible in bounded Teamspace listing");
}

async function expectEventuallySearchable(
  services: CommandServices,
  snapshot: DiscoveryResult,
  searchText: string,
  expectedGids: readonly string[],
  workDeadlineMs: number,
): Promise<void> {
  const expiresAt = Math.min(workDeadlineMs, Date.now() + SEARCH_TIMEOUT_MS);
  while (Date.now() < expiresAt) {
    const result = await services.ticketListing.searchTickets(
      {
        text: searchText,
        compact: true,
        limit: 20,
      },
      snapshot,
      workDeadlineMs,
    );
    const gids = new Set(result.matches.map((ticket) => ticket.gid));
    if (expectedGids.every((gid) => gids.has(gid))) {
      return;
    }
    await delay(3_000);
  }
  throw new Error("Created tickets did not become visible in bounded Asana search");
}

describe.skipIf(environment === undefined)("live Asana authentication and schema", () => {
  it(
    "authenticates and proves the custom-types opt-in through real schema discovery",
    async () => {
      if (environment === undefined) {
        return;
      }
      const config = integrationConfig(environment);
      const report = await runDoctor([environment.teamspaceId], config, {
        deadlineMs: deadline(),
      });

      expect(report.status).toBe("passed");
      expect(report.authentication.workspaces.length).toBeGreaterThan(0);
      expect(report.teamspace_schema?.teamspace.gid).toBe(environment.teamspaceId);
      expect(report.teamspace_schema?.schema_fingerprint).not.toBe("");
      expect(report.asana_custom_types_opt_in).toEqual({ status: "passed" });
    },
    SUITE_TIMEOUT_MS,
  );
});

describe.skipIf(!writesEnabled)("live Asana disposable Teamspace lifecycle", () => {
  it(
    "exercises tickets, comments, Releases, dependencies, listing, search, and scope safety",
    async () => {
      if (environment === undefined || !environment.disposable) {
        return;
      }

      const config = integrationConfig(environment);
      const services = buildServices(config);
      const cleanup = new CreatedTaskCleanup(services.executor, services);
      const runId = `mcp-live-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const workDeadlineMs = Date.now() + LIFECYCLE_WORK_TIMEOUT_MS;

      try {
        const snapshot = await services.schemaDiscovery.discover(
          environment.teamspaceId,
          workDeadlineMs,
        );
        const me = await currentUser(environment, snapshot.workspace.gid);
        const createFields: CreateTicketFields = {
          name: `${runId} primary`,
          description: `${runId} integration lifecycle`,
          assignee: me.gid,
          predicted_start_on: dateFromNow(2),
          predicted_completion_on: dateFromNow(10),
          ...(snapshot.ticket_type_field?.enum_options[0]?.name === undefined
            ? {}
            : { type: snapshot.ticket_type_field.enum_options[0].name }),
          ...(snapshot.labels_field.enum_options[0]?.name === undefined
            ? {}
            : { labels: [snapshot.labels_field.enum_options[0].name] }),
        };

        const primary = await createAndInitialize(
          services.tickets,
          services,
          cleanup,
          snapshot,
          createFields,
          workDeadlineMs,
        );
        const primaryRead = await services.tickets.readTicket(
          primary.gid,
          snapshot,
          workDeadlineMs,
        );
        expect(primaryRead.ticket).toMatchObject({
          name: createFields.name,
          description: createFields.description,
          assignee: { gid: me.gid },
          predicted_start_on: createFields.predicted_start_on,
          predicted_completion_on: createFields.predicted_completion_on,
        });
        if (createFields.type !== undefined) {
          expect(primaryRead.ticket.type).toBe(createFields.type);
        }
        if (createFields.labels !== undefined) {
          expect(primaryRead.ticket.labels).toEqual(createFields.labels);
        }

        const pendingCreator = createTicketService(services.executor, {
          createTimeoutMs: 0,
        });
        const dependency = await createAndInitialize(
          pendingCreator,
          services,
          cleanup,
          snapshot,
          {
            name: `${runId} dependency`,
            description: `${runId} forced pending initialization`,
          },
          workDeadlineMs,
        );
        expect(dependency.wasPending).toBe(true);

        const commentText = `${runId} verified comment`;
        const addedComment = await services.comments.addComment(
          { ticketId: primary.gid, text: commentText },
          snapshot,
          workDeadlineMs,
        );
        expect(addedComment.outcome).toBe("comment_added");
        const comments = await services.comments.getComments(
          { ticketId: primary.gid, limit: 100 },
          snapshot,
          workDeadlineMs,
        );
        expect(comments.comments.some((comment) => comment.text === commentText)).toBe(true);

        expect(
          snapshot.releases.length,
          "Disposable Teamspace must reference a Release",
        ).toBeGreaterThan(0);
        const release = snapshot.releases[0];
        if (release === undefined) {
          throw new Error("Disposable Teamspace did not expose a Release");
        }
        const addedRelease = await services.releases.addTicketToRelease(
          primary.gid,
          release.gid,
          snapshot,
          workDeadlineMs,
        );
        expect(
          addedRelease.data.memberships.some((entry: { gid: string }) => entry.gid === release.gid),
        ).toBe(true);
        const removedRelease = await services.releases.removeTicketFromRelease(
          primary.gid,
          release.gid,
          snapshot,
          workDeadlineMs,
        );
        expect(
          removedRelease.data.memberships.some(
            (entry: { gid: string }) => entry.gid === release.gid,
          ),
        ).toBe(false);

        const addedDependency = await services.workflow.addDependency(
          primary.gid,
          dependency.gid,
          snapshot,
          workDeadlineMs,
        );
        expect(
          addedDependency.data.dependencies.some(
            (entry: { gid: string }) => entry.gid === dependency.gid,
          ),
        ).toBe(true);
        const removedDependency = await services.workflow.removeDependency(
          primary.gid,
          dependency.gid,
          snapshot,
          workDeadlineMs,
        );
        expect(
          removedDependency.data.dependencies.some(
            (entry: { gid: string }) => entry.gid === dependency.gid,
          ),
        ).toBe(false);

        const update = await services.tickets.updateTicket(
          primary.gid,
          {
            name: `${runId} primary updated`,
            completed: true,
          },
          snapshot,
          workDeadlineMs,
        );
        expect(update.status).toBe("succeeded");
        if (update.status === "succeeded") {
          expect(update.data.ticket.completed).toBe(true);
          expect(update.data.ticket.name).toBe(`${runId} primary updated`);
        }

        await expectListed(services, snapshot, [primary.gid, dependency.gid], workDeadlineMs);
        await expectEventuallySearchable(
          services,
          snapshot,
          runId,
          [primary.gid, dependency.gid],
          workDeadlineMs,
        );

        if (environment.secondTeamspaceId !== undefined) {
          const secondSnapshot = await services.schemaDiscovery.discover(
            environment.secondTeamspaceId,
            workDeadlineMs,
          );
          await expect(
            services.tickets.readTicket(primary.gid, secondSnapshot, workDeadlineMs),
          ).rejects.toMatchObject({ code: "out_of_scope" });
        } else {
          console.warn(
            "cross-scope live assertion skipped: ASANA_INTEGRATION_TEST_SECOND_TEAMSPACE is not set",
          );
        }
      } finally {
        await cleanup.run();
      }
    },
    LIFECYCLE_TEST_TIMEOUT_MS,
  );
});
