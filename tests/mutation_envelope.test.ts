import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildMutationResult,
  mutationVariant,
  mutationVariantsToSchemas,
} from "../src/mutation_envelope.js";
import type { Provenance } from "../src/teamspace_identity.js";

const PROVENANCE: Provenance = {
  workspace: { gid: "1500000000000001", name: "Command Workspace" },
  teamspace: { gid: "1600000000000001", name: "Engineering Teamspace" },
};

const SUCCESS_DATA_SCHEMA = z.object({ ticket_gid: z.string() });
const PENDING_DATA_SCHEMA = z.object({
  pending_updates: z.object({ update_ticket: z.object({}) }),
});

describe("mutationVariantsToSchemas", () => {
  const successVariant = mutationVariant("completed", "updated", SUCCESS_DATA_SCHEMA);
  const pendingVariant = mutationVariant("initialization_pending", "created", PENDING_DATA_SCHEMA);

  it("throws when the variant list is empty", () => {
    expect(() => mutationVariantsToSchemas([])).toThrow(
      "mutationVariantsToSchemas requires at least one variant",
    );
  });

  it("accepts each variant result against the runtime union", () => {
    const { runtimeSchema } = mutationVariantsToSchemas([successVariant, pendingVariant]);

    expect(
      runtimeSchema.parse(
        buildMutationResult(
          successVariant,
          { ticket_gid: "1700000000000001" },
          ["req-success"],
          PROVENANCE,
        ),
      ),
    ).toMatchObject({
      status: "completed",
      outcome: "updated",
      data: { ticket_gid: "1700000000000001" },
    });

    expect(
      runtimeSchema.parse(
        buildMutationResult(
          pendingVariant,
          { pending_updates: { update_ticket: {} } },
          ["req-pending"],
          PROVENANCE,
          ["still initializing"],
        ),
      ),
    ).toMatchObject({
      status: "initialization_pending",
      outcome: "created",
      warnings: ["still initializing"],
    });
  });

  it("rejects a result that pairs one variant status with another outcome", () => {
    const { runtimeSchema } = mutationVariantsToSchemas([successVariant, pendingVariant]);

    expect(() =>
      runtimeSchema.parse({
        ...PROVENANCE,
        warnings: [],
        asana_request_ids: ["req-mismatch"],
        status: "completed",
        outcome: "created",
        data: { ticket_gid: "1700000000000001" },
      }),
    ).toThrow();
  });

  it("accepts every variant shape through the protocol schema", () => {
    const { protocolSchema } = mutationVariantsToSchemas([successVariant, pendingVariant]);

    expect(
      protocolSchema.parse(
        buildMutationResult(
          successVariant,
          { ticket_gid: "1700000000000001" },
          ["req-success"],
          PROVENANCE,
        ),
      ),
    ).toBeTruthy();

    expect(
      protocolSchema.parse(
        buildMutationResult(
          pendingVariant,
          { pending_updates: { update_ticket: {} } },
          ["req-pending"],
          PROVENANCE,
        ),
      ),
    ).toBeTruthy();
  });

  it("uses literal status and outcome schemas when only one variant exists", () => {
    const { protocolSchema } = mutationVariantsToSchemas([successVariant]);
    const parsed = protocolSchema.parse(
      buildMutationResult(successVariant, { ticket_gid: "1700000000000001" }, [], PROVENANCE),
    );
    expect(parsed.status).toBe("completed");
    expect(parsed.outcome).toBe("updated");
  });
});

describe("buildMutationResult", () => {
  it("defaults warnings to an empty array", () => {
    const variant = mutationVariant("completed", "updated", SUCCESS_DATA_SCHEMA);
    const result = buildMutationResult(
      variant,
      { ticket_gid: "1700000000000001" },
      ["req-1"],
      PROVENANCE,
    );
    expect(result.warnings).toEqual([]);
    expect(result.asana_request_ids).toEqual(["req-1"]);
    expect(result.workspace).toEqual(PROVENANCE.workspace);
    expect(result.teamspace).toEqual(PROVENANCE.teamspace);
  });
});
