import { describe, expect, it } from "vitest";
import { buildServices } from "../src/services.js";
import { CONFIG } from "./helpers/tool_test_helpers.js";

describe("buildServices", () => {
  it("constructs the request executor and domain services", () => {
    const services = buildServices(CONFIG);
    expect(services.executor).toBeDefined();
    expect(services.context).toBeDefined();
    expect(services.schemaDiscovery).toBeDefined();
    expect(services.tickets).toBeDefined();
    expect(services.workflow).toBeDefined();
    expect(typeof services.context.listWorkspaces).toBe("function");
    expect(typeof services.context.findTeamspaces).toBe("function");
    expect(typeof services.context.getContext).toBe("function");
    expect(typeof services.schemaDiscovery.discover).toBe("function");
    expect(typeof services.tickets.resolve).toBe("function");
    expect(typeof services.tickets.readByGid).toBe("function");
    expect(typeof services.tickets.readTicket).toBe("function");
    expect(typeof services.tickets.createTicket).toBe("function");
    expect(typeof services.tickets.updateTicket).toBe("function");
    expect(typeof services.workflow.addDependency).toBe("function");
    expect(typeof services.workflow.removeDependency).toBe("function");
    expect(typeof services.executor.createTrace).toBe("function");
  });
});
