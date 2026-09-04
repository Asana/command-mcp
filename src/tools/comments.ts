import { z } from "zod";
import { COMMENT_STORY_FIELDS, GidSchema, type Story, StorySchema } from "../asana_contracts.js";
import type {
  AsanaHttpResult,
  AsanaRequestExecutorPort,
  AsanaRequestTrace,
} from "../asana_gateway.js";
import { CommandError } from "../errors.js";
import { looksLikeMarkdown, markdownInPlainTextWarning } from "../markdown_heuristic.js";
import {
  buildMutationResult,
  mutationVariant,
  mutationVariantsToSchemas,
} from "../mutation_envelope.js";
import { createCursorCodec } from "../pagination/cursor.js";
import { createScanBudget, scanPages } from "../pagination/scanner.js";
import { type DiscoveryResult, discoveryToProvenance } from "../schema_discovery.js";
import { ProvenanceSchema } from "../teamspace_identity.js";
import type { TicketService } from "./tickets.js";

const DEFAULT_MAX_SCAN_STORIES = 1000;

const CreatedStorySchema = z.object({
  gid: GidSchema,
});

const CommentAuthorViewSchema = z
  .object({
    gid: GidSchema.describe("Numeric Asana user GID"),
    name: z.string().describe("Comment author display name"),
  })
  .strict();

export const CommentViewSchema = z
  .object({
    gid: GidSchema.describe("Numeric Asana story GID"),
    text: z.string().describe("Comment text"),
    created_at: z
      .string()
      .datetime()
      .nullable()
      .describe("Comment creation timestamp or null when unavailable"),
    author: CommentAuthorViewSchema.nullable().describe("Comment author or null when unavailable"),
  })
  .strict();

export const GetCommentsOutputSchema = ProvenanceSchema.extend({
  comments: z.array(CommentViewSchema).describe("User comments on the ticket"),
  cursor: z.string().nullable().describe("Opaque cursor for the next page"),
  has_more: z.boolean().describe("Whether more source stories may be available"),
  scanned_count: z.number().int().nonnegative().describe("Raw ticket stories scanned"),
  truncated: z.boolean().describe("True when the story scan safety bound was reached"),
});

const AddCommentDataSchema = z
  .object({
    story_gid: GidSchema.describe("Numeric GID of the created comment story"),
    comment: CommentViewSchema.describe("Authoritatively verified created comment"),
  })
  .strict();

export const AddCommentSucceededVariant = mutationVariant(
  "succeeded",
  "comment_added",
  AddCommentDataSchema,
);
const addCommentSchemas = mutationVariantsToSchemas([AddCommentSucceededVariant]);
export const AddCommentOutputSchema = addCommentSchemas.runtimeSchema;
export const AddCommentProtocolOutputSchema = addCommentSchemas.protocolSchema;

export type CommentView = z.infer<typeof CommentViewSchema>;
export type GetCommentsOutput = z.infer<typeof GetCommentsOutputSchema>;
export type AddCommentOutput = z.infer<typeof AddCommentOutputSchema>;

export type GetCommentsInput = {
  readonly ticketId: string;
  readonly limit: number;
  readonly cursor?: string;
};

export type AddCommentInput = {
  readonly ticketId: string;
  readonly text?: string;
  readonly textHtml?: string;
};

