import { z } from "zod";
import { GidSchema } from "../asana_contracts.js";
import type { AsanaRequestExecutorPort, AsanaRequestTrace } from "../asana_gateway.js";
import { CommandError } from "../errors.js";
import {
  buildMutationResult,
  mutationVariant,
  mutationVariantsToSchemas,
} from "../mutation_envelope.js";
import {
  type DiscoveryResult,
  discoveryToProvenance,
  type ReleaseReference,
  readReferencedReleaseGids,
  ReleaseReferenceSchema,
  resolveRelease,
} from "../schema_discovery.js";
import { ProvenanceSchema } from "../teamspace_identity.js";
import {
  currentReleaseMemberships,
  ReleaseMembershipSchema,
} from "./release_memberships.js";
import type { TicketService } from "./tickets.js";

export { ReleaseMembershipSchema } from "./release_memberships.js";

export const TeamspaceReleasesOutputSchema = ProvenanceSchema.extend({
  releases: z.array(ReleaseReferenceSchema),
});

const ReleaseMutationDataSchema = z.object({
  ticket_gid: GidSchema,
  memberships: z.array(ReleaseMembershipSchema),
});

export const AddTicketToReleaseSucceededVariant = mutationVariant(
  "succeeded",
  "release_added",
  ReleaseMutationDataSchema,
);
const addTicketToReleaseSchemas = mutationVariantsToSchemas([AddTicketToReleaseSucceededVariant]);
export const AddTicketToReleaseOutputSchema = addTicketToReleaseSchemas.runtimeSchema;
export const AddTicketToReleaseProtocolOutputSchema = addTicketToReleaseSchemas.protocolSchema;

export const RemoveTicketFromReleaseSucceededVariant = mutationVariant(
  "succeeded",
  "release_removed",
  ReleaseMutationDataSchema,
);
const removeTicketFromReleaseSchemas = mutationVariantsToSchemas([
  RemoveTicketFromReleaseSucceededVariant,
]);
export const RemoveTicketFromReleaseOutputSchema = removeTicketFromReleaseSchemas.runtimeSchema;
export const RemoveTicketFromReleaseProtocolOutputSchema =
  removeTicketFromReleaseSchemas.protocolSchema;

export type TeamspaceReleasesOutput = z.infer<typeof TeamspaceReleasesOutputSchema>;
export type AddTicketToReleaseOutput = z.infer<typeof AddTicketToReleaseOutputSchema>;
export type RemoveTicketFromReleaseOutput = z.infer<typeof RemoveTicketFromReleaseOutputSchema>;

