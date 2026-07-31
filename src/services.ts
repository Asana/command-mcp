import {
  AsanaRequestExecutor,
  type AsanaRequestExecutorOptions,
  type AsanaRequestExecutorPort,
} from "./asana_gateway.js";
import type { Config } from "./config.js";
import { createSchemaDiscoveryService, type SchemaDiscoveryService } from "./schema_discovery.js";

export type CommandServices = {
  readonly executor: AsanaRequestExecutorPort;
  readonly schemaDiscovery: SchemaDiscoveryService;
};

export function buildServices(
  config: Config,
  options: AsanaRequestExecutorOptions = {},
): CommandServices {
  const executor = new AsanaRequestExecutor(config, options);
  const schemaDiscovery = createSchemaDiscoveryService(executor);
  return { executor, schemaDiscovery };
}
