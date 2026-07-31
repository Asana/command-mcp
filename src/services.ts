import {
  AsanaRequestExecutor,
  type AsanaRequestExecutorOptions,
  type AsanaRequestExecutorPort,
} from "./asana_gateway.js";
import type { Config } from "./config.js";
import { type ContextService, createContextService } from "./context.js";
import { createSchemaDiscoveryService, type SchemaDiscoveryService } from "./schema_discovery.js";

export type CommandServices = {
  readonly executor: AsanaRequestExecutorPort;
  readonly context: ContextService;
  readonly schemaDiscovery: SchemaDiscoveryService;
};

export function buildServices(
  config: Config,
  options: AsanaRequestExecutorOptions = {},
): CommandServices {
  const executor = new AsanaRequestExecutor(config, options);
  const context = createContextService(executor);
  const schemaDiscovery = createSchemaDiscoveryService(executor);
  return { executor, context, schemaDiscovery };
}
