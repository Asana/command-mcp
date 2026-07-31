import { z } from "zod";
import { GidSchema, type TaskReference, TaskReferenceSchema } from "../asana_contracts.js";
import type {
  AsanaHttpResult,
  AsanaRequestExecutorPort,
  AsanaRequestTrace,
} from "../asana_gateway.js";
import { CommandError } from "../errors.js";
import {
  buildMutationResult,
  mutationVariant,
  mutationVariantsToSchemas,
} from "../mutation_envelope.js";
import { collectPages } from "../pagination/scanner.js";
import { type DiscoveryResult, discoveryToProvenance } from "../schema_discovery.js";
import type { TicketService } from "./tickets.js";

const DEPENDENCY_FIELDS = "gid,name";
const EmptyResponseDataSchema = z.object({}).strict();

export const DependencyReferenceSchema = TaskReferenceSchema.describe(
  "A task currently blocking the ticket",
);

const DependencyMutationDataSchema = z
  .object({
    ticket_gid: GidSchema.describe("GID of the ticket that is blocked by its dependencies"),
    dependencies: z
      .array(DependencyReferenceSchema)
      .describe("The ticket's complete current dependency list"),
  })
  .strict();

export const AddDependencySucceededVariant = mutationVariant(
  "succeeded",
  "dependency_added",
  DependencyMutationDataSchema,
);
const addDependencySchemas = mutationVariantsToSchemas([AddDependencySucceededVariant]);
export const AddDependencyOutputSchema = addDependencySchemas.runtimeSchema;
export const AddDependencyProtocolOutputSchema = addDependencySchemas.protocolSchema;

export const RemoveDependencySucceededVariant = mutationVariant(
  "succeeded",
  "dependency_removed",
  DependencyMutationDataSchema,
);
const removeDependencySchemas = mutationVariantsToSchemas([RemoveDependencySucceededVariant]);
export const RemoveDependencyOutputSchema = removeDependencySchemas.runtimeSchema;
export const RemoveDependencyProtocolOutputSchema = removeDependencySchemas.protocolSchema;

export type AddDependencyOutput = z.infer<typeof AddDependencyOutputSchema>;
export type RemoveDependencyOutput = z.infer<typeof RemoveDependencyOutputSchema>;

