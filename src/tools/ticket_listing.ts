import { z } from "zod";
import {
  COMPACT_SEARCH_TASK_FIELDS,
  FULL_TASK_FIELDS,
  type Task,
  TaskSchema,
} from "../asana_contracts.js";
import type { AsanaRequestExecutorPort, AsanaRequestTrace } from "../asana_gateway.js";
import { CommandError } from "../errors.js";
import { createCursorCodec } from "../pagination/cursor.js";
import {
  API_PAGE_MAX,
  createScanBudget,
  MAX_PAGE_REQUESTS,
  scanPages,
} from "../pagination/scanner.js";
import {
  type DiscoveryResult,
  discoveryToProvenance,
  resolveRelease,
} from "../schema_discovery.js";
import { normalizeName, ProvenanceSchema } from "../teamspace_identity.js";
import { projectTicketView, TicketViewSchema } from "./tickets.js";

const LIST_CURSOR_VERSION = 1;
const ALL_COMPLETED_TASKS_SINCE = "1970-01-01T00:00:00.000Z";

export const CompactTicketViewSchema = z
  .object({
    gid: z.string().regex(/^\d+$/).describe("Numeric Asana task GID"),
    name: z.string().describe("Ticket name"),
    created_at: z.string().datetime().describe("Asana creation timestamp"),
    completed_at: z
      .string()
      .datetime()
      .nullable()
      .describe("Asana completion timestamp or null"),
  })
  .strict();

export const ListTicketsOutputSchema = ProvenanceSchema.extend({
  tickets: z.array(TicketViewSchema).describe("Authoritative ticket views for this page"),
  next_cursor: z
    .string()
    .nullable()
    .describe("Opaque cursor for the next page, or null when no continuation is available"),
  has_more: z
    .boolean()
    .describe("Whether more source records may be available after this page"),
  scanned_count: z
    .number()
    .int()
    .nonnegative()
    .describe("Number of raw Teamspace tasks examined"),
  truncated: z
    .boolean()
    .describe("True when the safety scan bound stopped filtering before source exhaustion"),
});

export const SearchTicketsOutputSchema = ProvenanceSchema.extend({
  matches: z
    .union([z.array(TicketViewSchema), z.array(CompactTicketViewSchema)])
    .describe("Eventually consistent search matches in the requested output shape"),
  truncated: z
    .boolean()
    .describe("True when more matches existed than returned or source exhaustion was not proven"),
});

export type ListTicketsInput = {
  readonly cursor?: string;
  readonly limit: number;
  readonly completed?: boolean;
  readonly type?: string;
  readonly label?: string;
  readonly assignee?: string;
  readonly release?: string;
};

export type SearchTicketsInput = {
  readonly text?: string;
  readonly assignee?: string;
  readonly completed?: boolean;
  readonly "due_on.before"?: string;
  readonly "due_on.after"?: string;
  readonly "completed_on.before"?: string;
  readonly "completed_on.after"?: string;
  readonly compact: boolean;
  readonly limit: number;
};

export type ListTicketsOutput = z.infer<typeof ListTicketsOutputSchema>;
export type SearchTicketsOutput = z.infer<typeof SearchTicketsOutputSchema>;

export type TicketListingServiceOptions = {
  readonly maxScanTasks: number;
};

export type TicketListingService = {
  listTickets(
    input: ListTicketsInput,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<ListTicketsOutput>;
  searchTickets(
    input: SearchTicketsInput,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<SearchTicketsOutput>;
};

type ListCursorBinding = {
  readonly teamspaceId: string;
  readonly limit: number;
  readonly completed?: boolean;
  readonly type?: string;
  readonly label?: string;
  readonly assignee?: string;
  readonly release?: string;
};

type WorkspaceSearchOptions = {
  text?: string;
  resource_subtype?: string;
  "assignee.any"?: string;
  "projects.any"?: string;
  "due_on.before"?: string;
  "due_on.after"?: string;
  "completed_on.before"?: string;
  "completed_on.after"?: string;
  "created_at.after"?: string;
  completed?: boolean;
  sort_by?: string;
  sort_ascending?: boolean;
  opt_fields?: string;
  limit?: number;
};

const listCursorCodec = createCursorCodec<ListCursorBinding>({
  version: LIST_CURSOR_VERSION,
  canonicalizeBinding: (binding) => ({
    teamspace_id: binding.teamspaceId,
    limit: binding.limit,
    ...(binding.completed === undefined ? {} : { completed: binding.completed }),
    ...(binding.type === undefined ? {} : { type: normalizeName(binding.type) }),
    ...(binding.label === undefined ? {} : { label: normalizeName(binding.label) }),
    ...(binding.assignee === undefined ? {} : { assignee: normalizeName(binding.assignee) }),
    ...(binding.release === undefined ? {} : { release: normalizeName(binding.release) }),
  }),
  invalidMessage:
    "The list_tickets cursor is invalid. Restart without a cursor using the same filters and limit.",
});

function domainError(
  code: "schema_drift" | "schema_incompatible",
  message: string,
  trace: AsanaRequestTrace,
): CommandError {
  return new CommandError(code, message, {
    asanaRequestIds: [...trace.requestIds],
  });
}

function isCommandTicket(
  task: Task,
  snapshot: DiscoveryResult,
  trace: AsanaRequestTrace,
): boolean {
  if (task.resource_subtype === undefined || task.custom_type === undefined) {
    throw domainError("schema_drift", "Asana task response omitted ticket identity fields", trace);
  }
  return (
    task.resource_subtype === "custom" &&
    task.custom_type !== null &&
    task.custom_type.gid === snapshot.ticket_custom_type.gid
  );
}

function projectTicket(task: Task, snapshot: DiscoveryResult, trace: AsanaRequestTrace) {
  try {
    return projectTicketView(task, snapshot);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new CommandError("schema_drift", "Ticket view did not match its contract", {
        details: {
          issues: error.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
          })),
        },
        asanaRequestIds: [...trace.requestIds],
        cause: error,
      });
    }
    throw error;
  }
}

