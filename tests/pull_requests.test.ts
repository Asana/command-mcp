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
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Attachment, Story, Task } from "../src/asana_contracts.js";
import type {
  AsanaHttpResult,
  AsanaRequestExecutorPort,
  AsanaResourceBundle,
} from "../src/asana_gateway.js";
import { CommandError } from "../src/errors.js";
import type { DiscoveryResult } from "../src/schema_discovery.js";
import {
  createPullRequestService,
  PULL_REQUEST_SCAN_LIMIT_WARNING,
} from "../src/tools/pull_requests.js";
import type { TicketService } from "../src/tools/tickets.js";
import { buildDiscoverySnapshot, DEADLINE_MS, TEAMSPACE_ID } from "./helpers/tool_test_helpers.js";

const TICKET_GID = "1700000000000001";
const FIRST_PAGE = Symbol("first page");

type Page<T> = {
  items: T[];
  nextOffset?: string;
};

type PageSet<T> = Map<string | typeof FIRST_PAGE, Page<T>>;

type CollectionCall = {
  parent: string;
  options: {
    limit?: number;
    offset?: string;
    opt_fields?: string;
  };
};

type ServiceFixtureOptions = {
  attachmentPages?: PageSet<Attachment>;
  storyPages?: PageSet<Story>;
  maxScanItems?: number;
  resolve?: TicketService["resolve"];
};

function unexpectedCall(name: string): never {
  throw new Error(`Unexpected call to ${name}`);
}

function createThrowingApi<T extends object>(apiName: string): T {
  const target = { apiClient: {} };
  return new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) {
        return Reflect.get(object, property, receiver);
      }
      if (property === "then") {
        return undefined;
      }
      return (..._args: unknown[]) => unexpectedCall(`${apiName}.${String(property)}`);
    },
  }) as T;
}

function collectionResult(items: unknown[], nextOffset?: string): AsanaHttpResult {
  return {
    response: { headers: {} },
    data: {
      data: items,
      next_page: nextOffset === undefined ? null : { offset: nextOffset },
    },
  };
}

function pageFor<T>(pages: PageSet<T>, offset: string | undefined): Page<T> {
  const page = pages.get(offset ?? FIRST_PAGE);
  if (page === undefined) {
    return unexpectedCall(`page offset ${offset ?? "first"}`);
  }
  return page;
}

function createResourceBundle(
  options: ServiceFixtureOptions,
  attachmentCalls: CollectionCall[],
  storyCalls: CollectionCall[],
): AsanaResourceBundle {
  const attachments = createThrowingApi<AttachmentsApi>("attachments");
  const stories = createThrowingApi<StoriesApi>("stories");

  if (options.attachmentPages !== undefined) {
    const getAttachments: AttachmentsApi["getAttachmentsForObjectWithHttpInfo"] = async (
      parent,
      requestOptions,
    ) => {
      attachmentCalls.push({ parent, options: requestOptions ?? {} });
      const page = pageFor(options.attachmentPages ?? new Map(), requestOptions?.offset);
      return collectionResult(page.items, page.nextOffset);
    };
    attachments.getAttachmentsForObjectWithHttpInfo = getAttachments;
  }

  if (options.storyPages !== undefined) {
    const getStories: StoriesApi["getStoriesForTaskWithHttpInfo"] = async (
      parent,
      requestOptions,
    ) => {
      storyCalls.push({ parent, options: requestOptions ?? {} });
      const page = pageFor(options.storyPages ?? new Map(), requestOptions?.offset);
      return collectionResult(page.items, page.nextOffset);
    };
    stories.getStoriesForTaskWithHttpInfo = getStories;
  }

  return {
    tasks: createThrowingApi<TasksApi>("tasks"),
    projects: createThrowingApi<ProjectsApi>("projects"),
    stories,
    attachments,
    customFieldSettings: createThrowingApi<CustomFieldSettingsApi>("customFieldSettings"),
    customTypes: createThrowingApi<CustomTypesApi>("customTypes"),
    typeahead: createThrowingApi<TypeaheadApi>("typeahead"),
    workspaces: createThrowingApi<WorkspacesApi>("workspaces"),
  };
}

