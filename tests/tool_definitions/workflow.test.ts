import { describe, expect, it } from "vitest";
import { z } from "zod";
import { workflowToolDefinitions } from "../../src/tool_definitions/workflow.js";
import type { CallContext, ToolDefinition } from "../../src/tool_registry.js";
import type { WorkflowService } from "../../src/tools/workflow.js";
import {
  AddDependencyOutputSchema,
  RemoveDependencyOutputSchema,
} from "../../src/tools/workflow.js";
import {
  buildDiscoverySnapshot,
  createDiscoveryState,
  createTestContainer,
  createUnexpectedWorkflowServiceFake,
  DEADLINE_MS,
  TEAMSPACE_ID,
} from "../helpers/tool_test_helpers.js";

const TICKET_GID = "1700000000000001";
const DEPENDENCY_GID = "1700000000000002";

function findTool(name: string): ToolDefinition {
  const tool = workflowToolDefinitions.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`Missing tool definition: ${name}`);
  }
  return tool;
}

function workflowService(overrides: Partial<WorkflowService> = {}): WorkflowService {
  return {
    ...createUnexpectedWorkflowServiceFake(),
    ...overrides,
  };
}

describe("workflow tool definitions", () => {
  it("declares the exact public contracts and mutation annotations", () => {
    expect(
      workflowToolDefinitions.map(({ name, title, description }) => ({
        name,
        title,
        description,
      })),
    ).toEqual([
      {
        name: "add_dependency",
        title: "Add ticket dependency",
        description:
          "Make ticket depend on dependency (dependency blocks ticket), then return ticket's current dependency list.",
      },
      {
        name: "remove_dependency",
        title: "Remove ticket dependency",
        description:
          "Stop ticket from depending on dependency, then return ticket's current dependency list.",
      },
    ]);

    for (const toolName of ["add_dependency", "remove_dependency"]) {
      const tool = findTool(toolName);
      expect(tool.readOnly).toBe(false);
      expect(tool.annotations).toEqual({
        title: tool.title,
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it("strictly describes the dependency direction for both ticket identifiers", () => {
    const input = findTool("add_dependency").inputSchema;
    if (!(input instanceof z.ZodObject)) {
      throw new Error("Expected add_dependency to declare an object input");
    }

    expect(input.shape.ticket.description).toContain("depends on");
    expect(input.shape.ticket.description).toContain("blocked by");
    expect(input.shape.dependency.description).toContain("blocks");
    expect(input.shape.dependency.description).toContain("ticket argument");
    expect(
      input.safeParse({
        teamspace_id: TEAMSPACE_ID,
        ticket: "ENG-1",
        dependency: "ENG-2",
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      toolName: "add_dependency",
      methodName: "addDependency",
      outcome: "dependency_added",
      outputSchema: AddDependencyOutputSchema,
    },
    {
      toolName: "remove_dependency",
      methodName: "removeDependency",
      outcome: "dependency_removed",
      outputSchema: RemoveDependencyOutputSchema,
    },
  ] as const)(
    "executes $toolName with one schema snapshot and validates its output",
    async ({ toolName, methodName, outcome, outputSchema }) => {
      const state = createDiscoveryState();
      const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
      state.snapshot = snapshot;
      const observedCalls: unknown[][] = [];
      const mutation = {
        workspace: snapshot.workspace,
        teamspace: snapshot.teamspace,
        warnings: [],
        asana_request_ids: ["dependency-request"],
        status: "succeeded" as const,
        outcome,
        data: {
          ticket_gid: TICKET_GID,
          dependencies: [{ gid: DEPENDENCY_GID, name: "Blocking ticket" }],
        },
      };
      const method: WorkflowService[typeof methodName] = async (...args) => {
        observedCalls.push(args);
        return mutation;
      };
      const workflow = workflowService({ [methodName]: method });
      const context: CallContext = {
        deadlineMs: DEADLINE_MS,
        services: createTestContainer(state, { workflow }),
      };

      const result = await findTool(toolName).execute(
        {
          teamspace_id: TEAMSPACE_ID,
          ticket: " ENG-1 ",
          dependency: " ENG-2 ",
        },
        context,
      );

      expect(observedCalls).toEqual([["ENG-1", "ENG-2", snapshot, DEADLINE_MS]]);
      expect(state.discoverCalls).toBe(1);
      expect(outputSchema.parse(result)).toEqual(result);
      expect(findTool(toolName).protocolOutputSchema.parse(result)).toEqual(result);
    },
  );
});
