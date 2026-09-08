import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { applyJsonSchemaDialectWorkaround } from "../src/json_schema_dialect_workaround.js";

class RecordingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly sent: JSONRPCMessage[] = [];

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
  }

  async close(): Promise<void> {}
}

function toolsListResponse(tools: unknown[]): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { tools },
  } as JSONRPCMessage;
}

describe("applyJsonSchemaDialectWorkaround", () => {
  it("relabels a draft-07 inputSchema and outputSchema to 2020-12", async () => {
    const recorder = new RecordingTransport();
    const transport = applyJsonSchemaDialectWorkaround(recorder);

    await transport.send(
      toolsListResponse([
        {
          name: "get_context",
          inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
          outputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
        },
      ]),
    );

    expect(recorder.sent[0]).toMatchObject({
      result: {
        tools: [
          {
            inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema" },
            outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema" },
          },
        ],
      },
    });
  });

  it("leaves a schema that already declares a different dialect untouched", async () => {
    const recorder = new RecordingTransport();
    const transport = applyJsonSchemaDialectWorkaround(recorder);

    await transport.send(
      toolsListResponse([
        {
          name: "get_context",
          inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
        },
      ]),
    );

    expect(recorder.sent[0]).toMatchObject({
      result: {
        tools: [{ inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema" } }],
      },
    });
  });

  it("leaves a tool without $schema untouched", async () => {
    const recorder = new RecordingTransport();
    const transport = applyJsonSchemaDialectWorkaround(recorder);

    await transport.send(
      toolsListResponse([{ name: "get_context", inputSchema: { type: "object" } }]),
    );

    expect(recorder.sent[0]).toMatchObject({
      result: { tools: [{ inputSchema: { type: "object" } }] },
    });
  });

  it("passes through messages with no result unchanged", async () => {
    const recorder = new RecordingTransport();
    const transport = applyJsonSchemaDialectWorkaround(recorder);
    const notification: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "notifications/message",
      params: {},
    } as JSONRPCMessage;

    await transport.send(notification);

    expect(recorder.sent).toEqual([notification]);
  });

  it("passes through a result with no tools array unchanged", async () => {
    const recorder = new RecordingTransport();
    const transport = applyJsonSchemaDialectWorkaround(recorder);
    const response: JSONRPCMessage = { jsonrpc: "2.0", id: 1, result: {} } as JSONRPCMessage;

    await transport.send(response);

    expect(recorder.sent).toEqual([response]);
  });
});
