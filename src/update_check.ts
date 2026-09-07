import { SERVER_VERSION } from "./version.js";

const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/Asana/command-mcp/releases/latest";
const CHECK_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type UpdateChecker = () => Promise<string | null>;

export type UpdateCheckerOptions = {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly currentVersion?: string;
};

function isNewerVersion(candidate: string, current: string): boolean {
  const candidateParts = candidate.split(".").map(Number);
  const currentParts = current.split(".").map(Number);
  const length = Math.max(candidateParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    const candidatePart = candidateParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (candidatePart !== currentPart) {
      return candidatePart > currentPart;
    }
  }
  return false;
}

function latestVersionFromTagName(tagName: unknown): string | null {
  if (typeof tagName !== "string") {
    return null;
  }
  const version = tagName.startsWith("v") ? tagName.slice(1) : tagName;
  return /^\d+(\.\d+)*$/.test(version) ? version : null;
}

/**
 * Never throws: a failed, timed-out, or malformed check is indistinguishable from
 * "already up to date" (both resolve to `null`), since this is a best-effort nudge
 * that must not break the tool call it's attached to.
 */
export function createGitHubUpdateChecker(options: UpdateCheckerOptions = {}): UpdateChecker {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const currentVersion = options.currentVersion ?? SERVER_VERSION;
  let cached: { checkedAtMs: number; latestVersion: string | null } | null = null;

  return async function checkForUpdate(): Promise<string | null> {
    if (cached !== null && now() - cached.checkedAtMs < cacheTtlMs) {
      return cached.latestVersion;
    }

    let latestVersion: string | null = null;
    try {
      const response = await fetchImpl(GITHUB_LATEST_RELEASE_URL, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (response.ok) {
        const body: unknown = await response.json();
        const tagName =
          typeof body === "object" && body !== null && "tag_name" in body
            ? (body as { tag_name?: unknown }).tag_name
            : undefined;
        const candidate = latestVersionFromTagName(tagName);
        if (candidate !== null && isNewerVersion(candidate, currentVersion)) {
          latestVersion = candidate;
        }
      }
    } catch {
      latestVersion = null;
    }

    cached = { checkedAtMs: now(), latestVersion };
    return latestVersion;
  };
}
