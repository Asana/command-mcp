import { describe, expect, it } from "vitest";
import { buildServices } from "../src/services.js";
import { CONFIG } from "./helpers/tool_test_helpers.js";

describe("buildServices", () => {
  it("constructs the request executor and schema discovery service", () => {
    const services = buildServices(CONFIG);
    expect(services.executor).toBeDefined();
    expect(services.schemaDiscovery).toBeDefined();
    expect(typeof services.schemaDiscovery.discover).toBe("function");
    expect(typeof services.executor.createTrace).toBe("function");
  });
});
