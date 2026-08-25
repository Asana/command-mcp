import { describe, expect, it } from "vitest";
import { runAsanaPersonalAccessTokenLogin } from "../src/asana_pat.js";
import type { PersonalAccessTokenStore } from "../src/oauth_credentials.js";

describe("Asana personal access token login", () => {
  it("reads, trims, and stores the token without printing it", async () => {
    const saved: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const credentialStore: PersonalAccessTokenStore = {
      location: "operating system keychain",
      load: async () => null,
      save: async (credentials) => {
        saved.push(credentials.personalAccessToken);
      },
    };

    await runAsanaPersonalAccessTokenLogin({
      credentialStore,
      readPersonalAccessToken: async () => "  personal-access-token  ",
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    });

    expect(saved).toEqual(["personal-access-token"]);
    expect(stdout.join("")).toContain("saved to operating system keychain");
    expect(stdout.join("")).not.toContain("personal-access-token");
    expect(stderr.join("")).not.toContain("personal-access-token");
  });

  it("rejects a blank token", async () => {
    const credentialStore: PersonalAccessTokenStore = {
      location: "operating system keychain",
      load: async () => null,
      save: async () => undefined,
    };

    await expect(
      runAsanaPersonalAccessTokenLogin({
        credentialStore,
        readPersonalAccessToken: async () => "   ",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
