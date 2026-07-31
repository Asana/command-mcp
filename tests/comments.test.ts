import type {
  AttachmentsApi,
  CustomFieldSettingsApi,
  CustomTypesApi,
  ProjectsApi,
  StoriesApi,
  TasksApi,
  TypeaheadApi,
  WorkspacesApi,
} from "asana";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Story, Task } from "../src/asana_contracts.js";
import { COMMENT_STORY_FIELDS } from "../src/asana_contracts.js";
import type {
  AsanaHttpResult,
  AsanaRequestExecutorPort,
  AsanaRequestTrace,
  AsanaResourceBundle,
} from "../src/asana_gateway.js";
import { CommandError } from "../src/errors.js";
import type { DiscoveryResult } from "../src/schema_discovery.js";
import {
  CommentViewSchema,
  createCommentService,
  GetCommentsOutputSchema,
} from "../src/tools/comments.js";
import type { TicketService } from "../src/tools/tickets.js";
import { buildDiscoverySnapshot, DEADLINE_MS, TEAMSPACE_ID } from "./helpers/tool_test_helpers.js";

const TICKET_GID = "1700000000000001";
const OTHER_TICKET_GID = "1700000000000002";
const STORY_GID = "1800000000000001";

function unexpectedCall(name: string): never {
  throw new Error(`Unexpected call to ${name}`);
}

function throwingApi<T extends object>(name: string): T {
  const target = { apiClient: {} };
  return new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) {
        return Reflect.get(object, property, receiver);
      }
      if (property === "then") {
        return undefined;
      }
      return (..._args: unknown[]) => unexpectedCall(`${name}.${String(property)}`);
    },
  }) as T;
}

type StoryMethods = {
  getStories?: StoriesApi["getStoriesForTaskWithHttpInfo"];
  createStory?: StoriesApi["createStoryForTaskWithHttpInfo"];
  getStory?: StoriesApi["getStoryWithHttpInfo"];
};

function resources(methods: StoryMethods): AsanaResourceBundle {
  const stories = throwingApi<StoriesApi>("stories");
  if (methods.getStories !== undefined) {
    stories.getStoriesForTaskWithHttpInfo = methods.getStories;
  }
  if (methods.createStory !== undefined) {
    stories.createStoryForTaskWithHttpInfo = methods.createStory;
  }
  if (methods.getStory !== undefined) {
    stories.getStoryWithHttpInfo = methods.getStory;
  }
  return {
    tasks: throwingApi<TasksApi>("tasks"),
    projects: throwingApi<ProjectsApi>("projects"),
    stories,
    attachments: throwingApi<AttachmentsApi>("attachments"),
    customFieldSettings: throwingApi<CustomFieldSettingsApi>("customFieldSettings"),
    customTypes: throwingApi<CustomTypesApi>("customTypes"),
    typeahead: throwingApi<TypeaheadApi>("typeahead"),
    workspaces: throwingApi<WorkspacesApi>("workspaces"),
  };
}

function singleResult(data: unknown, requestId?: string): AsanaHttpResult {
  return {
    response: { headers: requestId === undefined ? {} : { "x-asana-request-id": requestId } },
    data: { data },
  };
}

function pageResult(
  data: unknown[],
  nextOffset?: string,
  requestId?: string,
): AsanaHttpResult {
  return {
    response: { headers: requestId === undefined ? {} : { "x-asana-request-id": requestId } },
    data: {
      data,
      next_page: nextOffset === undefined ? null : { offset: nextOffset },
    },
  };
}

type ExecutorState = {
  reads: number;
  writes: number;
  pageReads: number;
  traces: AsanaRequestTrace[];
};

function executorState(): ExecutorState {
  return { reads: 0, writes: 0, pageReads: 0, traces: [] };
}

function collectRequestId(result: AsanaHttpResult, trace: AsanaRequestTrace | undefined): void {
  const requestId = result.response.headers?.["x-asana-request-id"];
  if (trace !== undefined && typeof requestId === "string") {
    trace.requestIds.push(requestId);
  }
}

