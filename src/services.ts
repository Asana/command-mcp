import {
  AsanaRequestExecutor,
  type AsanaRequestExecutorOptions,
  type AsanaRequestExecutorPort,
} from "./asana_gateway.js";
import type { Config } from "./config.js";
import { createSchemaDiscoveryService, type SchemaDiscoveryService } from "./schema_discovery.js";
import { type CommentService, createCommentService } from "./tools/comments.js";
import { type ContextService, createContextService } from "./tools/context.js";
import { createPullRequestService, type PullRequestService } from "./tools/pull_requests.js";
import { createReleaseService, type ReleaseService } from "./tools/releases.js";
import { createTicketListingService, type TicketListingService } from "./tools/ticket_listing.js";
import { createTicketService, type TicketService } from "./tools/tickets.js";
import { createWorkflowService, type WorkflowService } from "./tools/workflow.js";

export type CommandServices = {
  readonly executor: AsanaRequestExecutorPort;
  readonly context: ContextService;
  readonly schemaDiscovery: SchemaDiscoveryService;
  readonly comments: CommentService;
  readonly pullRequests: PullRequestService;
  readonly releases: ReleaseService;
  readonly tickets: TicketService;
  readonly ticketListing: TicketListingService;
  readonly workflow: WorkflowService;
};

export function buildServices(
  config: Config,
  options: AsanaRequestExecutorOptions = {},
): CommandServices {
  const executor = new AsanaRequestExecutor(config, options);
  const context = createContextService(executor);
  const schemaDiscovery = createSchemaDiscoveryService(executor);
  const tickets = createTicketService(executor, { createTimeoutMs: config.createTimeoutMs });
  const ticketListing = createTicketListingService(executor, {
    maxScanTasks: config.maxScanTasks,
  });
  const comments = createCommentService(executor, tickets);
  const pullRequests = createPullRequestService(executor, tickets, {
    maxScanItems: config.maxScanTasks,
  });
  const releases = createReleaseService(executor, tickets);
  const workflow = createWorkflowService(executor, tickets);
  return {
    executor,
    context,
    schemaDiscovery,
    comments,
    pullRequests,
    releases,
    tickets,
    ticketListing,
    workflow,
  };
}
