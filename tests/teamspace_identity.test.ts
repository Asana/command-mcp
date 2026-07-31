import { describe, expect, it } from "vitest";
import { tryParseAsanaAppUrl } from "../src/asana_url.js";
import { CommandError } from "../src/errors.js";
import { resolveTeamspaceIdentifier } from "../src/teamspace_identity.js";

describe("tryParseAsanaAppUrl", () => {
  it("returns null when the input is not a URL", () => {
    expect(tryParseAsanaAppUrl("not-a-url")).toBeNull();
    expect(tryParseAsanaAppUrl("1234567890")).toBeNull();
  });

  it("accepts a valid https app.asana.com URL", () => {
    const parsed = tryParseAsanaAppUrl(
      "https://app.asana.com/1/15793206719/project/1211850000337894/dev/space/1211850000337894",
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.pathname).toBe(
      "/1/15793206719/project/1211850000337894/dev/space/1211850000337894",
    );
  });

  it("rejects http URLs", () => {
    expect(() =>
      tryParseAsanaAppUrl(
        "http://app.asana.com/1/15793206719/project/1211850000337894/dev/space/1211850000337894",
      ),
    ).toThrow(CommandError);
    try {
      tryParseAsanaAppUrl(
        "http://app.asana.com/1/15793206719/project/1211850000337894/dev/space/1211850000337894",
      );
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }
  });

  it("rejects non-Asana hosts", () => {
    expect(() =>
      tryParseAsanaAppUrl(
        "https://example.com/1/15793206719/project/1211850000337894/dev/space/1211850000337894",
      ),
    ).toThrow(CommandError);
  });

  it("rejects URLs with an explicit port", () => {
    expect(() =>
      tryParseAsanaAppUrl(
        "https://app.asana.com:8443/1/15793206719/project/1211850000337894/dev/space/1211850000337894",
      ),
    ).toThrow(CommandError);
  });

  it("rejects URLs with credentials", () => {
    expect(() =>
      tryParseAsanaAppUrl(
        "https://user:pass@app.asana.com/1/15793206719/project/1211850000337894/dev/space/1211850000337894",
      ),
    ).toThrow(CommandError);
  });
});

describe("resolveTeamspaceIdentifier", () => {
  const teamspaceUrl =
    "https://app.asana.com/1/15793206719/project/1211850000337894/dev/space/1211850000337894";
  const teamspaceId = "1211850000337894";

  it("accepts a numeric ID unchanged", () => {
    expect(resolveTeamspaceIdentifier(teamspaceId)).toBe(teamspaceId);
  });

  it("canonicalizes a valid Teamspace URL", () => {
    expect(resolveTeamspaceIdentifier(teamspaceUrl)).toBe(teamspaceId);
  });

  it("tolerates trailing path segments on a Teamspace URL", () => {
    expect(resolveTeamspaceIdentifier(`${teamspaceUrl}/list/123`)).toBe(teamspaceId);
  });

  it("rejects a URL whose path lacks the dev space segments", () => {
    expect(() =>
      resolveTeamspaceIdentifier(
        "https://app.asana.com/1/15793206719/project/1211850000337894/list",
      ),
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