function executor(bundle: AsanaResourceBundle, state: ExecutorState): AsanaRequestExecutorPort {
  async function invoke<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    callback: (resources: AsanaResourceBundle) => Promise<AsanaHttpResult>,
    trace: AsanaRequestTrace | undefined,
  ): Promise<z.infer<TSchema>> {
    const response = await callback(bundle);
    collectRequestId(response, trace);
    return z.object({ data: schema }).parse(response.data).data;
  }

  return {
    createTrace: () => {
      const trace = { requestIds: [] };
      state.traces.push(trace);
      return trace;
    },
    read: async (schema, options, callback, trace) => {
      expect(options.deadlineMs).toBe(DEADLINE_MS);
      state.reads += 1;
      return invoke(schema, callback, trace);
    },
    write: async (schema, options, callback, trace) => {
      expect(options.deadlineMs).toBe(DEADLINE_MS);
      state.writes += 1;
      return invoke(schema, callback, trace);
    },
    readPage: async (schema, options, callback, trace) => {
      expect(options.deadlineMs).toBe(DEADLINE_MS);
      state.pageReads += 1;
      const response = await callback(bundle);
      collectRequestId(response, trace);
      const parsed = z
        .object({
          data: z.array(schema),
          next_page: z.object({ offset: z.string() }).nullable().optional(),
        })
        .parse(response.data);
      return {
        items: parsed.data,
        nextPageOffset: parsed.next_page?.offset ?? null,
      };
    },
  };
}

function snapshot(): DiscoveryResult {
  return buildDiscoverySnapshot(TEAMSPACE_ID);
}

function task(gid: string = TICKET_GID): Task {
  const discovered = snapshot();
  return {
    gid,
    name: "Ticket",
    created_at: "2026-07-31T10:00:00.000Z",
    completed: false,
    completed_at: null,
    resource_subtype: "custom",
    projects: [discovered.teamspace],
    custom_type: discovered.ticket_custom_type,
  };
}

function ticketService(
  resolve: TicketService["resolve"] = async () => task(),
): TicketService {
  return {
    resolve,
    readByGid: async () => unexpectedCall("TicketService.readByGid"),
    readTicket: async () => unexpectedCall("TicketService.readTicket"),
    createTicket: async () => unexpectedCall("TicketService.createTicket"),
    updateTicket: async () => unexpectedCall("TicketService.updateTicket"),
  };
}

function story(gid: string, overrides: Partial<Story> = {}): Story {
  return {
    gid,
    resource_subtype: "comment_added",
    text: `Comment ${gid}`,
    created_at: "2026-07-31T10:30:00.000Z",
    created_by: { gid: "1900000000000001", name: "Ada Lovelace" },
    ...overrides,
  };
}

function requiredCursor(output: { cursor: string | null }): string {
  if (output.cursor === null) {
    throw new Error("Expected a pagination cursor");
  }
  return output.cursor;
}