function createExecutor(resources: AsanaResourceBundle): AsanaRequestExecutorPort {
  return {
    createTrace: () => ({ requestIds: [] }),
    read: async () => unexpectedCall("AsanaRequestExecutor.read"),
    write: async () => unexpectedCall("AsanaRequestExecutor.write"),
    readPage: async (schema, options, callback) => {
      expect(options.deadlineMs).toBe(DEADLINE_MS);
      const result = await callback(resources);
      const parsed = z
        .object({
          data: z.array(schema),
          next_page: z.object({ offset: z.string() }).nullable().optional(),
        })
        .parse(result.data);
      return {
        items: parsed.data,
        nextPageOffset: parsed.next_page?.offset ?? null,
      };
    },
  };
}

function ticket(snapshot: DiscoveryResult): Task {
  return {
    gid: TICKET_GID,
    name: "Discover linked pull requests",
    created_at: "2026-07-31T10:00:00.000Z",
    completed: false,
    completed_at: null,
    resource_subtype: "custom",
    projects: [{ gid: snapshot.teamspace.gid, name: snapshot.teamspace.name }],
    custom_type: snapshot.ticket_custom_type,
    custom_fields: [],
  };
}

function createTicketServiceFake(resolve: TicketService["resolve"]): TicketService {
  return {
    resolve,
    readByGid: async () => unexpectedCall("TicketService.readByGid"),
    readTicket: async () => unexpectedCall("TicketService.readTicket"),
    createTicket: async () => unexpectedCall("TicketService.createTicket"),
    updateTicket: async () => unexpectedCall("TicketService.updateTicket"),
  };
}

function attachment(gid: string, values: Partial<Attachment>): Attachment {
  return { gid, ...values };
}

function story(gid: string, values: Partial<Story>): Story {
  return { gid, ...values };
}

function pages<T>(first: Page<T>, rest: Record<string, Page<T>> = {}): PageSet<T> {
  return new Map<string | typeof FIRST_PAGE, Page<T>>([
    [FIRST_PAGE, first],
    ...Object.entries(rest),
  ]);
}

