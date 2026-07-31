import { z } from "zod";
import {
  type Attachment,
  AttachmentSchema,
  PULL_REQUEST_ATTACHMENT_FIELDS,
  PULL_REQUEST_STORY_FIELDS,
  type Story,
  StorySchema,
} from "../asana_contracts.js";
import type {
  AsanaHttpResult,
  AsanaRequestExecutorPort,
  AsanaRequestTrace,
} from "../asana_gateway.js";
import { CommandError } from "../errors.js";
import { createScanBudget, type ScanBudget, scanPages } from "../pagination/scanner.js";
import { type DiscoveryResult, discoveryToProvenance } from "../schema_discovery.js";
import { ProvenanceSchema } from "../teamspace_identity.js";
import type { TicketService } from "./tickets.js";

const GITHUB_PULL_REQUEST_PATTERN =
  /https?:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/[a-z0-9_-]+(?:[/?#][^\s"'<>]*)?/giu;

export const PULL_REQUEST_SCAN_LIMIT_WARNING =
  "Pull-request discovery reached the scan safety limit.";

const PullRequestProvenanceSchema = z
  .enum(["attachment", "story"])
  .describe("Where the URL was observed");

export const PullRequestResultSchema = z
  .object({
    url: z.string().url().describe("Canonical GitHub pull-request URL"),
    provenance: PullRequestProvenanceSchema,
    title: z.string().optional().describe("The attachment title when available"),
  })
  .strict();

export const GetTicketPullRequestsOutputSchema = ProvenanceSchema.extend({
  results: z
    .array(PullRequestResultSchema)
    .describe("GitHub pull-request URLs discovered in the ticket"),
  warnings: z.array(z.string()).describe("Scan-limit warnings the caller must surface"),
}).strict();

export type PullRequestResult = z.infer<typeof PullRequestResultSchema>;
export type GetTicketPullRequestsOutput = z.infer<typeof GetTicketPullRequestsOutputSchema>;

export type PullRequestService = {
  getTicketPrs(
    identifier: string,
    snapshot: DiscoveryResult,
    deadlineMs: number,
  ): Promise<GetTicketPullRequestsOutput>;
};

export type PullRequestServiceOptions = {
  readonly maxScanItems: number;
};

function ensureHttpResult(result: unknown): AsanaHttpResult {
  if (typeof result === "object" && result !== null && "response" in result && "data" in result) {
    return result as AsanaHttpResult;
  }
  throw new CommandError("asana_api_error", "Unexpected collection response shape from Asana");
}

function pageResult<T>(page: { items: T[]; nextPageOffset: string | null }): {
  items: T[];
  nextOffset?: string;
} {
  return {
    items: page.items,
    ...(page.nextPageOffset === null ? {} : { nextOffset: page.nextPageOffset }),
  };
}

function normalizePullRequestUrl(candidate: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }

  const pathSegments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const owner = pathSegments[0];
  const repository = pathSegments[1];
  const pullSegment = pathSegments[2];
  const number = pathSegments[3];
  if (
    parsed.hostname.toLowerCase() !== "github.com" ||
    owner === undefined ||
    repository === undefined ||
    pullSegment?.toLowerCase() !== "pull" ||
    number === undefined ||
    !/^\d+$/.test(number)
  ) {
    return undefined;
  }

  return `https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}/pull/${number}`;
}

function extractPullRequestUrls(value: string): string[] {
  const urls: string[] = [];
  for (const match of value.matchAll(GITHUB_PULL_REQUEST_PATTERN)) {
    const candidate = match[0];
    if (candidate === undefined) {
      continue;
    }
    const normalized = normalizePullRequestUrl(candidate);
    if (normalized !== undefined) {
      urls.push(normalized);
    }
  }
  return urls;
}

function pullRequestFromAttachment(attachment: Attachment): PullRequestResult[] | undefined {
  const candidates = [
    attachment.view_url,
    attachment.permanent_url,
    attachment.download_url,
    attachment.name,
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) {
      continue;
    }
    const url = extractPullRequestUrls(candidate)[0];
    if (url !== undefined) {
      return [
        {
          url,
          provenance: "attachment",
          ...(attachment.name === undefined ? {} : { title: attachment.name }),
        },
      ];
    }
  }
  return undefined;
}

