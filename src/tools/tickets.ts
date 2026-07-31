import { z } from "zod";
import {
  FULL_TASK_FIELDS,
  GidSchema,
  TASK_INITIALIZATION_FIELDS,
  type Task,
  TaskSchema,
} from "../asana_contracts.js";
import type { AsanaRequestExecutorPort, AsanaRequestTrace } from "../asana_gateway.js";
import { tryParseAsanaAppUrl } from "../asana_url.js";
import { CommandError } from "../errors.js";
import {
  buildMutationResult,
  mutationVariant,
  mutationVariantsToSchemas,
} from "../mutation_envelope.js";
import {
  type DiscoveryResult,
  discoveryToProvenance,
  type FieldDefinition,
  resolveEnumOptionName,
} from "../schema_discovery.js";
import { normalizeName, ProvenanceSchema } from "../teamspace_identity.js";
import {
  type CreateTicketFields,
  DateOnlySchema,
  type PendingInitialization,
  PendingInitializationSchema,
  TicketIdentifierSchema,
  type UpdateTicketFields,
} from "../ticket_inputs.js";

const SHORT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const DEFAULT_CREATE_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export const CREATE_PENDING_WARNING =
  "Do not call create_ticket again. Use update_ticket with task_gid once initialization completes.";
export const UPDATE_PENDING_WARNING =
  "Initialization is still pending. Retry update_ticket with the same task GID.";

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
  predicted_completion_on: DateOnlySchema.nullable().describe("Predicted completion date or null"),
  dependencies: z.array(DependencyViewSchema).describe("Tasks blocking this ticket"),
  url: z.string().url().nullable().describe("Canonical Asana task URL or null"),
});

export const ReadTicketOutputSchema = ProvenanceSchema.extend({
  ticket: TicketViewSchema.describe("The resolved Command ticket"),
});

const TicketMutationDataSchema = z.object({
  ticket: TicketViewSchema,
});

export const CreateTicketSucceededVariant = mutationVariant(
  "succeeded",
  "created",
  TicketMutationDataSchema,
);
export const CreateTicketPendingVariant = mutationVariant(
  "pending",
  "initialization_pending",
  PendingInitializationSchema,
);
const createTicketSchemas = mutationVariantsToSchemas([
  CreateTicketSucceededVariant,
  CreateTicketPendingVariant,
]);
export const CreateTicketOutputSchema = createTicketSchemas.runtimeSchema;
export const CreateTicketProtocolOutputSchema = createTicketSchemas.protocolSchema;

export const UpdateTicketSucceededVariant = mutationVariant(
  "succeeded",
  "updated",
  TicketMutationDataSchema,
);
export const UpdateTicketPendingVariant = mutationVariant(
  "pending",
  "initialization_pending",
  PendingInitializationSchema,
);
const updateTicketSchemas = mutationVariantsToSchemas([
  UpdateTicketSucceededVariant,
  UpdateTicketPendingVariant,
]);
export const UpdateTicketOutputSchema = updateTicketSchemas.runtimeSchema;
export const UpdateTicketProtocolOutputSchema = updateTicketSchemas.protocolSchema;

export type TicketView = z.infer<typeof TicketViewSchema>;
export type ReadTicketOutput = z.infer<typeof ReadTicketOutputSchema>;
export type CreateTicketOutput = z.infer<typeof CreateTicketOutputSchema>;
export type UpdateTicketOutput = z.infer<typeof UpdateTicketOutputSchema>;

export type TicketResolutionOptions = {
  readonly allowMissingCustomType?: boolean;
  readonly trace?: AsanaRequestTrace;
};