function normalizedEquals(actual: string, expected: string): boolean {
  return normalizeName(actual) === normalizeName(expected);
}

function matchesAssignee(
  assignee: ListTicketsInput["assignee"],
  ticket: z.infer<typeof TicketViewSchema>,
): boolean {
  if (assignee === undefined) {
    return true;
  }
  if (ticket.assignee === null) {
    return false;
  }
  return (
    normalizedEquals(ticket.assignee.gid, assignee) ||
    normalizedEquals(ticket.assignee.name, assignee) ||
    (ticket.assignee.email !== undefined && normalizedEquals(ticket.assignee.email, assignee))
  );
}

function hasProject(task: Task, projectGid: string, trace: AsanaRequestTrace): boolean {
  if (task.projects === undefined) {
    throw domainError("schema_drift", "Asana task response omitted project membership", trace);
  }
  return task.projects.some((project) => project.gid === projectGid);
}

function listBinding(input: ListTicketsInput, snapshot: DiscoveryResult): ListCursorBinding {
  return {
    teamspaceId: snapshot.teamspace.gid,
    limit: input.limit,
    ...(input.completed === undefined ? {} : { completed: input.completed }),
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
    ...(input.release === undefined ? {} : { release: input.release }),
  };
}

function priorMillisecond(timestamp: string): string {
  return new Date(Date.parse(timestamp) - 1).toISOString();
}

function compactTicket(task: Task) {
  return CompactTicketViewSchema.parse({
    gid: task.gid,
    name: task.name,
    created_at: task.created_at,
    completed_at: task.completed_at,
  });
}

