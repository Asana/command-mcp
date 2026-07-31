import { z } from "zod";
import { ProvenanceSchema } from "./teamspace_identity.js";

export const MutationMetadataSchema = ProvenanceSchema.extend({
  warnings: z.array(z.string()),
  asana_request_ids: z
    .array(z.string())
    .describe(
      "Asana request identifiers collected during the mutation for support correlation. These are identifiers only and are never credentials.",
    ),
});

export type MutationMetadata = z.infer<typeof MutationMetadataSchema>;

export type MutationVariant<
  TStatus extends string = string,
  TOutcome extends string = string,
  TDataSchema extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  readonly status: TStatus;
  readonly outcome: TOutcome;
  readonly data: TDataSchema;
};

export function mutationVariant<
  const TStatus extends string,
  const TOutcome extends string,
  TDataSchema extends z.ZodTypeAny,
>(
  status: TStatus,
  outcome: TOutcome,
  data: TDataSchema,
): MutationVariant<TStatus, TOutcome, TDataSchema> {
  return { status, outcome, data };
}

function enumerationOrLiteral<T extends string>(values: readonly T[]): z.ZodType<T> {
  if (values.length === 0) {
    throw new Error("enumerationOrLiteral requires at least one value");
  }
  if (values.length === 1) {
    const [value] = values;
    if (value === undefined) {
      throw new Error("enumerationOrLiteral requires at least one value");
    }
    return z.literal(value);
  }
  return z.enum(values as [T, T, ...T[]]);
}

function zodUnionFromSchemas(schemas: readonly z.ZodTypeAny[]): z.ZodTypeAny {
  if (schemas.length === 0) {
    throw new Error("zodUnionFromSchemas requires at least one schema");
  }
  if (schemas.length === 1) {
    const [onlySchema] = schemas;
    if (onlySchema === undefined) {
      throw new Error("zodUnionFromSchemas requires at least one schema");
    }
    return onlySchema;
  }

  const [first, second, ...rest] = schemas;
  if (first === undefined || second === undefined) {
    throw new Error("zodUnionFromSchemas requires at least one schema");
  }
  return z.union([first, second, ...rest]);
}

export function mutationVariantsToSchemas(
  variants: readonly MutationVariant<string, string, z.ZodTypeAny>[],
): {
  runtimeSchema: z.ZodTypeAny;
  protocolSchema: z.ZodTypeAny;
} {
  if (variants.length === 0) {
    throw new Error("mutationVariantsToSchemas requires at least one variant");
  }

  const runtimeVariants = variants.map((variant) =>
    MutationMetadataSchema.extend({
      status: z.literal(variant.status),
      outcome: z.literal(variant.outcome),
      data: variant.data,
    }),
  );

  const runtimeSchema: z.ZodTypeAny =
    runtimeVariants.length === 1
      ? (() => {
          const [onlyVariant] = runtimeVariants;
          if (onlyVariant === undefined) {
            throw new Error("mutationVariantsToSchemas requires at least one variant");
          }
          return onlyVariant;
        })()
      : zodUnionFromSchemas(runtimeVariants);

  const statuses = [...new Set(variants.map((variant) => variant.status))];
  const outcomes = [...new Set(variants.map((variant) => variant.outcome))];
  const dataSchemas = variants.map((variant) => variant.data);

  const protocolSchema = MutationMetadataSchema.extend({
    status: enumerationOrLiteral(statuses),
    outcome: enumerationOrLiteral(outcomes),
    data: zodUnionFromSchemas(dataSchemas),
  });

  return { runtimeSchema, protocolSchema };
}

export function buildMutationResult<
  const TStatus extends string,
  const TOutcome extends string,
  TDataSchema extends z.ZodTypeAny,
>(
  variant: MutationVariant<TStatus, TOutcome, TDataSchema>,
  data: z.infer<TDataSchema>,
  requestIds: readonly string[],
  provenance: z.infer<typeof ProvenanceSchema>,
  warnings: readonly string[] = [],
): z.infer<typeof MutationMetadataSchema> & {
  status: TStatus;
  outcome: TOutcome;
  data: z.infer<TDataSchema>;
} {
  return {
    workspace: provenance.workspace,
    teamspace: provenance.teamspace,
    warnings: [...warnings],
    asana_request_ids: [...requestIds],
    status: variant.status,
    outcome: variant.outcome,
    data,
  };
}
