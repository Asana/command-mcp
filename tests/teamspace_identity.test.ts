import { describe, expect, it } from "vitest";
import { tryParseAsanaAppUrl } from "../src/asana_url.js";
import { CommandError } from "../src/errors.js";
import {
  resolveTeamspaceIdentifier,
  TeamspaceIdentifierSchema,
} from "../src/teamspace_identity.js";

const WORKSPACE_GID = "15793206719";
const TEAMSPACE_ID = "1211850000337894";
const TEAMSPACE_URL = `https://app.asana.com/1/${WORKSPACE_GID}/dev/space/${TEAMSPACE_ID}`;
const TEAMSPACE_URL_WITH_TRAILING = `${TEAMSPACE_URL}/development`;

describe("tryParseAsanaAppUrl", () => {
  it("returns null when the input is not a URL", () => {
    expect(tryParseAsanaAppUrl("not-a-url")).toBeNull();
    expect(tryParseAsanaAppUrl("1234567890")).toBeNull();
  });

  it("accepts a valid https app.asana.com URL", () => {
    const parsed = tryParseAsanaAppUrl(TEAMSPACE_URL);
    expect(parsed).not.toBeNull();
    expect(parsed?.pathname).toBe(
      `/${["1", WORKSPACE_GID, "dev", "space", TEAMSPACE_ID].join("/")}`,
    );
  });

  it("rejects http URLs", () => {
    expect(() =>
      tryParseAsanaAppUrl(`http://app.asana.com/1/${WORKSPACE_GID}/dev/space/${TEAMSPACE_ID}`),
    ).toThrow(CommandError);
    try {
      tryParseAsanaAppUrl(`http://app.asana.com/1/${WORKSPACE_GID}/dev/space/${TEAMSPACE_ID}`);
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }
  });

  it("rejects non-Asana hosts", () => {
    expect(() =>
      tryParseAsanaAppUrl(`https://example.com/1/${WORKSPACE_GID}/dev/space/${TEAMSPACE_ID}`),
    ).toThrow(CommandError);
  });

  it("rejects URLs with an explicit port", () => {
    expect(() =>
      tryParseAsanaAppUrl(
        `https://app.asana.com:8443/1/${WORKSPACE_GID}/dev/space/${TEAMSPACE_ID}`,
      ),
    ).toThrow(CommandError);
  });

  it("rejects URLs with credentials", () => {
    expect(() =>
      tryParseAsanaAppUrl(
        `https://user:pass@app.asana.com/1/${WORKSPACE_GID}/dev/space/${TEAMSPACE_ID}`,
      ),
    ).toThrow(CommandError);
  });
});

describe("TeamspaceIdentifierSchema", () => {
  it("rejects empty and whitespace-only identifiers", () => {
    expect(TeamspaceIdentifierSchema.safeParse("").success).toBe(false);
    expect(TeamspaceIdentifierSchema.safeParse("   ").success).toBe(false);
  });

  it("trims surrounding whitespace before validation", () => {
    expect(TeamspaceIdentifierSchema.parse(` ${TEAMSPACE_ID} `)).toBe(TEAMSPACE_ID);
  });
});

describe("resolveTeamspaceIdentifier", () => {
  it("accepts a numeric ID unchanged", () => {
    expect(resolveTeamspaceIdentifier(TEAMSPACE_ID)).toBe(TEAMSPACE_ID);
  });

  it("trims surrounding whitespace from numeric IDs", () => {
    expect(resolveTeamspaceIdentifier(` ${TEAMSPACE_ID} `)).toBe(TEAMSPACE_ID);
  });

  it("canonicalizes a valid Teamspace URL without trailing segments", () => {
    expect(resolveTeamspaceIdentifier(TEAMSPACE_URL)).toBe(TEAMSPACE_ID);
  });

  it("canonicalizes a valid Teamspace URL with trailing path segments", () => {
    expect(resolveTeamspaceIdentifier(TEAMSPACE_URL_WITH_TRAILING)).toBe(TEAMSPACE_ID);
  });

  it("rejects a URL whose path lacks the dev space segments", () => {
    expect(() =>
      resolveTeamspaceIdentifier(`https://app.asana.com/1/${WORKSPACE_GID}/list`),
    ).toThrow(CommandError);
  });

  it("rejects a non-URL string that is not numeric", () => {
    expect(() => resolveTeamspaceIdentifier("my-teamspace")).toThrow(CommandError);
    try {
      resolveTeamspaceIdentifier("my-teamspace");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }
  });
});