function createFixture(options: ServiceFixtureOptions) {
  const snapshot = buildDiscoverySnapshot(TEAMSPACE_ID);
  const attachmentCalls: CollectionCall[] = [];
  const storyCalls: CollectionCall[] = [];
  const resolveCalls: string[] = [];
  const resolve: TicketService["resolve"] =
    options.resolve ??
    (async (identifier, discovered, deadlineMs) => {
      resolveCalls.push(identifier);
      expect(discovered).toBe(snapshot);
      expect(deadlineMs).toBe(DEADLINE_MS);
      return ticket(snapshot);
    });
  const resources = createResourceBundle(options, attachmentCalls, storyCalls);
  const service = createPullRequestService(
    createExecutor(resources),
    createTicketServiceFake(resolve),
    { maxScanItems: options.maxScanItems ?? 100 },
  );

  return {
    snapshot,
    service,
    attachmentCalls,
    storyCalls,
    resolveCalls,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pull-request service", () => {
  it("finds a pull-request URL in an attachment view URL with its title", async () => {
    const fixture = createFixture({
      attachmentPages: pages({
        items: [
          attachment("1800000000000001", {
            name: "Improve retries",
            view_url: "https://github.com/asana/command-mcp/pull/123?notification_referrer_id=1",
          }),
        ],
      }),
      storyPages: pages({ items: [] }),
    });

    const result = await fixture.service.getTicketPrs("ENG-42", fixture.snapshot, DEADLINE_MS);

    expect(result.results).toEqual([
      {
        url: "https://github.com/asana/command-mcp/pull/123",
        provenance: "attachment",
        title: "Improve retries",
      },
    ]);
  });

  it("finds a pull-request URL appearing only in an attachment name", async () => {
    const fixture = createFixture({
      attachmentPages: pages({
        items: [
          attachment("1800000000000001", {
            name: "Review https://github.com/asana/command-mcp/pull/124/files",
            view_url: "https://app.asana.com/0/0/1800000000000001",
          }),
        ],
      }),
      storyPages: pages({ items: [] }),
    });

    const result = await fixture.service.getTicketPrs(TICKET_GID, fixture.snapshot, DEADLINE_MS);

    expect(result.results).toEqual([
      {
        url: "https://github.com/asana/command-mcp/pull/124",
        provenance: "attachment",
        title: "Review https://github.com/asana/command-mcp/pull/124/files",
      },
    ]);
  });

  it("consults attachment URL fields in view, permanent, then download order", async () => {
    const fixture = createFixture({
      attachmentPages: pages({
        items: [
          attachment("1800000000000001", {
            name: "https://github.com/asana/command-mcp/pull/400",
            view_url: "https://example.com/not-a-pull-request",
            permanent_url: "https://github.com/asana/command-mcp/pull/200",
            download_url: "https://github.com/asana/command-mcp/pull/300",
          }),
          attachment("1800000000000002", {
            name: "https://github.com/asana/command-mcp/pull/401",
            view_url: "https://github.com/asana/command-mcp/pull/100",
            permanent_url: "https://github.com/asana/command-mcp/pull/201",
            download_url: "https://github.com/asana/command-mcp/pull/301",
          }),
        ],
      }),
      storyPages: pages({ items: [] }),
    });

    const result = await fixture.service.getTicketPrs(TICKET_GID, fixture.snapshot, DEADLINE_MS);

    expect(result.results.map(({ url }) => url)).toEqual([
      "https://github.com/asana/command-mcp/pull/200",
      "https://github.com/asana/command-mcp/pull/100",
    ]);
  });

  it("ignores an attachment without a GitHub pull-request URL", async () => {
    const fixture = createFixture({
      attachmentPages: pages({
        items: [
          attachment("1800000000000001", {
            name: "Design document",
            view_url: "https://drive.example.com/document/1",
            permanent_url: "https://app.asana.com/0/0/1800000000000001",
          }),
        ],
      }),
      storyPages: pages({ items: [] }),
    });

    const result = await fixture.service.getTicketPrs(TICKET_GID, fixture.snapshot, DEADLINE_MS);

    expect(result.results).toEqual([]);
  });

  it("returns every pull-request URL from one story", async () => {
    const fixture = createFixture({
      attachmentPages: pages({ items: [] }),
      storyPages: pages({
        items: [
          story("1900000000000001", {
            text: "First https://github.com/asana/command-mcp/pull/125",
            html_text:
              '<body>Second <a href="https://github.com/asana/command-mcp/pull/126/files">PR</a></body>',
          }),
        ],
      }),
    });

    const result = await fixture.service.getTicketPrs(TICKET_GID, fixture.snapshot, DEADLINE_MS);

    expect(result.results).toEqual([
      {
        url: "https://github.com/asana/command-mcp/pull/125",
        provenance: "story",
      },
      {
        url: "https://github.com/asana/command-mcp/pull/126",
        provenance: "story",
      },
    ]);
  });

  it("keeps text and HTML URLs distinct when the fields meet at URL boundaries", async () => {
    const fixture = createFixture({
      attachmentPages: pages({ items: [] }),
      storyPages: pages({
        items: [
          story("1900000000000001", {
            text: "https://github.com/asana/command-mcp/pull/133",
            html_text: "https://github.com/asana/command-mcp/pull/134",
          }),
        ],
      }),
    });

    const result = await fixture.service.getTicketPrs(TICKET_GID, fixture.snapshot, DEADLINE_MS);

    expect(result.results.map(({ url }) => url)).toEqual([
      "https://github.com/asana/command-mcp/pull/133",
      "https://github.com/asana/command-mcp/pull/134",
    ]);
  });

  it("deduplicates normalized URLs across sources and keeps the first occurrence", async () => {
    const fixture = createFixture({
      attachmentPages: pages({
        items: [
          attachment("1800000000000001", {
            name: "Original attachment",
            view_url: "https://github.com/ASANA/Command-MCP/Pull/127?utm_source=asana",
          }),
        ],
      }),
      storyPages: pages({
        items: [
          story("1900000000000001", {
            text: "Also https://github.com/ASANA/Command-MCP/Pull/127/files",
            html_text: "Again https://github.com/asana/command-mcp/pull/127#discussion",
          }),
        ],
      }),
    });

    const result = await fixture.service.getTicketPrs(TICKET_GID, fixture.snapshot, DEADLINE_MS);

    expect(result.results).toEqual([
      {
        url: "https://github.com/asana/command-mcp/pull/127",
        provenance: "attachment",
        title: "Original attachment",
      },
    ]);
  });

  it("rejects a candidate whose pull-request number segment is not numeric", async () => {
    const fixture = createFixture({
      attachmentPages: pages({
        items: [
          attachment("1800000000000001", {
            view_url: "https://github.com/asana/command-mcp/pull/not-a-number/files",
          }),
        ],
      }),
      storyPages: pages({
        items: [
          story("1900000000000001", {
            text: "Invalid https://github.com/asana/command-mcp/pull/12x?diff=split",
          }),
        ],
      }),
    });

    const result = await fixture.service.getTicketPrs(TICKET_GID, fixture.snapshot, DEADLINE_MS);

    expect(result.results).toEqual([]);
  });

  it("records attachment and story provenance independently", async () => {
    const fixture = createFixture({
      attachmentPages: pages({
        items: [
          attachment("1800000000000001", {
            view_url: "https://github.com/asana/command-mcp/pull/128",
          }),
        ],
      }),
      storyPages: pages({
        items: [
          story("1900000000000001", {
            text: "https://github.com/asana/command-mcp/pull/129",
          }),
        ],
      }),
    });

    const result = await fixture.service.getTicketPrs(TICKET_GID, fixture.snapshot, DEADLINE_MS);

    expect(result.results.map(({ provenance }) => provenance)).toEqual(["attachment", "story"]);
  });

  it("shares one scan budget and warns when attachments exhaust it before stories", async () => {
    const fixture = createFixture({
      maxScanItems: 2,
      attachmentPages: pages({
        items: [
          attachment("1800000000000001", {
            view_url: "https://github.com/asana/command-mcp/pull/130",
          }),
          attachment("1800000000000002", { name: "Not a pull request" }),
        ],
        nextOffset: "more-attachments",
      }),
    });

    const result = await fixture.service.getTicketPrs(TICKET_GID, fixture.snapshot, DEADLINE_MS);

    expect(fixture.attachmentCalls).toHaveLength(1);
    expect(fixture.attachmentCalls[0]?.options.limit).toBe(2);
    expect(fixture.storyCalls).toEqual([]);
    expect(result.warnings).toEqual([PULL_REQUEST_SCAN_LIMIT_WARNING]);
  });

  it("omits the warning when both scans complete within the shared budget", async () => {
    const fixture = createFixture({
      maxScanItems: 3,
      attachmentPages: pages({
        items: [attachment("1800000000000001", { name: "No link" })],
      }),
      storyPages: pages({
        items: [
          story("1900000000000001", {
            text: "https://github.com/asana/command-mcp/pull/131",
          }),
        ],
      }),
    });

    const result = await fixture.service.getTicketPrs(TICKET_GID, fixture.snapshot, DEADLINE_MS);

    expect(result.warnings).toEqual([]);
    expect(fixture.attachmentCalls[0]).toMatchObject({
      parent: TICKET_GID,
      options: { limit: 3 },
    });
    expect(fixture.storyCalls[0]).toMatchObject({
      parent: TICKET_GID,
      options: { limit: 2 },
    });
  });

  it("fails out of scope before scanning either collection", async () => {
    const fixture = createFixture({
      resolve: async () => {
        throw new CommandError("out_of_scope", "Ticket is outside the selected Teamspace");
      },
    });

    await expect(
      fixture.service.getTicketPrs(TICKET_GID, fixture.snapshot, DEADLINE_MS),
    ).rejects.toMatchObject({ code: "out_of_scope" });
    expect(fixture.attachmentCalls).toEqual([]);
    expect(fixture.storyCalls).toEqual([]);
  });

  it("parses discovered links locally without requesting any non-Asana host", async () => {
    const fetchSpy = vi.fn(() => unexpectedCall("fetch"));
    vi.stubGlobal("fetch", fetchSpy);
    const fixture = createFixture({
      attachmentPages: pages({ items: [] }),
      storyPages: pages({
        items: [
          story("1900000000000001", {
            text: "https://github.com/asana/command-mcp/pull/132",
          }),
        ],
      }),
    });

    await fixture.service.getTicketPrs(TICKET_GID, fixture.snapshot, DEADLINE_MS);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fixture.resolveCalls).toEqual([TICKET_GID]);
  });
});
