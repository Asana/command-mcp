import { describe, expect, it } from "vitest";
import { createServiceContainer } from "../src/service_container.js";
import { CONFIG } from "./helpers/tool_test_helpers.js";

describe("createServiceContainer", () => {
  it("constructs the request executor and schema discovery service", () => {
    const container = createServiceContainer(CONFIG);
    expect(container.executor).toBeDefined();
    expect(container.schemaDiscovery).toBeDefined();
    expect(typeof container.schemaDiscovery.discover).toBe("function");
    expect(typeof container.executor.createTrace).toBe("function");
  });
});
