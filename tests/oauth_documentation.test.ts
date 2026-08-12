import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("OAuth documentation", () => {
  it("requires Full permissions without advertising unsupported granular scopes", () => {
    expect(readme).toContain("Select **Full permissions**");
    expect(readme).not.toContain("ASANA_OAUTH_SCOPES");
  });

  it("requires the MCP client to restart after re-authentication", () => {
    expect(readme).toContain("restart Claude Code or Codex");
  });
});
