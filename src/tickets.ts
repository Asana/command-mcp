import { z } from "zod";
import {
  FULL_TASK_FIELDS,
  GidSchema,
  type Task,
  TaskSchema,
} from "./asana_contracts.js";
import type {
  AsanaRequestExecutorPort,
  AsanaRequestTrace,
} from "./asana_gateway.js";
import { tryParseAsanaAppUrl } from "./asana_url.js";
import { CommandError } from "./errors.js";
import {
  type DiscoveryResult,
  discoveryToProvenance,
} from "./schema_discovery.js";
import { ProvenanceSchema } from "./teamspace_identity.js";
import { DateOnlySchema, TicketIdentifierSchema } from "./ticket_inputs.js";

const SHORT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

const TicketLookupSchema = z.object({
  gid: GidSchema,
});

const AssigneeViewSchema = z.object({
  gid: GidSchema.describe("Numeric Asana user GID"),
  name: z.string().describe("Assignee display name"),
  email: z.string().describe("Assignee email when Asana returns it").optional(),
});

const DependencyViewSchema = z.object({
  gid: GidSchema.describe("Numeric GID of a task blocking this ticket"),
  name: z.string().describe("Blocking task name when Asana returns it").optional(),
});

export const TicketViewSchema = z.object({
  gid: GidSchema.describe("Numeric Asana task GID"),
  short_id: z.string().nullable().describe("Command short ID or null when unavailable"),
  name: z.string().describe("Ticket name"),
  description: z.string().describe("Ticket description as plain text"),
  created_at: z.string().datetime().describe("Authoritative Asana creation timestamp"),
  completed: z.boolean().describe("Authoritative Asana completion state"),
  completed_at: z
    .string()
    .datetime()
    .nullable()
    .describe("Authoritative Asana completion timestamp or null"),
  type: z.string().nullable().describe("Teamspace-local ticket type name or null"),
  labels: z.array(z.string()).describe("Teamspace-local label names"),
  assignee: AssigneeViewSchema.nullable().describe("Assigned Asana user or null"),
  due_on: DateOnlySchema.nullable().describe("Due date or null"),
  predicted_start_on: DateOnlySchema.nullable().describe("Predicted start date or null"),
  predicted_completion_on: DateOnlySchema.nullable().describe(
    "Predicted completion date or null",
  ),
  dependencies: z.array(DependencyViewSchema).describe("Tasks blocking this ticket"),
  url: z.string().url().nullable().describe("Canonical Asana task URL or null"),
});

export const ReadTicketOutputSchema = ProvenanceSchema.extend({
  ticket: TicketViewSchema.describe("The resolved Command ticket"),
});

export type TicketView = z.infer<typeof TicketViewSchema>;
export type ReadTicketOutput = z.infer<typeof ReadTicketOutputSchema>;

export type TicketResolutionOptions = {
  readonly allowMissingCustomType?: boolean;
  readonly trace?: AsanaRequestTrace;
};

