import { describe, expect, it } from "vitest";
import {
  createKeychainOAuthCredentialStore,
  createKeychainPersonalAccessTokenStore,
  type KeychainEntry,
} from "../src/oauth_credentials.js";

function createEntry(initialPassword: string | null = null): {
  entry: KeychainEntry;
  passwords: string[];
} {
  let password = initialPassword;
  const passwords: string[] = [];
  return {
    entry: {
      getPassword: async () => password,
      setPassword: async (nextPassword) => {
        password = nextPassword;
        passwords.push(nextPassword);
      },
    },
    passwords,
  };
}

describe("OAuth credential store", () => {
  it("returns null when no keychain login has been stored", async () => {
    const { entry } = createEntry();
    const store = createKeychainOAuthCredentialStore(entry);

    await expect(store.load()).resolves.toBeNull();
  });

  it("stores the client secret and refresh token in the operating system keychain", async () => {
    const { entry, passwords } = createEntry();
    const store = createKeychainOAuthCredentialStore(entry);

    await store.save({
      version: 1,
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });

    await expect(store.load()).resolves.toEqual({
      version: 1,
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });
    expect(passwords).toHaveLength(1);
    expect(passwords[0]).toContain("client-secret");
    expect(passwords[0]).toContain("refresh-token");
    expect(passwords[0]).not.toContain("access-token");
    expect(store.location).toBe("operating system keychain");
  });

  it("fails closed when the keychain credential does not match its schema", async () => {
    const { entry } = createEntry(JSON.stringify({ version: 1, clientId: "client-id" }));
    const store = createKeychainOAuthCredentialStore(entry);

    await expect(store.load()).rejects.toMatchObject({
      code: "invalid_configuration",
      message: "Stored Asana OAuth credentials are invalid; run auth login again",
    });
  });

  it("fails closed when the operating system keychain is unavailable", async () => {
    const keychainMessage = "org.freedesktop.secrets is unavailable";
    const entry: KeychainEntry = {
      getPassword: async () => {
        throw new Error(keychainMessage);
      },
      setPassword: async () => {
        throw new Error(keychainMessage);
      },
    };
    const store = createKeychainOAuthCredentialStore(entry);

    await expect(store.load()).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({
        code: "invalid_configuration",
        message: "The operating system keychain is unavailable",
      });
      expect((error as Error).message).not.toContain(keychainMessage);
      return true;
    });
    await expect(
      store.save({
        version: 1,
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      }),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      message: "The operating system keychain is unavailable",
    });
  });
});

describe("personal access token store", () => {
  it("returns null when no token has been stored", async () => {
    const { entry } = createEntry();
    const store = createKeychainPersonalAccessTokenStore(entry);

    await expect(store.load()).resolves.toBeNull();
  });

  it("stores the personal access token in the operating system keychain", async () => {
    const { entry, passwords } = createEntry();
    const store = createKeychainPersonalAccessTokenStore(entry);

    await store.save({ version: 1, personalAccessToken: "personal-access-token" });

    await expect(store.load()).resolves.toEqual({
      version: 1,
      personalAccessToken: "personal-access-token",
    });
    expect(passwords).toEqual([
      JSON.stringify({ version: 1, personalAccessToken: "personal-access-token" }),
    ]);
    expect(store.location).toBe("operating system keychain");
  });

  it("fails closed when a stored token does not match its schema", async () => {
    const { entry } = createEntry(JSON.stringify({ version: 1, personalAccessToken: "   " }));
    const store = createKeychainPersonalAccessTokenStore(entry);

    await expect(store.load()).rejects.toMatchObject({
      code: "invalid_configuration",
      message: "The stored Asana personal access token is invalid; run auth login again",
    });
  });

  it("fails closed when the operating system keychain is unavailable", async () => {
    const entry: KeychainEntry = {
      getPassword: async () => {
        throw new Error("keychain secret");
      },
      setPassword: async () => {
        throw new Error("keychain secret");
      },
    };
    const store = createKeychainPersonalAccessTokenStore(entry);

    await expect(store.load()).rejects.toMatchObject({
      code: "invalid_configuration",
      message: "The operating system keychain is unavailable",
    });
    await expect(
      store.save({ version: 1, personalAccessToken: "personal-access-token" }),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      message: "The operating system keychain is unavailable",
    });
  });
});
