import { z } from "zod";
import { TeamspaceIdentifierSchema } from "../teamspace_identity.js";
import { RICH_TEXT_WRITER_RULES, withTicketId } from "../ticket_inputs.js";
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

const COMMENT_TEXT_HTML_DESCRIPTION = [
  "HTML-formatted comment; exactly one of text or text_html must be provided. Use this for rich formatting or @-mentions.",
  `Allowed elements: <body>, <strong>, <em>, <u>, <s>, <code>, <ol>, <ul>, <li>, <a>, <blockquote>, <pre>. ${RICH_TEXT_WRITER_RULES}`,
].join(" ");

const AddCommentInputSchema = withTicketId({
  teamspace_id: TeamspaceIdentifierSchema,
  text: z
    .string()
    .trim()
    .min(1, "Comment text must not be empty")
    .describe(
      "Plain-text comment; Markdown is not rendered; exactly one of text or text_html must be provided.",
    )
    .optional(),
  text_html: z.string().describe(COMMENT_TEXT_HTML_DESCRIPTION).optional(),
})
  .strict()
  .superRefine((value, context) => {
    if (value.text !== undefined && value.text_html !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "text and text_html may not both be set",
        path: ["text_html"],
      });
    }
    if (value.text === undefined && value.text_html === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one of text or text_html must be provided",
        path: ["text"],
      });
    }
  });

const addComment = defineTeamspaceScopedTool({
  name: "add_comment",
  title: "Add ticket comment",
  description: "Add a comment, as plain text or HTML rich text, to an in-scope ticket.",
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
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.text_html === undefined ? {} : { textHtml: input.text_html }),
      },
      context.schema,
      context.deadlineMs,
    ),
});

export const commentReadToolDefinitions = [getComments] as const;
export const commentWriteToolDefinitions = [addComment] as const;