export type TicketService = {
  resolve(
    identifier: string,
    snapshot: DiscoveryResult,
    deadlineMs: number,
    options?: TicketResolutionOptions,
  ): Promise<Task>;
  readByGid(gid: string, deadlineMs: number, trace?: AsanaRequestTrace): Promise<Task>;
  readTicket(
    identifier: string,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<ReadTicketOutput>;
};

function invalidTicketIdentifier(message: string): never {
  throw new CommandError("invalid_input", message, {
    details: {
      issues: [
        {
          path: ["ticket_id"],
          message:
            "expected an Asana task GID, a Command short ID such as ABC-42, or an Asana task URL",
        },
      ],
    },
  });
}

function parseTicketReference(identifier: string):
  | { kind: "gid"; gid: string }
  | { kind: "short_id"; shortId: string } {
  const parsedIdentifier = TicketIdentifierSchema.safeParse(identifier);
  if (!parsedIdentifier.success) {
    invalidTicketIdentifier("Invalid ticket identifier");
  }
  const value = parsedIdentifier.data;
  const parsedUrl = tryParseAsanaAppUrl(value);
  if (parsedUrl !== null) {
    const numericSegments = parsedUrl.pathname
      .split("/")
      .filter((segment) => GidSchema.safeParse(segment).success);
    const gid = numericSegments.at(-1);
    if (gid === undefined) {
      invalidTicketIdentifier("Asana task URL does not contain a numeric task GID");
    }
    return { kind: "gid", gid };
  }
  if (GidSchema.safeParse(value).success) {
    return { kind: "gid", gid: value };
  }
  if (SHORT_ID_PATTERN.test(value)) {
    return { kind: "short_id", shortId: value };
  }
  invalidTicketIdentifier("Invalid ticket identifier");
}

function requireScope(task: Task, snapshot: DiscoveryResult): void {
  if (task.projects === undefined) {
    throw new CommandError("schema_drift", "Asana task response omitted project membership");
  }
  if (!task.projects.some((project) => project.gid === snapshot.teamspace.gid)) {
    throw new CommandError("out_of_scope", "Ticket is outside the selected Teamspace");
  }
}

function requireTicketIdentity(
  task: Task,
  snapshot: DiscoveryResult,
  allowMissingCustomType: boolean,
): void {
  if (task.custom_type === undefined || task.resource_subtype === undefined) {
    throw new CommandError("schema_drift", "Asana task response omitted ticket identity fields");
  }
  if (task.custom_type === null && allowMissingCustomType) {
    return;
  }
  if (
    task.resource_subtype !== "custom" ||
    task.custom_type === null ||
    task.custom_type.gid !== snapshot.ticket_custom_type.gid
  ) {
    throw new CommandError(
      "schema_incompatible",
      "Task is not a Command ticket for the selected Teamspace",
    );
  }
}

function customField(task: Task, gid: string) {
  return task.custom_fields?.find((field) => field.gid === gid);
}

function projectedDate(task: Task, fieldGid: string): string | null {
  const value = customField(task, fieldGid)?.date_value;
  const projected = value?.date ?? value?.date_time?.slice(0, 10) ?? null;
  return projected === null ? null : DateOnlySchema.parse(projected);
}

export function projectTicketView(task: Task, snapshot: DiscoveryResult): TicketView {
  const shortIdField = customField(task, snapshot.ticket_short_id_field.gid);
  const typeField =
    snapshot.ticket_type_field === null
      ? undefined
      : customField(task, snapshot.ticket_type_field.gid);
  const labelsField = customField(task, snapshot.labels_field.gid);

  const assignee =
    task.assignee == null
      ? null
      : {
          gid: task.assignee.gid,
          name: task.assignee.name,
          ...(task.assignee.email === undefined ? {} : { email: task.assignee.email }),
        };
  const dependencies = (task.dependencies ?? []).map((dependency) => ({
    gid: dependency.gid,
    ...(dependency.name === undefined ? {} : { name: dependency.name }),
  }));

  return TicketViewSchema.parse({
    gid: task.gid,
    short_id: shortIdField?.custom_id_value ?? shortIdField?.display_value ?? null,
    name: task.name,
    description: task.notes ?? "",
    created_at: task.created_at,
    completed: task.completed,
    completed_at: task.completed_at,
    type: typeField?.enum_value?.name ?? null,
    labels: (labelsField?.multi_enum_values ?? []).map((option) => option.name),
    assignee,
    due_on: task.due_on ?? null,
    predicted_start_on: projectedDate(task, snapshot.predicted_start_date_field.gid),
    predicted_completion_on: projectedDate(task, snapshot.predicted_completion_date_field.gid),
    dependencies,
    url: task.permalink_url ?? null,
  });
}

export function createTicketService(executor: AsanaRequestExecutorPort): TicketService {
  async function readByGid(
    gid: string,
    deadlineMs: number,
    trace: AsanaRequestTrace = executor.createTrace(),
  ): Promise<Task> {
    return executor.read(
      TaskSchema,
      { deadlineMs },
      async (resources) =>
        resources.tasks.getTaskWithHttpInfo(gid, {
          opt_fields: FULL_TASK_FIELDS,
        }),
      trace,
    );
  }

  async function resolve(
    identifier: string,
    snapshot: DiscoveryResult,
    deadlineMs: number,
    options: TicketResolutionOptions = {},
  ): Promise<Task> {
    const reference = parseTicketReference(identifier);
    const trace = options.trace ?? executor.createTrace();
    let gid: string;
    if (reference.kind === "gid") {
      gid = reference.gid;
    } else {
      const lookup = await executor.read(
        TicketLookupSchema,
        { deadlineMs },
        async (resources) =>
          resources.tasks.getTaskForCustomIDWithHttpInfo(
            snapshot.workspace.gid,
            reference.shortId,
          ),
        trace,
      );
      gid = lookup.gid;
    }

    const task = await readByGid(gid, deadlineMs, trace);
    requireScope(task, snapshot);
    requireTicketIdentity(task, snapshot, options.allowMissingCustomType ?? false);
    return task;
  }

  async function readTicket(
    identifier: string,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<ReadTicketOutput> {
    const ticket = await resolve(identifier, snapshot, deadlineMs);
    return ReadTicketOutputSchema.parse({
      ...discoveryToProvenance(snapshot),
      ticket: projectTicketView(ticket, snapshot),
    });
  }

  return { resolve, readByGid, readTicket };
}