export type ReleaseService = {
  listReleases(snapshot: DiscoveryResult): TeamspaceReleasesOutput;
  addTicketToRelease(
    ticketIdentifier: string,
    releaseIdentifier: string,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<AddTicketToReleaseOutput>;
  removeTicketFromRelease(
    ticketIdentifier: string,
    releaseIdentifier: string,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<RemoveTicketFromReleaseOutput>;
};

type MembershipDirection = "add" | "remove";

const EmptyMutationResponseSchema = z.object({});

function knownReleases(snapshot: DiscoveryResult): Array<{ gid: string; name: string }> {
  return snapshot.releases.map(({ gid, name }) => ({ gid, name }));
}

function resolveReleaseWithTrace(
  snapshot: DiscoveryResult,
  identifier: string,
  trace: AsanaRequestTrace,
): ReleaseReference {
  try {
    return resolveRelease(snapshot, identifier);
  } catch (error) {
    if (error instanceof CommandError && error.code === "unknown_release") {
      throw new CommandError(error.code, error.message, {
        ...(error.details === undefined ? {} : { details: error.details }),
        asanaRequestIds: [...trace.requestIds],
        cause: error,
      });
    }
    throw error;
  }
}

function verificationError(
  direction: MembershipDirection,
  ticketGid: string,
  release: ReleaseReference,
  trace: AsanaRequestTrace,
): CommandError {
  return new CommandError(
    "asana_api_error",
    `Asana did not confirm the Release membership was ${direction === "add" ? "added" : "removed"}`,
    {
      details: {
        ticket_gid: ticketGid,
        release_gid: release.gid,
        expected_membership: direction === "add",
      },
      asanaRequestIds: [...trace.requestIds],
    },
  );
}

export function createReleaseService(
  executor: AsanaRequestExecutorPort,
  tickets: TicketService,
): ReleaseService {
  function listReleases(snapshot: DiscoveryResult): TeamspaceReleasesOutput {
    return {
      ...discoveryToProvenance(snapshot),
      releases: snapshot.releases,
    };
  }

  async function changeMembership(
    direction: MembershipDirection,
    ticketIdentifier: string,
    releaseIdentifier: string,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<AddTicketToReleaseOutput | RemoveTicketFromReleaseOutput> {
    const trace = executor.createTrace();
    const ticket = await tickets.resolve(ticketIdentifier, snapshot, deadlineMs, { trace });
    const release = resolveReleaseWithTrace(snapshot, releaseIdentifier, trace);

    const referencedReleaseGids = await readReferencedReleaseGids(
      executor,
      snapshot.teamspace.gid,
      snapshot.releases_field.gid,
      { deadlineMs },
      trace,
    );
    if (!referencedReleaseGids.includes(release.gid)) {
      throw new CommandError(
        "unknown_release",
        "Release is no longer referenced by the selected Teamspace",
        {
          details: {
            identifier: releaseIdentifier,
            known_releases: knownReleases(snapshot).filter(({ gid }) =>
              referencedReleaseGids.includes(gid),
            ),
          },
          asanaRequestIds: [...trace.requestIds],
        },
      );
    }

    await executor.write(
      EmptyMutationResponseSchema,
      { deadlineMs },
      async (resources) =>
        direction === "add"
          ? resources.tasks.addProjectForTaskWithHttpInfo(
              { data: { project: release.gid } },
              ticket.gid,
            )
          : resources.tasks.removeProjectForTaskWithHttpInfo(
              { data: { project: release.gid } },
              ticket.gid,
            ),
      trace,
    );

    const reread = await tickets.readByGid(ticket.gid, deadlineMs, trace);
    if (reread.projects === undefined) {
      throw new CommandError("schema_drift", "Asana task response omitted project membership", {
        asanaRequestIds: [...trace.requestIds],
      });
    }
    const memberships = currentReleaseMemberships(reread.projects, snapshot);
    const targetIsPresent = memberships.some((membership) => membership.gid === release.gid);
    if ((direction === "add") !== targetIsPresent) {
      throw verificationError(direction, ticket.gid, release, trace);
    }

    const data = {
      ticket_gid: ticket.gid,
      memberships,
    };
    const provenance = discoveryToProvenance(snapshot);
    return direction === "add"
      ? buildMutationResult(
          AddTicketToReleaseSucceededVariant,
          data,
          trace.requestIds,
          provenance,
          snapshot.warnings,
        )
      : buildMutationResult(
          RemoveTicketFromReleaseSucceededVariant,
          data,
          trace.requestIds,
          provenance,
          snapshot.warnings,
        );
  }

  return {
    listReleases,
    addTicketToRelease: (ticketIdentifier, releaseIdentifier, snapshot, deadlineMs) =>
      changeMembership(
        "add",
        ticketIdentifier,
        releaseIdentifier,
        snapshot,
        deadlineMs,
      ) as Promise<AddTicketToReleaseOutput>,
    removeTicketFromRelease: (ticketIdentifier, releaseIdentifier, snapshot, deadlineMs) =>
      changeMembership(
        "remove",
        ticketIdentifier,
        releaseIdentifier,
        snapshot,
        deadlineMs,
      ) as Promise<RemoveTicketFromReleaseOutput>,
  };
}
