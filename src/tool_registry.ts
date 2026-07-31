import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { type ZodError, z } from "zod";
import { CommandError } from "./errors.js";
import type { DiscoveryResult } from "./schema_discovery.js";
import type { CommandServices } from "./services.js";
import { resolveTeamspaceIdentifier, TeamspaceIdentifierSchema } from "./teamspace_identity.js";

export const EMPTY_INPUT_SCHEMA = z.object({}).strict();

export type CallContext = {
  readonly deadlineMs: number;
  readonly services: CommandServices;
};

export type TeamspaceCallContext = CallContext & {
  readonly teamspaceId: string;
  readonly schema: DiscoveryResult;
};

export type ToolDefinition = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly protocolInputSchema: z.ZodTypeAny;
  readonly outputSchema: z.ZodTypeAny;
  readonly protocolOutputSchema: z.ZodTypeAny;
  readonly readOnly: boolean;
  readonly annotations: ToolAnnotations;
  readonly execute: (input: unknown, context: CallContext) => Promise<Record<string, unknown>>;
};

type MutationHints = {
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
};

type BaseToolConfig<TInputSchema extends z.ZodTypeAny, TOutputSchema extends z.ZodTypeAny> = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: TInputSchema;
  readonly output: TOutputSchema;
  readonly protocolInput?: z.ZodTypeAny;
  readonly protocolOutput?: z.ZodTypeAny;
  readonly readOnly: boolean;
} & MutationHints;

function invalidInputFromZodError(error: ZodError): never {
  throw new CommandError("invalid_input", "Tool input validation failed", {
    details: {
      issues: error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message,
      })),
    },
    cause: error,
  });
}

function parseToolInput<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
): z.infer<TSchema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    invalidInputFromZodError(parsed.error);
  }
  return parsed.data;
}

function assertStructuredToolOutput(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommandError("schema_drift", "Tool output must be a non-null object");
  }
  return value as Record<string, unknown>;
}

function validateToolOutput<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
): Record<string, unknown> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CommandError("schema_drift", "Tool output validation failed", {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        })),
      },
      cause: parsed.error,
    });
  }
  return assertStructuredToolOutput(parsed.data);
}

function buildToolAnnotations(
  title: string,
  readOnly: boolean,
  hints: MutationHints,
): ToolAnnotations {
  const annotations: ToolAnnotations = {
    title,
    readOnlyHint: readOnly,
    destructiveHint: hints.destructive ?? false,
    idempotentHint: hints.idempotent ?? readOnly,
    openWorldHint: true,
  };
  return annotations;
}

type UnscopedToolConfig<
  TInputSchema extends z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny,
> = BaseToolConfig<TInputSchema, TOutputSchema> & {
  readonly handler: (
    input: z.infer<TInputSchema>,
    context: CallContext,
  ) => Promise<unknown> | unknown;
};

export function defineUnscopedTool<
  TInputSchema extends z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny,
>(config: UnscopedToolConfig<TInputSchema, TOutputSchema>): ToolDefinition {
  const protocolInputSchema = config.protocolInput ?? config.input;
  const protocolOutputSchema = config.protocolOutput ?? config.output;

  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.input,
    protocolInputSchema,
    outputSchema: config.output,
    protocolOutputSchema,
    readOnly: config.readOnly,
    annotations: buildToolAnnotations(config.title, config.readOnly, config),
    execute: async (input, context) => {
      const parsedInput = parseToolInput(config.input, input);
      const handlerResult = await config.handler(parsedInput, context);
      return validateToolOutput(config.output, handlerResult);
    },
  };
}

type HandlerInputWithoutTeamspaceId<TInputSchema extends z.ZodTypeAny> = Omit<
  z.infer<TInputSchema>,
  "teamspace_id"
>;

function stripTeamspaceId<TInputSchema extends z.ZodTypeAny>(
  input: z.infer<TInputSchema>,
): HandlerInputWithoutTeamspaceId<TInputSchema> {
  const { teamspace_id: _teamspaceId, ...handlerInput } = input as z.infer<TInputSchema> & {
    teamspace_id: string;
  };
  return handlerInput as HandlerInputWithoutTeamspaceId<TInputSchema>;
}

type TeamspaceScopedToolConfig<
  TInputSchema extends z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny,
> = BaseToolConfig<TInputSchema, TOutputSchema> & {
  readonly handler: (
    input: HandlerInputWithoutTeamspaceId<TInputSchema>,
    context: TeamspaceCallContext,
  ) => Promise<unknown> | unknown;
};

export function defineTeamspaceScopedTool<
  TInputSchema extends z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny,
>(config: TeamspaceScopedToolConfig<TInputSchema, TOutputSchema>): ToolDefinition {
  const protocolInputSchema = config.protocolInput ?? config.input;
  const protocolOutputSchema = config.protocolOutput ?? config.output;

  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.input,
    protocolInputSchema,
    outputSchema: config.output,
    protocolOutputSchema,
    readOnly: config.readOnly,
    annotations: buildToolAnnotations(config.title, config.readOnly, config),
    execute: async (input, context) => {
      const parsedInput = parseToolInput(config.input, input);
      const scopedInput = parsedInput as { teamspace_id?: unknown };
      const teamspaceId = resolveTeamspaceIdentifier(
        TeamspaceIdentifierSchema.parse(scopedInput.teamspace_id),
      );
      const schema = await context.services.schemaDiscovery.discover(
        teamspaceId,
        context.deadlineMs,
      );
      const scopedContext: TeamspaceCallContext = {
        ...context,
        teamspaceId,
        schema,
      };
      const handlerInput = stripTeamspaceId(parsedInput);
      const handlerResult = await config.handler(handlerInput, scopedContext);
      return validateToolOutput(config.output, handlerResult);
    },
  };
}