function pullRequestsFromStory(story: Story): PullRequestResult[] | undefined {
  const results = extractPullRequestUrls(`${story.text ?? ""}\n${story.html_text ?? ""}`).map(
    (url) => ({
      url,
      provenance: "story" as const,
    }),
  );
  return results.length === 0 ? undefined : results;
}

function appendUnique(
  destination: PullRequestResult[],
  seen: Set<string>,
  groups: PullRequestResult[][],
): void {
  for (const group of groups) {
    for (const result of group) {
      if (seen.has(result.url)) {
        continue;
      }
      seen.add(result.url);
      destination.push(result);
    }
  }
}

async function scanAttachments(
  executor: AsanaRequestExecutorPort,
  ticketGid: string,
  deadlineMs: number,
  trace: AsanaRequestTrace,
  budget: ScanBudget,
  resultLimit: number,
): Promise<PullRequestResult[][]> {
  const scan = await scanPages({
    limit: resultLimit,
    budget,
    loadPage: async (pageSize, offset) => {
      const page = await executor.readPage(
        AttachmentSchema,
        { deadlineMs },
        async (resources) =>
          ensureHttpResult(
            await resources.attachments.getAttachmentsForObjectWithHttpInfo(ticketGid, {
              limit: pageSize,
              ...(offset === undefined ? {} : { offset }),
              opt_fields: PULL_REQUEST_ATTACHMENT_FIELDS,
            }),
          ),
        trace,
      );
      return pageResult(page);
    },
    visit: pullRequestFromAttachment,
  });
  return scan.results;
}

async function scanStories(
  executor: AsanaRequestExecutorPort,
  ticketGid: string,
  deadlineMs: number,
  trace: AsanaRequestTrace,
  budget: ScanBudget,
  resultLimit: number,
): Promise<PullRequestResult[][]> {
  const scan = await scanPages({
    limit: resultLimit,
    budget,
    loadPage: async (pageSize, offset) => {
      const page = await executor.readPage(
        StorySchema,
        { deadlineMs },
        async (resources) =>
          ensureHttpResult(
            await resources.stories.getStoriesForTaskWithHttpInfo(ticketGid, {
              limit: pageSize,
              ...(offset === undefined ? {} : { offset }),
              opt_fields: PULL_REQUEST_STORY_FIELDS,
            }),
          ),
        trace,
      );
      return pageResult(page);
    },
    visit: pullRequestsFromStory,
  });
  return scan.results;
}

export function createPullRequestService(
  executor: AsanaRequestExecutorPort,
  tickets: TicketService,
  options: PullRequestServiceOptions,
): PullRequestService {
  return {
    async getTicketPrs(identifier, snapshot, deadlineMs) {
      const trace = executor.createTrace();
      const ticket = await tickets.resolve(identifier, snapshot, deadlineMs, { trace });
      const budget = createScanBudget(options.maxScanItems);
      const results: PullRequestResult[] = [];
      const seen = new Set<string>();

      const attachmentResults = await scanAttachments(
        executor,
        ticket.gid,
        deadlineMs,
        trace,
        budget,
        options.maxScanItems,
      );
      appendUnique(results, seen, attachmentResults);

      if (!budget.exhausted) {
        const storyResults = await scanStories(
          executor,
          ticket.gid,
          deadlineMs,
          trace,
          budget,
          options.maxScanItems,
        );
        appendUnique(results, seen, storyResults);
      }

      return GetTicketPullRequestsOutputSchema.parse({
        ...discoveryToProvenance(snapshot),
        results,
        warnings: budget.exhausted ? [PULL_REQUEST_SCAN_LIMIT_WARNING] : [],
      });
    },
  };
}