describe("get comments", () => {
  it("filters system stories while counting every raw story scanned", async () => {
    const calls: Array<{ taskGid: string; options: Record<string, unknown> }> = [];
    const getStories: StoriesApi["getStoriesForTaskWithHttpInfo"] = async (
      taskGid,
      options,
    ) => {
      calls.push({ taskGid, options: options ?? {} });
      if (options?.offset === undefined) {
        return pageResult(
          [
            story("1800000000000010", {
              resource_subtype: "assigned",
              text: "Ada assigned this task",
            }),
            story("1800000000000011"),
            story("1800000000000012", {
              resource_subtype: "added_to_project",
              created_by: null,
            }),
          ],
          "second-page",
        );
      }
      return pageResult([
        story("1800000000000013", {
          created_at: undefined,
          created_by: null,
        }),
      ]);
    };
    const state = executorState();
    const service = createCommentService(
      executor(resources({ getStories }), state),
      ticketService(),
    );

    const result = await service.getComments(
      { ticketId: TICKET_GID, limit: 3 },
      snapshot(),
      DEADLINE_MS,
    );

    expect(result.comments).toEqual([
      {
        gid: "1800000000000011",
        text: "Comment 1800000000000011",
        created_at: "2026-07-31T10:30:00.000Z",
        author: { gid: "1900000000000001", name: "Ada Lovelace" },
      },
      {
        gid: "1800000000000013",
        text: "Comment 1800000000000013",
        created_at: null,
        author: null,
      },
    ]);
    expect(result.scanned_count).toBe(4);
    expect(result.cursor).toBeNull();
    expect(result.has_more).toBe(false);
    expect(result.truncated).toBe(false);
    expect(GetCommentsOutputSchema.parse(result)).toEqual(result);
    expect(calls).toEqual([
      {
        taskGid: TICKET_GID,
        options: { limit: 3, opt_fields: COMMENT_STORY_FIELDS },
      },
      {
        taskGid: TICKET_GID,
        options: { limit: 2, offset: "second-page", opt_fields: COMMENT_STORY_FIELDS },
      },
    ]);
    expect(state.pageReads).toBe(2);
  });

  it("caps returned comments and resumes from its opaque cursor", async () => {
    const offsets: Array<string | undefined> = [];
    const getStories: StoriesApi["getStoriesForTaskWithHttpInfo"] = async (
      _taskGid,
      options,
    ) => {
      offsets.push(options?.offset);
      return options?.offset === undefined
        ? pageResult([story("1800000000000020")], "second-page")
        : pageResult([story("1800000000000021")]);
    };
    const service = createCommentService(
      executor(resources({ getStories }), executorState()),
      ticketService(),
    );
    const discovered = snapshot();

    const first = await service.getComments(
      { ticketId: TICKET_GID, limit: 1 },
      discovered,
      DEADLINE_MS,
    );
    expect(first.comments).toHaveLength(1);
    expect(first.cursor).not.toBeNull();
    expect(first.has_more).toBe(true);

    const second = await service.getComments(
      { ticketId: TICKET_GID, limit: 1, cursor: requiredCursor(first) },
      discovered,
      DEADLINE_MS,
    );
    expect(second.comments.map((comment) => comment.gid)).toEqual(["1800000000000021"]);
    expect(second.cursor).toBeNull();
    expect(offsets).toEqual([undefined, "second-page"]);
  });

  it("rejects a cursor reused with a different limit", async () => {
    const state = executorState();
    const getStories: StoriesApi["getStoriesForTaskWithHttpInfo"] = async () =>
      pageResult([story("1800000000000030")], "second-page");
    const service = createCommentService(
      executor(resources({ getStories }), state),
      ticketService(),
    );
    const discovered = snapshot();
    const first = await service.getComments(
      { ticketId: TICKET_GID, limit: 1 },
      discovered,
      DEADLINE_MS,
    );

    await expect(
      service.getComments(
        { ticketId: TICKET_GID, limit: 2, cursor: requiredCursor(first) },
        discovered,
        DEADLINE_MS,
      ),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    expect(state.pageReads).toBe(1);
  });

  it("rejects a cursor reused for a different resolved ticket", async () => {
    const state = executorState();
    const getStories: StoriesApi["getStoriesForTaskWithHttpInfo"] = async () =>
      pageResult([story("1800000000000040")], "second-page");
    const tickets = ticketService(async (identifier) =>
      identifier === OTHER_TICKET_GID ? task(OTHER_TICKET_GID) : task(),
    );
    const service = createCommentService(executor(resources({ getStories }), state), tickets);
    const discovered = snapshot();
    const first = await service.getComments(
      { ticketId: TICKET_GID, limit: 1 },
      discovered,
      DEADLINE_MS,
    );

    await expect(
      service.getComments(
        { ticketId: OTHER_TICKET_GID, limit: 1, cursor: requiredCursor(first) },
        discovered,
        DEADLINE_MS,
      ),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    expect(state.pageReads).toBe(1);
  });

  it("reports truncation when the raw story scan budget is exhausted", async () => {
    const getStories: StoriesApi["getStoriesForTaskWithHttpInfo"] = async () =>
      pageResult(
        [
          story("1800000000000050", { resource_subtype: "assigned" }),
          story("1800000000000051", { resource_subtype: "added_to_project" }),
        ],
        "more-stories",
      );
    const service = createCommentService(
      executor(resources({ getStories }), executorState()),
      ticketService(),
      { maxScanStories: 2 },
    );

    const result = await service.getComments(
      { ticketId: TICKET_GID, limit: 5 },
      snapshot(),
      DEADLINE_MS,
    );

    expect(result.comments).toEqual([]);
    expect(result.scanned_count).toBe(2);
    expect(result.has_more).toBe(true);
    expect(result.cursor).not.toBeNull();
    expect(result.truncated).toBe(true);
  });

  it("stops before story requests when the shared resolver rejects scope", async () => {
    const state = executorState();
    const service = createCommentService(
      executor(resources({}), state),
      ticketService(async () => {
        throw new CommandError("out_of_scope", "Ticket is outside the selected Teamspace");
      }),
    );

    await expect(
      service.getComments({ ticketId: TICKET_GID, limit: 50 }, snapshot(), DEADLINE_MS),
    ).rejects.toMatchObject({ code: "out_of_scope" });
    expect(state.pageReads).toBe(0);
  });
});

describe("add comment", () => {
  it("creates the story, authoritatively re-reads it, and returns the verified comment", async () => {
    const calls: string[] = [];
    const createStory: StoriesApi["createStoryForTaskWithHttpInfo"] = async (
      body,
      taskGid,
      options,
    ) => {
      calls.push("create");
      expect(body).toEqual({ data: { text: "Plain comment" } });
      expect(taskGid).toBe(TICKET_GID);
      expect(options).toEqual({ opt_fields: "gid" });
      return singleResult({ gid: STORY_GID }, "create-request");
    };
    const getStory: StoriesApi["getStoryWithHttpInfo"] = async (storyGid, options) => {
      calls.push("reread");
      expect(storyGid).toBe(STORY_GID);
      expect(options).toEqual({ opt_fields: COMMENT_STORY_FIELDS });
      return singleResult(
        story(STORY_GID, {
          text: "Plain comment",
        }),
        "reread-request",
      );
    };
    const state = executorState();
    const service = createCommentService(
      executor(resources({ createStory, getStory }), state),
      ticketService(),
    );

    const result = await service.addComment(
      { ticketId: TICKET_GID, text: "Plain comment" },
      snapshot(),
      DEADLINE_MS,
    );

    expect(calls).toEqual(["create", "reread"]);
    expect(state.writes).toBe(1);
    expect(state.reads).toBe(1);
    expect(state.traces).toHaveLength(1);
    expect(result).toMatchObject({
      status: "succeeded",
      outcome: "comment_added",
      asana_request_ids: ["create-request", "reread-request"],
      data: {
        story_gid: STORY_GID,
        comment: {
          gid: STORY_GID,
          text: "Plain comment",
        },
      },
    });
    expect(CommentViewSchema.parse(result.data.comment)).toEqual(result.data.comment);
  });

  it.each([
    {
      name: "resource subtype",
      reread: story(STORY_GID, {
        resource_subtype: "assigned",
        text: "Plain comment",
      }),
      mismatch: "resource_subtype",
    },
    {
      name: "text",
      reread: story(STORY_GID, {
        text: "Different comment",
      }),
      mismatch: "text",
    },
  ])("fails when the authoritative re-read has a $name mismatch", async ({ reread, mismatch }) => {
    const createStory: StoriesApi["createStoryForTaskWithHttpInfo"] = async () =>
      singleResult({ gid: STORY_GID }, "create-request");
    const getStory: StoriesApi["getStoryWithHttpInfo"] = async () =>
      singleResult(reread, "reread-request");
    const service = createCommentService(
      executor(resources({ createStory, getStory }), executorState()),
      ticketService(),
    );

    await expect(
      service.addComment(
        { ticketId: TICKET_GID, text: "Plain comment" },
        snapshot(),
        DEADLINE_MS,
      ),
    ).rejects.toMatchObject({
      code: "asana_api_error",
      details: {
        story_gid: STORY_GID,
        mismatch,
      },
      asanaRequestIds: ["create-request", "reread-request"],
    });
  });
});
