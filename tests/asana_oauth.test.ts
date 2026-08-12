import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ASANA_OAUTH_REDIRECT_URI,
  loadAsanaOAuthLoginConfig,
  runAsanaOAuthLogin,
} from "../src/asana_oauth.js";
import type { OAuthCredentialStore, StoredOAuthCredentials } from "../src/oauth_credentials.js";

function createWriter(lines: string[]) {
  return {
    write(data: string) {
      lines.push(data);
    },
  };
}

function createStore(saved: StoredOAuthCredentials[]): OAuthCredentialStore {
  return {
    location: "operating system keychain",
    load: async () => null,
    save: async (credentials) => {
      saved.push(credentials);
    },
  };
}

describe("Asana OAuth login", () => {
  it("loads Full-permission OAuth app credentials independently of legacy variables", () => {
    expect(
      loadAsanaOAuthLoginConfig({
        ASANA_OAUTH_CLIENT_ID: " client-id ",
        ASANA_OAUTH_CLIENT_SECRET: " client-secret ",
      }),
    ).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
    });

    expect(
      loadAsanaOAuthLoginConfig({
        ASANA_ACCESS_TOKEN: "legacy-token",
        ASANA_OAUTH_CLIENT_ID: "client-id",
        ASANA_OAUTH_CLIENT_SECRET: "client-secret",
      }),
    ).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
    });

    expect(() =>
      loadAsanaOAuthLoginConfig({
        ASANA_OAUTH_CLIENT_ID: "client-id",
        ASANA_OAUTH_CLIENT_SECRET: "client-secret",
        ASANA_OAUTH_SCOPES: "tasks:read",
      }),
    ).toThrowError(/Full permissions/);
  });

  it("opens Asana authorization, verifies state and PKCE, and stores long-lived credentials", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const saved: StoredOAuthCredentials[] = [];
    let authorizationUrl = "";
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "access-token",
            expires_in: 3600,
            token_type: "bearer",
            refresh_token: "refresh-token",
          }),
          { status: 200 },
        ),
    );

    await runAsanaOAuthLogin({
      app: {
        clientId: "client-id",
        clientSecret: "client-secret",
      },
      credentialStore: createStore(saved),
      fetch,
      openBrowser: async (url) => {
        authorizationUrl = url;
        return true;
      },
      readAuthorizationResponse: async () => {
        const state = new URL(authorizationUrl).searchParams.get("state");
        return `${ASANA_OAUTH_REDIRECT_URI}?code=authorization-code&state=${state}`;
      },
      stdout: createWriter(stdout),
      stderr: createWriter(stderr),
    });

    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://app.asana.com/-/oauth_authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(ASANA_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBeNull();

    expect(fetch).toHaveBeenCalledOnce();
    const [tokenUrl, init] = fetch.mock.calls[0] ?? [];
    expect(tokenUrl).toBe("https://app.asana.com/-/oauth_token");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");
    expect(body.get("redirect_uri")).toBe(ASANA_OAUTH_REDIRECT_URI);
    expect(body.get("code")).toBe("authorization-code");
    const verifier = body.get("code_verifier");
    expect(verifier).not.toBeNull();
    const expectedChallenge = createHash("sha256")
      .update(verifier ?? "")
      .digest("base64url");
    expect(url.searchParams.get("code_challenge")).toBe(expectedChallenge);

    expect(saved).toEqual([
      {
        version: 1,
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
    ]);
    expect(`${stdout.join("")} ${stderr.join("")}`).not.toContain("access-token");
    expect(`${stdout.join("")} ${stderr.join("")}`).not.toContain("refresh-token");
    expect(stdout.join("")).toContain("Asana OAuth login completed");
  });

  it("accepts the standalone authorization code displayed by Asana's OOB page", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "access-token",
            expires_in: 3600,
            token_type: "bearer",
            refresh_token: "refresh-token",
          }),
          { status: 200 },
        ),
    );

    await runAsanaOAuthLogin({
      app: { clientId: "client-id", clientSecret: "client-secret" },
      credentialStore: createStore([]),
      fetch,
      openBrowser: async () => true,
      readAuthorizationResponse: async () => " 2/user-gid/client-id:opaque-authorization-code\n",
      stdout: createWriter([]),
      stderr: createWriter([]),
    });

    const [, init] = fetch.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("code")).toBe("2/user-gid/client-id:opaque-authorization-code");
    expect(body.get("code_verifier")).not.toBeNull();
  });

  it("rejects a redirect with a mismatched state before token exchange", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const saved: StoredOAuthCredentials[] = [];

    await expect(
      runAsanaOAuthLogin({
        app: { clientId: "client-id", clientSecret: "client-secret" },
        credentialStore: createStore(saved),
        fetch,
        openBrowser: async () => true,
        readAuthorizationResponse: async () =>
          `${ASANA_OAUTH_REDIRECT_URI}?code=authorization-code&state=wrong-state`,
        stdout: createWriter([]),
        stderr: createWriter([]),
      }),
    ).rejects.toMatchObject({ code: "authentication_failed" });

    expect(fetch).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("does not expose OAuth secrets when Asana rejects the code exchange", async () => {
    const secret = "customer-client-secret";

    await expect(
      runAsanaOAuthLogin({
        app: { clientId: "client-id", clientSecret: secret },
        credentialStore: createStore([]),
        fetch: async () =>
          new Response(JSON.stringify({ error_description: `${secret} was rejected` }), {
            status: 400,
            headers: { "x-asana-request-id": "oauth-login-request-id" },
          }),
        openBrowser: async () => true,
        readAuthorizationResponse: async (authorizationUrl) => {
          const state = new URL(authorizationUrl).searchParams.get("state");
          return `${ASANA_OAUTH_REDIRECT_URI}?code=authorization-code&state=${state}`;
        },
        stdout: createWriter([]),
        stderr: createWriter([]),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ code: "authentication_failed" });
      expect((error as Error).message).not.toContain(secret);
      expect(error).toMatchObject({ asanaRequestIds: ["oauth-login-request-id"] });
      return true;
    });
  });
});
