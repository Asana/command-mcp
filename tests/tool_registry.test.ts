import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CommandError } from "../src/errors.js";
import { withTeamspaceId } from "../src/teamspace_identity.js";
import {
  type CallContext,
  defineTeamspaceScopedTool,
  defineUnscopedTool,
  EMPTY_INPUT_SCHEMA,
} from "../src/tool_registry.js";
import {
  buildDiscoverySnapshot,
  createDiscoveryState,
  createTestContainer,
  DEADLINE_MS,
  type FakeSchemaDiscoveryState,
  TEAMSPACE_ID,
  TEAMSPACE_URL,
  UnexpectedExecutorCallError,
} from "./helpers/tool_test_helpers.js";

function createCallContext(state: FakeSchemaDiscoveryState): CallContext {
  return {
    deadlineMs: DEADLINE_MS,
    services: createTestContainer(state),
  };
}

describe("createTestContainer", () => {
  it("fails loudly when the executor is used unexpectedly", () => {
    const services = createTestContainer(createDiscoveryState());
    expect(() => services.executor.createTrace()).toThrow(UnexpectedExecutorCallError);
  });
});

describe("defineUnscopedTool", () => {
  const inputSchema = z.object({
    value: z.string().min(1),
  });
  const outputSchema = z.object({
    echoed: z.string(),
  });

  it("fails invalid input with invalid_input and issue details", async () => {
    const tool = defineUnscopedTool({
      name: "echo",
      title: "Echo",
      description: "Echoes a value",
      input: inputSchema,
      output: outputSchema,
      readOnly: true,
      handler: (input) => ({ echoed: input.value }),
    });

    await expect(
      tool.execute({ value: "" }, createCallContext(createDiscoveryState())),
    ).rejects.toMatchObject({
      code: "invalid_input",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["value"],
            code: "too_small",
            message: expect.any(String),
          }),
        ]),
      },
    });
  });

  it("reaches the handler for valid input", async () => {
    let handlerCalled = false;
    const tool = defineUnscopedTool({
      name: "echo",
      title: "Echo",
      description: "Echoes a value",
      input: inputSchema,
      output: outputSchema,
      readOnly: true,
      handler: (input) => {
        handlerCalled = true;
        return { echoed: input.value };
      },
    });

    const result = await tool.execute(
      { value: "hello" },
      createCallContext(createDiscoveryState()),
    );
    expect(handlerCalled).toBe(true);
    expect(result).toEqual({ echoed: "hello" });
  });

  it("throws when the handler result violates the output schema", async () => {
    const tool = defineUnscopedTool({
      name: "echo",
      title: "Echo",
      description: "Echoes a value",
      input: inputSchema,
      output: outputSchema,
      readOnly: true,
      handler: () => ({ echoed: 123 }),
    });

    await expect(
      tool.execute({ value: "hello" }, createCallContext(createDiscoveryState())),
    ).rejects.toMatchObject({
      code: "schema_drift",
    });
  });

  it("rejects a handler result that fails output schema validation", async () => {
    const tool = defineUnscopedTool({
      name: "echo",
      title: "Echo",
      description: "Echoes a value",
      input: EMPTY_INPUT_SCHEMA,
      output: z.object({ ok: z.boolean() }),
      readOnly: true,
      handler: () => null,
    });

    await expect(tool.execute({}, createCallContext(createDiscoveryState()))).rejects.toMatchObject(
      {
        code: "schema_drift",
        message: "Tool output validation failed",
      },
    );
  });

  it("rejects a transform that yields null after schema validation", async () => {
    const tool = defineUnscopedTool({
      name: "echo",
      title: "Echo",
      description: "Echoes a value",
      input: EMPTY_INPUT_SCHEMA,
      output: z.object({ ok: z.boolean() }).transform(() => null),
      readOnly: true,
      handler: () => ({ ok: true }),
    });

    await expect(tool.execute({}, createCallContext(createDiscoveryState()))).rejects.toMatchObject(
      {
        code: "schema_drift",
        message: "Tool output must be a non-null object",
      },
    );
  });

  it("rejects a transform that yields an array after schema validation", async () => {
    const tool = defineUnscopedTool({
      name: "echo",
      title: "Echo",
      description: "Echoes a value",
      input: EMPTY_INPUT_SCHEMA,
      output: z.object({ ok: z.boolean() }).transform(() => []),
      readOnly: true,
      handler: () => ({ ok: true }),
    });

    await expect(tool.execute({}, createCallContext(createDiscoveryState()))).rejects.toMatchObject(
      {
        code: "schema_drift",
        message: "Tool output must be a non-null object",
      },
    );
  });
});