export function createTicketListingService(
  executor: AsanaRequestExecutorPort,
  options: TicketListingServiceOptions,
): TicketListingService {
  const { maxScanTasks } = options;

  async function listTickets(
    input: ListTicketsInput,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<ListTicketsOutput> {
    if (input.type !== undefined && snapshot.ticket_type_field === null) {
      throw new CommandError(
        "schema_incompatible",
        "Ticket type filtering is unavailable because the Teamspace has no ticket type field",
      );
    }
    const release =
      input.release === undefined ? undefined : resolveRelease(snapshot, input.release);
    const binding = listBinding(input, snapshot);
    const startOffset =
      input.cursor === undefined ? undefined : listCursorCodec.decode(input.cursor, binding).offset;
    const trace = executor.createTrace();
    const budget = createScanBudget(maxScanTasks);

    const scan = await scanPages({
      ...(startOffset === undefined ? {} : { startOffset }),
      limit: input.limit,
      budget,
      loadPage: async (pageSize, offset) => {
        const page = await executor.readPage(
          TaskSchema,
          { deadlineMs },
          async (resources) =>
            resources.tasks.getTasksForProjectWithHttpInfo(snapshot.teamspace.gid, {
              completed_since: ALL_COMPLETED_TASKS_SINCE,
              limit: pageSize,
              ...(offset === undefined ? {} : { offset }),
              opt_fields: FULL_TASK_FIELDS,
            }),
          trace,
        );
        return {
          items: page.items,
          ...(page.nextPageOffset === null ? {} : { nextOffset: page.nextPageOffset }),
        };
      },
      visit: (task) => {
        if (!isCommandTicket(task, snapshot, trace)) {
          return undefined;
        }
        const ticket = projectTicket(task, snapshot, trace);
        if (input.completed !== undefined && ticket.completed !== input.completed) {
          return undefined;
        }
        if (
          input.type !== undefined &&
          (ticket.type === null || !normalizedEquals(ticket.type, input.type))
        ) {
          return undefined;
        }
        if (
          input.label !== undefined &&
          !ticket.labels.some((label) => normalizedEquals(label, input.label as string))
        ) {
          return undefined;
        }
        if (!matchesAssignee(input.assignee, ticket)) {
          return undefined;
        }
        if (release !== undefined && !hasProject(task, release.gid, trace)) {
          return undefined;
        }
        return ticket;
      },
    });

    return ListTicketsOutputSchema.parse({
      ...discoveryToProvenance(snapshot),
      tickets: scan.results,
      next_cursor:
        scan.nextOffset === undefined ? null : listCursorCodec.encode(scan.nextOffset, binding),
      has_more: scan.hasMore,
      scanned_count: scan.examined,
      truncated: scan.truncated,
    });
  }

  async function searchTickets(
    input: SearchTicketsInput,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<SearchTicketsOutput> {
    const trace = executor.createTrace();
    const budget = createScanBudget(maxScanTasks);
    const seenGids = new Set<string>();
    const matches: Array<
      z.infer<typeof TicketViewSchema> | z.infer<typeof CompactTicketViewSchema>
    > = [];
    let sourceExhausted = false;
    let boundary: string | undefined;
    let newestSeenMs: number | undefined;
    let pageRequests = 0;

    while (!budget.exhausted && matches.length <= input.limit) {
      if (pageRequests >= MAX_PAGE_REQUESTS) {
        break;
      }
      const requestedCount = Math.min(
        API_PAGE_MAX,
        budget.remaining,
        Math.max(1, input.limit + 1 - matches.length),
      );
      const searchOptions: WorkspaceSearchOptions = {
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.assignee === undefined ? {} : { "assignee.any": input.assignee }),
        ...(input.completed === undefined ? {} : { completed: input.completed }),
        ...(input["due_on.before"] === undefined
          ? {}
          : { "due_on.before": input["due_on.before"] }),
        ...(input["due_on.after"] === undefined
          ? {}
          : { "due_on.after": input["due_on.after"] }),
        ...(input["completed_on.before"] === undefined
          ? {}
          : { "completed_on.before": input["completed_on.before"] }),
        ...(input["completed_on.after"] === undefined
          ? {}
          : { "completed_on.after": input["completed_on.after"] }),
        ...(boundary === undefined ? {} : { "created_at.after": boundary }),
        "projects.any": snapshot.teamspace.gid,
        resource_subtype: "custom",
        sort_by: "created_at",
        sort_ascending: true,
        opt_fields: input.compact ? COMPACT_SEARCH_TASK_FIELDS : FULL_TASK_FIELDS,
        limit: requestedCount,
      };

      pageRequests += 1;
      const page = await executor.readPage(
        TaskSchema,
        { deadlineMs },
        async (resources) =>
          resources.tasks.searchTasksForWorkspaceWithHttpInfo(
            snapshot.workspace.gid,
            searchOptions,
          ),
        trace,
      );
      const items = page.items.slice(0, budget.remaining);
      let newRecords = 0;
      let pageNewestMs: number | undefined;
      for (const task of items) {
        if (!budget.consume()) {
          break;
        }
        const createdMs = Date.parse(task.created_at);
        pageNewestMs =
          pageNewestMs === undefined ? createdMs : Math.max(pageNewestMs, createdMs);
        if (seenGids.has(task.gid)) {
          continue;
        }
        seenGids.add(task.gid);
        newRecords += 1;
        if (
          !isCommandTicket(task, snapshot, trace) ||
          !hasProject(task, snapshot.teamspace.gid, trace)
        ) {
          continue;
        }
        matches.push(input.compact ? compactTicket(task) : projectTicket(task, snapshot, trace));
      }

      if (page.items.length < requestedCount) {
        sourceExhausted = true;
        break;
      }

      const boundaryAdvanced =
        pageNewestMs !== undefined &&
        (newestSeenMs === undefined || pageNewestMs > newestSeenMs);
      if (pageNewestMs !== undefined) {
        if (boundaryAdvanced) {
          newestSeenMs = pageNewestMs;
        }
        boundary = priorMillisecond(new Date(pageNewestMs).toISOString());
      }
      if (newRecords === 0 && !boundaryAdvanced) {
        break;
      }
    }

    return SearchTicketsOutputSchema.parse({
      ...discoveryToProvenance(snapshot),
      matches: matches.slice(0, input.limit),
      truncated: matches.length > input.limit || !sourceExhausted,
    });
  }

  return { listTickets, searchTickets };
}
