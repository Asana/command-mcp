import {
  AsanaRequestExecutor,
  type AsanaRequestExecutorOptions,
  type AsanaRequestExecutorPort,
} from "./asana_gateway.js";
import type { Config } from "./config.js";
import { createSchemaDiscoveryService, type SchemaDiscoveryService } from "./schema_discovery.js";
import { type ContextService, createContextService } from "./tools/context.js";
import { createTicketService, type TicketService } from "./tools/tickets.js";

export type CommandServices = {
  readonly executor: AsanaRequestExecutorPort;
  readonly context: ContextService;
  readonly schemaDiscovery: SchemaDiscoveryService;
  readonly tickets: TicketService;
};

export function buildServices(
  config: Config,
  options: AsanaRequestExecutorOptions = {},
): CommandServices {
  const executor = new AsanaRequestExecutor(config, options);
  const context = createContextService(executor);
  const schemaDiscovery = createSchemaDiscoveryService(executor);
  const tickets = createTicketService(executor, { createTimeoutMs: config.createTimeoutMs });
  return { executor, context, schemaDiscovery, tickets };
}
