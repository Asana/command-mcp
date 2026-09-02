import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("OAuth documentation", () => {
  it("presents PAT login first and keeps OAuth setup collapsible", () => {
    expect(readme).toContain("## Sign in to Asana");
    expect(readme).toContain("Create and store a personal access token");
    expect(readme).toContain("<summary>Use OAuth instead</summary>");
    expect(readme).toContain("auth login --oauth");
  });

  it("requires Full permissions without advertising unsupported granular scopes", () => {
    expect(readme).toContain("Select **Full permissions**");
    expect(readme).not.toContain("ASANA_OAUTH_SCOPES");
  });

  it("requires the MCP client to restart after re-authentication", () => {
    expect(readme).toContain("restart the client");
  });
});