describe("defineTeamspaceScopedTool", () => {
  const inputSchema = withTeamspaceId({
    query: z.string().min(1),
  });
  const outputSchema = z.object({
    teamspace_gid: z.string(),
    query: z.string(),
  });

  it("canonicalizes a Teamspace URL before discovery", async () => {
    const state = createDiscoveryState();
    const tool = defineTeamspaceScopedTool({
      name: "scoped_echo",
      title: "Scoped Echo",
      description: "Echoes within a Teamspace",
      input: inputSchema,
      output: outputSchema,
      readOnly: true,
      handler: (input, context) => ({
        teamspace_gid: context.teamspaceId,
        query: input.query,
      }),
    });

    const result = await tool.execute(
      { teamspace_id: TEAMSPACE_URL, query: "hello" },
      createCallContext(state),
    );

    expect(state.discoverCalls).toBe(1);
    expect(state.lastTeamspaceId).toBe(TEAMSPACE_ID);
    expect(result).toEqual({ teamspace_gid: TEAMSPACE_ID, query: "hello" });
  });

  it("performs schema discovery exactly once per call", async () => {
    const state = createDiscoveryState();
    const tool = defineTeamspaceScopedTool({
      name: "scoped_echo",
      title: "Scoped Echo",
      description: "Echoes within a Teamspace",
      input: inputSchema,
      output: outputSchema,
      readOnly: true,
      handler: (input, context) => ({
        teamspace_gid: context.teamspaceId,
        query: input.query,
      }),
    });

    await tool.execute({ teamspace_id: TEAMSPACE_ID, query: "hello" }, createCallContext(state));
    expect(state.discoverCalls).toBe(1);
    expect(state.lastDeadlineMs).toBe(DEADLINE_MS);
  });

  it("supplies the snapshot and canonical ID in the handler context", async () => {
    const state = createDiscoveryState();
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    state.snapshot = snapshot;

    let observedTeamspaceId: string | undefined;
    let observedSchemaFingerprint: string | undefined;
    const tool = defineTeamspaceScopedTool({
      name: "scoped_echo",
      title: "Scoped Echo",
      description: "Echoes within a Teamspace",
      input: inputSchema,
      output: z.object({
        fingerprint: z.string(),
        teamspace_gid: z.string(),
      }),
      readOnly: true,
      handler: (_input, context) => {
        observedTeamspaceId = context.teamspaceId;
        observedSchemaFingerprint = context.schema.fingerprint;
        return {
          fingerprint: context.schema.fingerprint,
          teamspace_gid: context.teamspaceId,
        };
      },
    });

    const result = await tool.execute(
      { teamspace_id: TEAMSPACE_ID, query: "hello" },
      createCallContext(state),
    );

    expect(observedTeamspaceId).toBe(TEAMSPACE_ID);
    expect(observedSchemaFingerprint).toBe(snapshot.fingerprint);
    expect(result).toEqual({
      fingerprint: snapshot.fingerprint,
      teamspace_gid: TEAMSPACE_ID,
    });
  });

  it("does not pass teamspace_id through to the handler input", async () => {
    const state = createDiscoveryState();
    let handlerInput: Record<string, unknown> | null = null;

    const tool = defineTeamspaceScopedTool({
      name: "scoped_echo",
      title: "Scoped Echo",
      description: "Echoes within a Teamspace",
      input: inputSchema,
      output: z.object({ keys: z.array(z.string()) }),
      readOnly: true,
      handler: (input) => {
        handlerInput = input;
        return { keys: Object.keys(input) };
      },
    });

    const result = await tool.execute(
      { teamspace_id: TEAMSPACE_ID, query: "hello" },
      createCallContext(state),
    );

    expect(handlerInput).toEqual({ query: "hello" });
    expect(result).toEqual({ keys: ["query"] });
  });

  it("fails invalid identifiers with invalid_input before discovery", async () => {
    const state = createDiscoveryState();
    const tool = defineTeamspaceScopedTool({
      name: "scoped_echo",
      title: "Scoped Echo",
      description: "Echoes within a Teamspace",
      input: inputSchema,
      output: outputSchema,
      readOnly: true,
      handler: (input, context) => ({
        teamspace_gid: context.teamspaceId,
        query: input.query,
      }),
    });

    await expect(
      tool.execute({ teamspace_id: "not-a-teamspace", query: "hello" }, createCallContext(state)),
    ).rejects.toBeInstanceOf(CommandError);

    try {
      await tool.execute(
        { teamspace_id: "not-a-teamspace", query: "hello" },
        createCallContext(state),
      );
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }

    expect(state.discoverCalls).toBe(0);
  });
});

describe("tool annotations", () => {
  it("marks read-only tools as read-only and idempotent with open-world access", () => {
    const tool = defineUnscopedTool({
      name: "read_only_tool",
      title: "Read Only",
      description: "Reads data",
      input: EMPTY_INPUT_SCHEMA,
      output: z.object({ ok: z.boolean() }),
      readOnly: true,
      handler: () => ({ ok: true }),
    });

    expect(tool.annotations).toEqual({
      title: "Read Only",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("lets mutations declare destructive and idempotent behavior", () => {
    const tool = defineUnscopedTool({
      name: "mutation_tool",
      title: "Mutate",
      description: "Mutates data",
      input: EMPTY_INPUT_SCHEMA,
      output: z.object({ ok: z.boolean() }),
      readOnly: false,
      destructive: true,
      idempotent: true,
      handler: () => ({ ok: true }),
    });

    expect(tool.annotations).toEqual({
      title: "Mutate",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
});
