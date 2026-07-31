import {
  AsanaRequestExecutor,
  type AsanaRequestExecutorOptions,
  type AsanaRequestExecutorPort,
} from "./asana_gateway.js";
import type { Config } from "./config.js";
import { createSchemaDiscoveryService, type SchemaDiscoveryService } from "./schema_discovery.js";

export type ServiceContainer = {
  readonly executor: AsanaRequestExecutorPort;
  readonly schemaDiscovery: SchemaDiscoveryService;
};

export function createServiceContainer(
  config: Config,
  options: AsanaRequestExecutorOptions = {},
): ServiceContainer {
  const executor = new AsanaRequestExecutor(config, options);
  const schemaDiscovery = createSchemaDiscoveryService(executor);
  return { executor, schemaDiscovery };
}
