import { describe, expect, it, vi } from "vitest";
import { createGitHubUpdateChecker } from "../src/update_check.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("createGitHubUpdateChecker", () => {
  it("reports the latest tag when it is newer than the current version", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ tag_name: "v0.4.0" }));
    const checkForUpdate = createGitHubUpdateChecker({ fetch, currentVersion: "0.3.0" });

    await expect(checkForUpdate()).resolves.toBe("0.4.0");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/repos/Asana/command-mcp/releases/latest");
    expect(init?.headers).toMatchObject({ accept: "application/vnd.github+json" });
  });

  it.each([
    ["equal versions", "v0.3.0", "0.3.0"],
    ["an older tag", "v0.2.9", "0.3.0"],
  ])("returns null for %s", async (_name, tagName, currentVersion) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ tag_name: tagName }));
    const checkForUpdate = createGitHubUpdateChecker({ fetch, currentVersion });

    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("compares version segments numerically, not lexically", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ tag_name: "v0.10.0" }));
    const checkForUpdate = createGitHubUpdateChecker({ fetch, currentVersion: "0.9.0" });

    await expect(checkForUpdate()).resolves.toBe("0.10.0");
  });

  it("fails open (returns null) on a non-2xx response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}, 503));
    const checkForUpdate = createGitHubUpdateChecker({ fetch, currentVersion: "0.3.0" });

    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("fails open on a network error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("network unreachable");
    });
    const checkForUpdate = createGitHubUpdateChecker({ fetch, currentVersion: "0.3.0" });

    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("fails open on a malformed or missing tag_name", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ tag_name: 42 }));
    const checkForUpdate = createGitHubUpdateChecker({ fetch, currentVersion: "0.3.0" });

    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("caches the result and does not call fetch again within the TTL", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ tag_name: "v0.4.0" }));
    let now = 0;
    const checkForUpdate = createGitHubUpdateChecker({
      fetch,
      currentVersion: "0.3.0",
      now: () => now,
      cacheTtlMs: 1_000,
    });

    await expect(checkForUpdate()).resolves.toBe("0.4.0");
    now += 500;
    await expect(checkForUpdate()).resolves.toBe("0.4.0");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("re-checks once the cache TTL has elapsed", async () => {
    let tag = "v0.3.0";
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ tag_name: tag }));
    let now = 0;
    const checkForUpdate = createGitHubUpdateChecker({
      fetch,
      currentVersion: "0.3.0",
      now: () => now,
      cacheTtlMs: 1_000,
    });

    await expect(checkForUpdate()).resolves.toBeNull();
    tag = "v0.4.0";
    now += 1_001;
    await expect(checkForUpdate()).resolves.toBe("0.4.0");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
