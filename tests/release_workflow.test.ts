import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

describe("release workflow", () => {
  it("publishes version-matched tags after all release checks pass", () => {
    expect(workflow).toContain("tags:");
    expect(workflow).toContain('- "v*"');
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("v$" + "{packageJson.version}");
    expect(workflow).toContain("npm run check");
    expect(workflow).toContain("npm audit");
    expect(workflow).toContain("npm pack --dry-run");
    expect(workflow).toContain("npm pack --json");
  });

  it("executes and uploads the packed tarball", () => {
    expect(workflow).toContain('npx --yes --package "$ARCHIVE" asana-command-mcp doctor');
    expect(workflow).not.toContain("ASANA_ACCESS_TOKEN");
    expect(workflow).toContain("Asana OAuth login is missing; run asana-command-mcp auth login");
    expect(workflow).toContain("softprops/action-gh-release@");
    expect(workflow).toContain("files: $" + "{{ steps.pack.outputs.archive }}");
  });
});
