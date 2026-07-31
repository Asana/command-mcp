import { z } from "zod";
import { TeamspaceIdentifierSchema } from "../teamspace_identity.js";
import { withTicketId } from "../ticket_inputs.js";
import { defineTeamspaceScopedTool } from "../tool_registry.js";
import {
  AddCommentOutputSchema,
  AddCommentProtocolOutputSchema,
  GetCommentsOutputSchema,
} from "../tools/comments.js";

const GetCommentsInputSchema = withTicketId({
  teamspace_id: TeamspaceIdentifierSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Maximum number of comments to return, from 1 to 100"),
  cursor: z
    .string()
    .describe("Opaque cursor from a prior call for the same ticket and limit")
    .optional(),
}).strict();

const getComments = defineTeamspaceScopedTool({
  name: "get_comments",
  title: "Get ticket comments",
  description: "List comments, excluding system stories, with comment-relative pagination.",
  input: GetCommentsInputSchema,
  output: GetCommentsOutputSchema,
  readOnly: true,
  handler: (input, context) =>
    context.services.comments.getComments(
      {
        ticketId: input.ticket_id,
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
      context.schema,
      context.deadlineMs,
    ),
});

const AddCommentInputSchema = withTicketId({
  teamspace_id: TeamspaceIdentifierSchema,
  text: z
    .string()
    .trim()
    .min(1, "Comment text must not be empty")
    .describe("Plain-text comment; Markdown is not rendered"),
}).strict();

const addComment = defineTeamspaceScopedTool({
  name: "add_comment",
  title: "Add ticket comment",
  description: "Add a plain-text comment to an in-scope ticket.",
  input: AddCommentInputSchema,
  output: AddCommentOutputSchema,
  protocolOutput: AddCommentProtocolOutputSchema,
  readOnly: false,
  destructive: false,
  idempotent: false,
  handler: (input, context) =>
    context.services.comments.addComment(
      {
        ticketId: input.ticket_id,
        text: input.text,
      },
      context.schema,
      context.deadlineMs,
    ),
});

export const commentReadToolDefinitions = [getComments] as const;
export const commentWriteToolDefinitions = [addComment] as const;
