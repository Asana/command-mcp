import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const DRAFT_07_SCHEMA_URI = "http://json-schema.org/draft-07/schema#";
const DRAFT_2020_12_SCHEMA_URI = "https://json-schema.org/draft/2020-12/schema";

function relabelSchemaDialect(schema: unknown): void {
  if (
    typeof schema !== "object" ||
    schema === null ||
    (schema as { $schema?: unknown }).$schema !== DRAFT_07_SCHEMA_URI
  ) {
    return;
  }
  (schema as { $schema: string }).$schema = DRAFT_2020_12_SCHEMA_URI;
}

function relabelToolsListResult(result: unknown): void {
  if (typeof result !== "object" || result === null) {
    return;
  }
  const { tools } = result as { tools?: unknown };
  if (!Array.isArray(tools)) {
    return;
  }
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) {
      continue;
    }
    relabelSchemaDialect((tool as { inputSchema?: unknown }).inputSchema);
    relabelSchemaDialect((tool as { outputSchema?: unknown }).outputSchema);
  }
}

/**
 * WORKAROUND: @modelcontextprotocol/sdk (as of 1.30.0, the latest release) always advertises
 * `tools/list` schemas with `$schema: "http://json-schema.org/draft-07/schema#"` — the SDK's
 * `tools/list` handler never passes a `target` to its schema converter, which defaults to
 * draft-07 (see `mapMiniTarget` in the SDK's `zod-json-schema-compat.js`). Claude Desktop's tool
 * runner rejects draft-07 schemas and only accepts JSON Schema 2020-12, so every tool call fails.
 *
 * This relabels the dialect in transit rather than fixing the schema shape, which is only safe
 * because this server never emits tuple-style `items` arrays (2020-12 requires `prefixItems` for
 * tuples instead, so a shape-changing fix would be needed if that ever changes).
 *
 * Upstream bug: https://github.com/modelcontextprotocol/typescript-sdk/issues/2084 (root cause)
 * and https://github.com/modelcontextprotocol/typescript-sdk/issues/2721 (this exact symptom).
 * A fix has been proposed but not merged/released (PRs #2085, #2653).
 *
 * TODO: delete this file and its call site once a released SDK version emits 2020-12 by default.
 */
export function applyJsonSchemaDialectWorkaround(transport: Transport): Transport {
  const originalSend = transport.send.bind(transport);
  transport.send = (message: JSONRPCMessage, options) => {
    if ("result" in message) {
      relabelToolsListResult(message.result);
    }
    return originalSend(message, options);
  };
  return transport;
}