export type WorkflowService = {
  addDependency(
    ticketIdentifier: string,
    dependencyIdentifier: string,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<AddDependencyOutput>;
  removeDependency(
    ticketIdentifier: string,
    dependencyIdentifier: string,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<RemoveDependencyOutput>;
};

type DependencyDirection = "add" | "remove";

function ensureHttpResult(result: unknown): AsanaHttpResult {
  if (typeof result === "object" && result !== null && "response" in result && "data" in result) {
    return result as AsanaHttpResult;
  }
  throw new CommandError("asana_api_error", "Unexpected dependency response shape from Asana");
}

function pageResult<T>(page: { items: T[]; nextPageOffset: string | null }): {
  items: T[];
  nextOffset?: string;
} {
  return {
    items: page.items,
    ...(page.nextPageOffset === null ? {} : { nextOffset: page.nextPageOffset }),
  };
}

function mergeTrace(error: CommandError, trace: AsanaRequestTrace): CommandError {
  const requestIds = [...error.asanaRequestIds];
  for (const requestId of trace.requestIds) {
    if (!requestIds.includes(requestId)) {
      requestIds.push(requestId);
    }
  }
  if (
    requestIds.length === error.asanaRequestIds.length &&
    requestIds.every((requestId, index) => requestId === error.asanaRequestIds[index])
  ) {
    return error;
  }
  return new CommandError(error.code, error.message, {
    ...(error.details === undefined ? {} : { details: error.details }),
    asanaRequestIds: requestIds,
    cause: error,
  });
}

function verificationError(
  direction: DependencyDirection,
  ticketGid: string,
  dependencyGid: string,
  trace: AsanaRequestTrace,
): CommandError {
  return new CommandError(
    "asana_api_error",
    `Asana did not confirm the dependency was ${direction === "add" ? "added" : "removed"}`,
    {
      details: {
        ticket_gid: ticketGid,
        dependency_gid: dependencyGid,
        expected_present: direction === "add",
      },
      asanaRequestIds: [...trace.requestIds],
    },
  );
}

export function createWorkflowService(
  executor: AsanaRequestExecutorPort,
  tickets: TicketService,
): WorkflowService {
  async function listDependencies(
    ticketGid: string,
    deadlineMs: number,
    trace: AsanaRequestTrace,
  ): Promise<TaskReference[]> {
    try {
      return await collectPages({
        loadPage: async (pageSize, offset) => {
          const page = await executor.readPage(
            TaskReferenceSchema,
            { deadlineMs },
            async (resources) =>
              ensureHttpResult(
                await resources.tasks.getDependenciesForTaskWithHttpInfo(ticketGid, {
                  limit: pageSize,
                  ...(offset === undefined ? {} : { offset }),
                  opt_fields: DEPENDENCY_FIELDS,
                }),
              ),
            trace,
          );
          return pageResult(page);
        },
      });
    } catch (error) {
      if (error instanceof CommandError) {
        throw mergeTrace(error, trace);
      }
      throw error;
    }
  }

  async function changeDependency(
    direction: DependencyDirection,
    ticketIdentifier: string,
    dependencyIdentifier: string,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<AddDependencyOutput | RemoveDependencyOutput> {
    const trace = executor.createTrace();
    try {
      const ticket = await tickets.resolve(ticketIdentifier, snapshot, deadlineMs, { trace });
      const dependency = await tickets.resolve(dependencyIdentifier, snapshot, deadlineMs, {
        trace,
      });

      const current = await listDependencies(ticket.gid, deadlineMs, trace);
      const currentlyPresent = current.some((entry) => entry.gid === dependency.gid);
      const desiredPresent = direction === "add";
      const variant =
        direction === "add" ? AddDependencySucceededVariant : RemoveDependencySucceededVariant;

      if (currentlyPresent === desiredPresent) {
        return buildMutationResult(
          variant,
          { ticket_gid: ticket.gid, dependencies: current },
          trace.requestIds,
          discoveryToProvenance(snapshot),
          snapshot.warnings,
        );
      }

      const body = { data: { dependencies: [dependency.gid] } };
      await executor.write(
        EmptyResponseDataSchema,
        { deadlineMs },
        async (resources) =>
          direction === "add"
            ? resources.tasks.addDependenciesForTaskWithHttpInfo(body, ticket.gid)
            : resources.tasks.removeDependenciesForTaskWithHttpInfo(body, ticket.gid),
        trace,
      );

      const verified = await listDependencies(ticket.gid, deadlineMs, trace);
      const verifiedPresent = verified.some((entry) => entry.gid === dependency.gid);
      if (verifiedPresent !== desiredPresent) {
        throw verificationError(direction, ticket.gid, dependency.gid, trace);
      }

      return buildMutationResult(
        variant,
        { ticket_gid: ticket.gid, dependencies: verified },
        trace.requestIds,
        discoveryToProvenance(snapshot),
        snapshot.warnings,
      );
    } catch (error) {
      if (error instanceof CommandError) {
        throw mergeTrace(error, trace);
      }
      throw error;
    }
  }

  return {
    addDependency: (ticketIdentifier, dependencyIdentifier, snapshot, deadlineMs) =>
      changeDependency("add", ticketIdentifier, dependencyIdentifier, snapshot, deadlineMs),
    removeDependency: (ticketIdentifier, dependencyIdentifier, snapshot, deadlineMs) =>
      changeDependency("remove", ticketIdentifier, dependencyIdentifier, snapshot, deadlineMs),
  };
}
