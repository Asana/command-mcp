import { describe, expect, it } from "vitest";
import { SERVER_VERSION } from "../src/version.js";

describe("SERVER_VERSION", () => {
  it("is a non-empty string", () => {
    expect(SERVER_VERSION).toBeTypeOf("string");
    expect(SERVER_VERSION.length).toBeGreaterThan(0);
  });
});
