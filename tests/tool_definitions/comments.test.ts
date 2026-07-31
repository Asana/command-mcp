import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  commentReadToolDefinitions,
  commentWriteToolDefinitions,
} from "../../src/tool_definitions/comments.js";
import type { CallContext, ToolDefinition } from "../../src/tool_registry.js";
import type { CommentService } from "../../src/tools/comments.js";
import {
  AddCommentOutputSchema,
  GetCommentsOutputSchema,
} from "../../src/tools/comments.js";
import {
  buildDiscoverySnapshot,
  createDiscoveryState,
  createTestContainer,
  DEADLINE_MS,
  TEAMSPACE_ID,
} from "../helpers/tool_test_helpers.js";

const TICKET_GID = "1700000000000001";
const STORY_GID = "1800000000000001";

function unexpectedCall(name: string): never {
  throw new Error(`Unexpected call to ${name}`);
}

function commentsService(overrides: Partial<CommentService> = {}): CommentService {
  return {
    getComments: async () => unexpectedCall("CommentService.getComments"),
    addComment: async () => unexpectedCall("CommentService.addComment"),
    ...overrides,
  };
}

function onlyTool(definitions: readonly ToolDefinition[]): ToolDefinition {
  const tool = definitions[0];
  if (tool === undefined || definitions.length !== 1) {
    throw new Error("Expected exactly one comment tool definition");
  }
  return tool;
}

describe("comment tool definitions", () => {
  it("exports reads and writes as separate groups with exact public contracts", () => {
    const getComments = onlyTool(commentReadToolDefinitions);
    const addComment = onlyTool(commentWriteToolDefinitions);

    expect({
      name: getComments.name,
      title: getComments.title,
      description: getComments.description,
    }).toEqual({
      name: "get_comments",
      title: "Get ticket comments",
      description: "List comments, excluding system stories, with comment-relative pagination.",
    });
    expect(getComments.annotations).toEqual({
      title: "Get ticket comments",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });

    expect({
      name: addComment.name,
      title: addComment.title,
      description: addComment.description,
    }).toEqual({
      name: "add_comment",
      title: "Add ticket comment",
      description: "Add a plain-text comment to an in-scope ticket.",
    });
    expect(addComment.annotations).toEqual({
      title: "Add ticket comment",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("publishes strict inputs and the required pagination field descriptions", () => {
    const getComments = onlyTool(commentReadToolDefinitions);
    const addComment = onlyTool(commentWriteToolDefinitions);
    expect(
      getComments.inputSchema.safeParse({
        teamspace_id: TEAMSPACE_ID,
        ticket_id: TICKET_GID,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      addComment.inputSchema.safeParse({
        teamspace_id: TEAMSPACE_ID,
        ticket_id: TICKET_GID,
        text: "Comment",
        extra: true,
      }).success,
    ).toBe(false);

    if (!(getComments.inputSchema instanceof z.ZodObject)) {
      throw new Error("Expected get_comments to declare an object input");
    }
    expect(getComments.inputSchema.shape.cursor.description).toContain(
      "prior call for the same ticket and limit",
    );
    if (!(getComments.outputSchema instanceof z.ZodObject)) {
      throw new Error("Expected get_comments to declare an object output");
    }
    expect(getComments.outputSchema.shape.cursor.description).toBe(
      "Opaque cursor for the next page",
    );
    expect(getComments.outputSchema.shape.has_more.description).toBe(
      "Whether more source stories may be available",
    );
    expect(getComments.outputSchema.shape.scanned_count.description).toBe(
      "Raw ticket stories scanned",
    );
    expect(getComments.outputSchema.shape.truncated.description).toBe(
      "True when the story scan safety bound was reached",
    );
  });

  it("executes get_comments with a default limit and one discovered snapshot", async () => {
    const state = createDiscoveryState();
    const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
    state.snapshot = snapshot;
    const comments = commentsService({
      getComments: async (input, discovered, deadlineMs) => {
        expect(input).toEqual({ ticketId: TICKET_GID, limit: 50 });
        expect(discovered).toBe(snapshot);
        expect(deadlineMs).toBe(DEADLINE_MS);
        return {
          workspace: snapshot.workspace,
          teamspace: snapshot.teamspace,
          comments: [],
          cursor: null,
          has_more: false,
          scanned_count: 0,
          truncated: false,
        };
      },
    });
    const context: CallContext = {
      deadlineMs: DEADLINE_MS,
      services: createTestContainer(state, { comments }),
    };

    const result = await onlyTool(commentReadToolDefinitions).execute(
      { teamspace_id: TEAMSPACE_ID, ticket_id: TICKET_GID },
      context,
    );

    expect(state.discoverCalls).toBe(1);
    expect(GetCommentsOutputSchema.parse(result)).toEqual(result);
  });

  it("executes add_comment with trimmed plain text and its single mutation variant", async () => {
    const state = createDiscoveryState();
    const snapshot = state.snapshot;
    const comments = commentsService({
      addComment: async (input, discovered, deadlineMs) => {
        expect(input).toEqual({ ticketId: TICKET_GID, text: "Plain comment" });
        expect(discovered).toBe(snapshot);
        expect(deadlineMs).toBe(DEADLINE_MS);
        return {
          workspace: snapshot.workspace,
          teamspace: snapshot.teamspace,
          warnings: [],
          asana_request_ids: ["create-request", "reread-request"],
          status: "succeeded",
          outcome: "comment_added",
          data: {
            story_gid: STORY_GID,
            comment: {
              gid: STORY_GID,
              text: "Plain comment",
              created_at: null,
              author: null,
            },
          },
        };
      },
    });
    const context: CallContext = {
      deadlineMs: DEADLINE_MS,
      services: createTestContainer(state, { comments }),
    };

    const result = await onlyTool(commentWriteToolDefinitions).execute(
      {
        teamspace_id: TEAMSPACE_ID,
        ticket_id: TICKET_GID,
        text: "  Plain comment  ",
      },
      context,
    );

    expect(state.discoverCalls).toBe(1);
    expect(AddCommentOutputSchema.parse(result)).toEqual(result);
    expect(onlyTool(commentWriteToolDefinitions).protocolOutputSchema.parse(result)).toEqual(
      result,
    );
  });

  it("rejects blank comment text during input validation before discovery", async () => {
    const state = createDiscoveryState();
    const context: CallContext = {
      deadlineMs: DEADLINE_MS,
      services: createTestContainer(state),
    };

    await expect(
      onlyTool(commentWriteToolDefinitions).execute(
        {
          teamspace_id: TEAMSPACE_ID,
          ticket_id: TICKET_GID,
          text: "   ",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(state.discoverCalls).toBe(0);
  });
});