export type CommentService = {
  getComments(
    input: GetCommentsInput,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<GetCommentsOutput>;
  addComment(
    input: AddCommentInput,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<AddCommentOutput>;
};

export type CommentServiceOptions = {
  readonly maxScanStories?: number;
};

type CommentCursorBinding = {
  readonly teamspaceGid: string;
  readonly taskGid: string;
  readonly limit: number;
};

const commentCursorCodec = createCursorCodec<CommentCursorBinding>({
  version: 1,
  canonicalizeBinding: (binding) => binding,
  invalidMessage: "Comment cursor is invalid for this ticket and limit",
});

function ensureHttpResult(result: unknown): AsanaHttpResult {
  if (typeof result === "object" && result !== null && "response" in result && "data" in result) {
    return result as AsanaHttpResult;
  }
  throw new CommandError(
    "asana_api_error",
    "Unexpected story collection response shape from Asana",
  );
}

function projectComment(story: Story, trace: AsanaRequestTrace): CommentView {
  const projected = {
    gid: story.gid,
    text: story.text,
    created_at: story.created_at ?? null,
    author:
      story.created_by == null
        ? null
        : {
            gid: story.created_by.gid,
            name: story.created_by.name,
          },
  };
  const parsed = CommentViewSchema.safeParse(projected);
  if (!parsed.success) {
    throw new CommandError("schema_drift", "Comment story did not match the comment contract", {
      details: {
        story_gid: story.gid,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
        })),
      },
      asanaRequestIds: [...trace.requestIds],
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function verificationError(
  storyGid: string,
  mismatch: "resource_subtype" | "text" | "html_text",
  expected: string,
  actual: string | undefined,
  trace: AsanaRequestTrace,
): CommandError {
  const mismatchName = mismatch === "resource_subtype" ? "resource subtype" : mismatch;
  return new CommandError(
    "asana_api_error",
    `Asana comment verification failed: ${mismatchName} mismatch`,
    {
      details: {
        story_gid: storyGid,
        mismatch,
        expected,
        actual: actual ?? null,
      },
      asanaRequestIds: [...trace.requestIds],
    },
  );
}

export function createCommentService(
  executor: AsanaRequestExecutorPort,
  tickets: TicketService,
  options: CommentServiceOptions = {},
): CommentService {
  const maxScanStories = options.maxScanStories ?? DEFAULT_MAX_SCAN_STORIES;

  async function getComments(
    input: GetCommentsInput,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<GetCommentsOutput> {
    const trace = executor.createTrace();
    const ticket = await tickets.resolve(input.ticketId, snapshot, deadlineMs, { trace });
    const binding: CommentCursorBinding = {
      teamspaceGid: snapshot.teamspace.gid,
      taskGid: ticket.gid,
      limit: input.limit,
    };
    const startOffset =
      input.cursor === undefined
        ? undefined
        : commentCursorCodec.decode(input.cursor, binding).offset;

    const scanned = await scanPages({
      ...(startOffset === undefined ? {} : { startOffset }),
      limit: input.limit,
      budget: createScanBudget(maxScanStories),
      loadPage: async (pageSize, offset) => {
        const page = await executor.readPage(
          StorySchema,
          { deadlineMs },
          async (resources) =>
            ensureHttpResult(
              await resources.stories.getStoriesForTaskWithHttpInfo(ticket.gid, {
                limit: pageSize,
                ...(offset === undefined ? {} : { offset }),
                opt_fields: COMMENT_STORY_FIELDS,
              }),
            ),
          trace,
        );
        return {
          items: page.items,
          ...(page.nextPageOffset === null ? {} : { nextOffset: page.nextPageOffset }),
        };
      },
      visit: (story) =>
        story.resource_subtype === "comment_added" ? projectComment(story, trace) : undefined,
    });

    return GetCommentsOutputSchema.parse({
      ...discoveryToProvenance(snapshot),
      comments: scanned.results,
      cursor:
        scanned.nextOffset === undefined
          ? null
          : commentCursorCodec.encode(scanned.nextOffset, binding),
      has_more: scanned.hasMore,
      scanned_count: scanned.examined,
      truncated: scanned.truncated,
    });
  }

  async function addComment(
    input: AddCommentInput,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<AddCommentOutput> {
    const trace = executor.createTrace();
    const ticket = await tickets.resolve(input.ticketId, snapshot, deadlineMs, { trace });
    const created = await executor.write(
      CreatedStorySchema,
      { deadlineMs },
      async (resources) =>
        resources.stories.createStoryForTaskWithHttpInfo(
          {
            data:
              input.textHtml === undefined ? { text: input.text } : { html_text: input.textHtml },
          },
          ticket.gid,
          { opt_fields: "gid" },
        ),
      trace,
    );
    const reread = await executor.read(
      StorySchema,
      { deadlineMs },
      async (resources) =>
        resources.stories.getStoryWithHttpInfo(created.gid, {
          opt_fields: COMMENT_STORY_FIELDS,
        }),
      trace,
    );

    if (reread.resource_subtype !== "comment_added") {
      throw verificationError(
        created.gid,
        "resource_subtype",
        "comment_added",
        reread.resource_subtype,
        trace,
      );
    }
    if (input.textHtml === undefined) {
      if (reread.text !== input.text) {
        throw verificationError(created.gid, "text", input.text ?? "", reread.text, trace);
      }
    } else if (reread.html_text !== input.textHtml) {
      throw verificationError(created.gid, "html_text", input.textHtml, reread.html_text, trace);
    }

    const comment = projectComment(reread, trace);
    const markdownWarnings =
      input.text !== undefined && looksLikeMarkdown(input.text)
        ? [markdownInPlainTextWarning("text", "text_html")]
        : [];
    return buildMutationResult(
      AddCommentSucceededVariant,
      { story_gid: created.gid, comment },
      trace.requestIds,
      discoveryToProvenance(snapshot),
      [...snapshot.warnings, ...markdownWarnings],
    );
  }

  return { getComments, addComment };
}