export type TicketServiceOptions = {
  readonly createTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
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
  createTicket(
    fields: CreateTicketFields,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<CreateTicketOutput>;
  updateTicket(
    identifier: string,
    fields: UpdateTicketFields,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<UpdateTicketOutput>;
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

function parseTicketReference(
  identifier: string,
): { kind: "gid"; gid: string } | { kind: "short_id"; shortId: string } {
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

function domainError(
  code: "schema_drift" | "out_of_scope" | "schema_incompatible",
  message: string,
  trace: AsanaRequestTrace,
): CommandError {
  return new CommandError(code, message, {
    asanaRequestIds: [...trace.requestIds],
  });
}

function requireScope(task: Task, snapshot: DiscoveryResult, trace: AsanaRequestTrace): void {
  if (task.projects === undefined) {
    throw domainError("schema_drift", "Asana task response omitted project membership", trace);
  }
  if (!task.projects.some((project) => project.gid === snapshot.teamspace.gid)) {
    throw domainError("out_of_scope", "Ticket is outside the selected Teamspace", trace);
  }
}

function requireTicketIdentity(
  task: Task,
  snapshot: DiscoveryResult,
  allowMissingCustomType: boolean,
  trace: AsanaRequestTrace,
): void {
  if (task.custom_type === undefined || task.resource_subtype === undefined) {
    throw domainError("schema_drift", "Asana task response omitted ticket identity fields", trace);
  }
  if (allowMissingCustomType) {
    if (task.custom_type === null || task.custom_type.gid === snapshot.ticket_custom_type.gid) {
      return;
    }
  }
  if (
    task.resource_subtype !== "custom" ||
    task.custom_type === null ||
    task.custom_type.gid !== snapshot.ticket_custom_type.gid
  ) {
    throw domainError(
      "schema_incompatible",
      "Task is not a Command ticket for the selected Teamspace",
      trace,
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

type UpdateCustomFieldValue = string | string[] | { date: string } | null;

type UpdateTaskData = {
  name?: string;
  notes?: string;
  completed?: boolean;
  assignee?: string | null;
  due_on?: string | null;
  custom_fields?: Record<string, UpdateCustomFieldValue>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function ticketTypeField(snapshot: DiscoveryResult): FieldDefinition {
  if (snapshot.ticket_type_field === null) {
    throw new CommandError("invalid_input", "Ticket type is unavailable in this Teamspace", {
      details: { field: "type" },
    });
  }
  return snapshot.ticket_type_field;
}

function typeOption(snapshot: DiscoveryResult, name: string) {
  return resolveEnumOptionName(ticketTypeField(snapshot), name);
}

function validateDeferredCreateOptions(
  fields: CreateTicketFields,
  snapshot: DiscoveryResult,
): void {
  if (fields.type !== undefined) {
    typeOption(snapshot, fields.type);
  }
  for (const label of fields.labels ?? []) {
    resolveEnumOptionName(snapshot.labels_field, label);
  }
}

function currentLabelGids(
  task: Task,
  snapshot: DiscoveryResult,
  trace: AsanaRequestTrace,
): string[] {
  if (task.custom_fields === undefined) {
    throw domainError("schema_drift", "Asana task response omitted custom fields", trace);
  }
  const field = customField(task, snapshot.labels_field.gid);
  if (field === undefined) {
    throw domainError("schema_drift", "Asana task response omitted the Labels field", trace);
  }
  return (field.multi_enum_values ?? []).map((option) => option.gid);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function buildLabelValue(
  task: Task,
  labels: NonNullable<UpdateTicketFields["labels"]>,
  snapshot: DiscoveryResult,
  trace: AsanaRequestTrace,
): string[] | undefined {
  const current = currentLabelGids(task, snapshot, trace);
  let next: string[];
  if (labels.set !== undefined) {
    next = [
      ...new Set(labels.set.map((name) => resolveEnumOptionName(snapshot.labels_field, name).gid)),
    ];
  } else {
    const selected = new Set(current);
    for (const name of labels.add ?? []) {
      selected.add(resolveEnumOptionName(snapshot.labels_field, name).gid);
    }
    for (const name of labels.remove ?? []) {
      selected.delete(resolveEnumOptionName(snapshot.labels_field, name).gid);
    }
    next = [...selected];
  }
  return sameSet(current, next) ? undefined : next;
}

function buildUpdateBody(
  task: Task,
  fields: UpdateTicketFields,
  snapshot: DiscoveryResult,
  trace: AsanaRequestTrace,
): UpdateTaskData {
  const data: UpdateTaskData = {};
  if (fields.name !== undefined) {
    data.name = fields.name;
  }
  if (fields.description !== undefined) {
    data.notes = fields.description;
  }
  if (fields.completed !== undefined) {
    data.completed = fields.completed;
  }
  if (fields.assignee !== undefined) {
    data.assignee = fields.assignee;
  }
  if (fields.due_on !== undefined) {
    data.due_on = fields.due_on;
  }

  const customFields: Record<string, UpdateCustomFieldValue> = {};
  if (fields.type !== undefined) {
    customFields[ticketTypeField(snapshot).gid] = typeOption(snapshot, fields.type).gid;
  }
  if (fields.predicted_start_on !== undefined) {
    customFields[snapshot.predicted_start_date_field.gid] =
      fields.predicted_start_on === null ? null : { date: fields.predicted_start_on };
  }
  if (fields.predicted_completion_on !== undefined) {
    customFields[snapshot.predicted_completion_date_field.gid] =
      fields.predicted_completion_on === null ? null : { date: fields.predicted_completion_on };
  }
  if (fields.labels !== undefined) {
    const labels = buildLabelValue(task, fields.labels, snapshot, trace);
    if (labels !== undefined) {
      customFields[snapshot.labels_field.gid] = labels;
    }
  }
  if (Object.keys(customFields).length > 0) {
    data.custom_fields = customFields;
  }
  return data;
}

function requestedCreateUpdates(fields: CreateTicketFields): UpdateTicketFields {
  const updates: UpdateTicketFields = { name: fields.name };
  if (fields.type !== undefined) {
    updates.type = fields.type;
  }
  if (fields.labels !== undefined) {
    updates.labels = { set: fields.labels };
  }
  if (fields.predicted_start_on !== undefined) {
    updates.predicted_start_on = fields.predicted_start_on;
  }
  if (fields.predicted_completion_on !== undefined) {
    updates.predicted_completion_on = fields.predicted_completion_on;
  }
  return updates;
}

function requestedCreateVerification(
  fields: CreateTicketFields,
  deferred: UpdateTicketFields,
): UpdateTicketFields {
  const requested: UpdateTicketFields = { ...deferred };
  if (fields.description !== undefined) {
    requested.description = fields.description;
  }
  if (fields.assignee !== undefined) {
    requested.assignee = fields.assignee;
  }
  if (fields.due_on !== undefined) {
    requested.due_on = fields.due_on;
  }
  return requested;
}

function pendingInitialization(
  snapshot: DiscoveryResult,
  taskGid: string,
  fields: UpdateTicketFields,
): PendingInitialization {
  return PendingInitializationSchema.parse({
    teamspace_id: snapshot.teamspace.gid,
    task_gid: taskGid,
    pending_updates: { update_ticket: fields },
    retry_with: "update_ticket",
  });
}

function normalizedSet(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizeName));
}

function labelMismatches(
  requested: NonNullable<UpdateTicketFields["labels"]>,
  actual: readonly string[],
  snapshot: DiscoveryResult,
): boolean {
  const actualNames = normalizedSet(actual);
  if (requested.set !== undefined) {
    const expected = normalizedSet(
      requested.set.map((name) => resolveEnumOptionName(snapshot.labels_field, name).name),
    );
    return (
      actualNames.size !== expected.size || [...expected].some((name) => !actualNames.has(name))
    );
  }

  const removed = normalizedSet(
    (requested.remove ?? []).map((name) => resolveEnumOptionName(snapshot.labels_field, name).name),
  );
  const added = normalizedSet(
    (requested.add ?? []).map((name) => resolveEnumOptionName(snapshot.labels_field, name).name),
  );
  for (const name of added) {
    if (!removed.has(name) && !actualNames.has(name)) {
      return true;
    }
  }
  return [...removed].some((name) => actualNames.has(name));
}

function mismatchedFields(
  requested: UpdateTicketFields,
  actual: TicketView,
  snapshot: DiscoveryResult,
): string[] {
  const mismatches: string[] = [];
  if (requested.name !== undefined && actual.name !== requested.name) {
    mismatches.push("name");
  }
  if (requested.description !== undefined && actual.description !== requested.description) {
    mismatches.push("description");
  }
  if (requested.completed !== undefined && actual.completed !== requested.completed) {
    mismatches.push("completed");
  }
  if (requested.type !== undefined) {
    const canonical = typeOption(snapshot, requested.type).name;
    if (actual.type === null || normalizeName(actual.type) !== normalizeName(canonical)) {
      mismatches.push("type");
    }
  }
  if (
    requested.labels !== undefined &&
    labelMismatches(requested.labels, actual.labels, snapshot)
  ) {
    mismatches.push("labels");
  }
  if (requested.assignee !== undefined) {
    const matches =
      requested.assignee === null
        ? actual.assignee === null
        : actual.assignee !== null &&
          (actual.assignee.gid === requested.assignee ||
            (actual.assignee.email !== undefined &&
              normalizeName(actual.assignee.email) === normalizeName(requested.assignee)));
    if (!matches) {
      mismatches.push("assignee");
    }
  }
  if (requested.due_on !== undefined && actual.due_on !== requested.due_on) {
    mismatches.push("due_on");
  }
  if (
    requested.predicted_start_on !== undefined &&
    actual.predicted_start_on !== requested.predicted_start_on
  ) {
    mismatches.push("predicted_start_on");
  }
  if (
    requested.predicted_completion_on !== undefined &&
    actual.predicted_completion_on !== requested.predicted_completion_on
  ) {
    mismatches.push("predicted_completion_on");
  }
  return mismatches;
}

function verificationError(
  taskGid: string,
  mismatches: string[],
  trace: AsanaRequestTrace,
): CommandError {
  return new CommandError("asana_api_error", "Asana did not confirm every requested ticket field", {
    details: {
      ticket_gid: taskGid,
      mismatched_fields: mismatches,
    },
    asanaRequestIds: [...trace.requestIds],
  });
}

function projectForMutation(
  task: Task,
  snapshot: DiscoveryResult,
  trace: AsanaRequestTrace,
): TicketView {
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

function isTimeout(error: unknown): boolean {
  return (
    error instanceof CommandError &&
    (error.code === "request_timeout" || error.code === "tool_timeout")
  );
}

function isInitializedTicket(task: Task, snapshot: DiscoveryResult): boolean {
  return (
    task.resource_subtype === "custom" && task.custom_type?.gid === snapshot.ticket_custom_type.gid
  );
}

export function createTicketService(
  executor: AsanaRequestExecutorPort,
  options: TicketServiceOptions = {},
): TicketService {
  const createTimeoutMs = options.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const clock = options.clock ?? Date.now;
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
          resources.tasks.getTaskForCustomIDWithHttpInfo(snapshot.workspace.gid, reference.shortId),
        trace,
      );
      gid = lookup.gid;
    }

    const task = await readByGid(gid, deadlineMs, trace);
    requireScope(task, snapshot, trace);
    requireTicketIdentity(task, snapshot, options.allowMissingCustomType ?? false, trace);
    return task;
  }

  async function readTicket(
    identifier: string,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<ReadTicketOutput> {
    const trace = executor.createTrace();
    const ticket = await resolve(identifier, snapshot, deadlineMs, { trace });
    try {
      return ReadTicketOutputSchema.parse({
        ...discoveryToProvenance(snapshot),
        ticket: projectTicketView(ticket, snapshot),
      });
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

  async function updateInitialized(
    task: Task,
    fieldsToWrite: UpdateTicketFields,
    fieldsToVerify: UpdateTicketFields,
    snapshot: DiscoveryResult,
    deadlineMs: number,
    trace: AsanaRequestTrace,
  ): Promise<TicketView> {
    const data = buildUpdateBody(task, fieldsToWrite, snapshot, trace);
    if (Object.keys(data).length > 0) {
      await executor.write(
        TicketLookupSchema,
        { deadlineMs },
        async (resources) =>
          resources.tasks.updateTaskWithHttpInfo({ data }, task.gid, {
            opt_fields: "gid",
          }),
        trace,
      );
    }

    const reread = await readByGid(task.gid, deadlineMs, trace);
    requireScope(reread, snapshot, trace);
    requireTicketIdentity(reread, snapshot, false, trace);
    const view = projectForMutation(reread, snapshot, trace);
    const mismatches = mismatchedFields(fieldsToVerify, view, snapshot);
    if (mismatches.length > 0) {
      throw verificationError(task.gid, mismatches, trace);
    }
    return view;
  }

  async function pollForInitialization(
    taskGid: string,
    snapshot: DiscoveryResult,
    deadlineMs: number,
    trace: AsanaRequestTrace,
  ): Promise<Task | null> {
    const pollingDeadlineMs = Math.min(deadlineMs, clock() + createTimeoutMs);
    while (clock() < pollingDeadlineMs) {
      let task: Task;
      try {
        task = await executor.read(
          TaskSchema,
          { deadlineMs: pollingDeadlineMs },
          async (resources) =>
            resources.tasks.getTaskWithHttpInfo(taskGid, {
              opt_fields: TASK_INITIALIZATION_FIELDS,
            }),
          trace,
        );
      } catch (error) {
        if (isTimeout(error)) {
          return null;
        }
        throw error;
      }
      requireScope(task, snapshot, trace);
      if (task.custom_type === undefined || task.resource_subtype === undefined) {
        throw domainError(
          "schema_drift",
          "Asana task response omitted ticket identity fields",
          trace,
        );
      }
      if (task.custom_type !== null && task.custom_type.gid !== snapshot.ticket_custom_type.gid) {
        throw new CommandError(
          "schema_incompatible",
          "Created task initialized as a different custom type",
          {
            details: {
              task_gid: task.gid,
              observed_custom_type_gid: task.custom_type.gid,
            },
            asanaRequestIds: [...trace.requestIds],
          },
        );
      }
      if (isInitializedTicket(task, snapshot)) {
        return task;
      }

      const remainingMs = pollingDeadlineMs - clock();
      if (remainingMs <= 0) {
        return null;
      }
      await sleep(Math.min(pollIntervalMs, remainingMs));
    }
    return null;
  }

  async function createTicket(
    fields: CreateTicketFields,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<CreateTicketOutput> {
    validateDeferredCreateOptions(fields, snapshot);
    const trace = executor.createTrace();
    const createData = {
      projects: [snapshot.teamspace.gid],
      name: fields.name,
      ...(fields.description === undefined ? {} : { notes: fields.description }),
      ...(fields.assignee === undefined ? {} : { assignee: fields.assignee }),
      ...(fields.due_on === undefined ? {} : { due_on: fields.due_on }),
    };
    const created = await executor.write(
      TicketLookupSchema,
      { deadlineMs },
      async (resources) =>
        resources.tasks.createTaskWithHttpInfo(
          { data: createData },
          {
            opt_fields: "gid",
          },
        ),
      trace,
    );

    const deferred = requestedCreateUpdates(fields);
    const verification = requestedCreateVerification(fields, deferred);
    const pending = () => pendingInitialization(snapshot, created.gid, deferred);
    const initialized = await pollForInitialization(created.gid, snapshot, deadlineMs, trace);
    if (initialized === null) {
      return buildMutationResult(
        CreateTicketPendingVariant,
        pending(),
        trace.requestIds,
        discoveryToProvenance(snapshot),
        [...snapshot.warnings, CREATE_PENDING_WARNING],
      );
    }

    try {
      const ticket = await updateInitialized(
        initialized,
        deferred,
        verification,
        snapshot,
        deadlineMs,
        trace,
      );
      return buildMutationResult(
        CreateTicketSucceededVariant,
        { ticket },
        trace.requestIds,
        discoveryToProvenance(snapshot),
        snapshot.warnings,
      );
    } catch (error) {
      if (!isTimeout(error)) {
        throw error;
      }
      return buildMutationResult(
        CreateTicketPendingVariant,
        pending(),
        trace.requestIds,
        discoveryToProvenance(snapshot),
        [...snapshot.warnings, CREATE_PENDING_WARNING],
      );
    }
  }

  async function updateTicket(
    identifier: string,
    fields: UpdateTicketFields,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<UpdateTicketOutput> {
    if (Object.keys(fields).length === 0) {
      throw new CommandError("invalid_input", "At least one ticket field must be updated");
    }
    const trace = executor.createTrace();
    const task = await resolve(identifier, snapshot, deadlineMs, {
      allowMissingCustomType: true,
      trace,
    });
    if (!isInitializedTicket(task, snapshot)) {
      return buildMutationResult(
        UpdateTicketPendingVariant,
        pendingInitialization(snapshot, task.gid, fields),
        trace.requestIds,
        discoveryToProvenance(snapshot),
        [...snapshot.warnings, UPDATE_PENDING_WARNING],
      );
    }

    const ticket = await updateInitialized(task, fields, fields, snapshot, deadlineMs, trace);
    return buildMutationResult(
      UpdateTicketSucceededVariant,
      { ticket },
      trace.requestIds,
      discoveryToProvenance(snapshot),
      snapshot.warnings,
    );
  }

  return { resolve, readByGid, readTicket, createTicket, updateTicket };
}
