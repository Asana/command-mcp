import { z } from "zod";
import { CommandError } from "./errors.js";

const KEYCHAIN_SERVICE = "com.asana.command-mcp";
const OAUTH_KEYCHAIN_ACCOUNT = "oauth.default";
const PAT_KEYCHAIN_ACCOUNT = "pat.default";
const KEYCHAIN_TIMEOUT_MS = 30_000;

const StoredPersonalAccessTokenSchema = z
  .object({
    version: z.literal(1),
    personalAccessToken: z.string().trim().min(1),
  })
  .strict();

const StoredOAuthCredentialsSchema = z
  .object({
    version: z.literal(1),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    refreshToken: z.string().min(1),
  })
  .strict();

export type StoredOAuthCredentials = z.infer<typeof StoredOAuthCredentialsSchema>;
export type StoredPersonalAccessToken = z.infer<typeof StoredPersonalAccessTokenSchema>;

export type PersonalAccessTokenStore = {
  readonly location: string;
  load(): Promise<StoredPersonalAccessToken | null>;
  save(credentials: StoredPersonalAccessToken): Promise<void>;
};

export type OAuthCredentialStore = {
  readonly location: string;
  load(): Promise<StoredOAuthCredentials | null>;
  save(credentials: StoredOAuthCredentials): Promise<void>;
};

export type KeychainEntry = {
  getPassword(signal?: AbortSignal): Promise<string | null | undefined>;
  setPassword(password: string, signal?: AbortSignal): Promise<void>;
};

function keychainUnavailable(cause: unknown): CommandError {
  return new CommandError("invalid_configuration", "The operating system keychain is unavailable", {
    cause,
  });
}

function invalidStoredCredentials(cause?: unknown): CommandError {
  return new CommandError(
    "invalid_configuration",
    "Stored Asana OAuth credentials are invalid; run auth login again",
    cause === undefined ? undefined : { cause },
  );
}

function invalidStoredPersonalAccessToken(cause?: unknown): CommandError {
  return new CommandError(
    "invalid_configuration",
    "The stored Asana personal access token is invalid; run auth login again",
    cause === undefined ? undefined : { cause },
  );
}

export function createKeychainPersonalAccessTokenStore(
  entry: KeychainEntry,
): PersonalAccessTokenStore {
  return {
    location: "operating system keychain",
    async load() {
      let serialized: string | null;
      try {
        serialized = (await entry.getPassword(AbortSignal.timeout(KEYCHAIN_TIMEOUT_MS))) ?? null;
      } catch (error) {
        throw keychainUnavailable(error);
      }
      if (serialized === null) {
        return null;
      }

      try {
        return StoredPersonalAccessTokenSchema.parse(JSON.parse(serialized));
      } catch (error) {
        throw invalidStoredPersonalAccessToken(error);
      }
    },
    async save(credentials) {
      const parsed = StoredPersonalAccessTokenSchema.parse(credentials);
      try {
        await entry.setPassword(JSON.stringify(parsed), AbortSignal.timeout(KEYCHAIN_TIMEOUT_MS));
      } catch (error) {
        throw keychainUnavailable(error);
      }
    },
  };
}

export function createKeychainOAuthCredentialStore(entry: KeychainEntry): OAuthCredentialStore {
  return {
    location: "operating system keychain",
    async load() {
      let serialized: string | null;
      try {
        serialized = (await entry.getPassword(AbortSignal.timeout(KEYCHAIN_TIMEOUT_MS))) ?? null;
      } catch (error) {
        throw keychainUnavailable(error);
      }
      if (serialized === null) {
        return null;
      }

      try {
        return StoredOAuthCredentialsSchema.parse(JSON.parse(serialized));
      } catch (error) {
        throw invalidStoredCredentials(error);
      }
    },
    async save(credentials) {
      const parsed = StoredOAuthCredentialsSchema.parse(credentials);
      try {
        await entry.setPassword(JSON.stringify(parsed), AbortSignal.timeout(KEYCHAIN_TIMEOUT_MS));
      } catch (error) {
        throw keychainUnavailable(error);
      }
    },
  };
}

export function createDefaultOAuthCredentialStore(): OAuthCredentialStore {
  let entryPromise: Promise<KeychainEntry> | undefined;
  const loadEntry = (): Promise<KeychainEntry> => {
    entryPromise ??= import("@napi-rs/keyring").then(
      ({ AsyncEntry }) => new AsyncEntry(KEYCHAIN_SERVICE, OAUTH_KEYCHAIN_ACCOUNT),
    );
    return entryPromise;
  };
  return createKeychainOAuthCredentialStore({
    getPassword: async (signal) => (await loadEntry()).getPassword(signal),
    setPassword: async (password, signal) => (await loadEntry()).setPassword(password, signal),
  });
}

export function createDefaultPersonalAccessTokenStore(): PersonalAccessTokenStore {
  let entryPromise: Promise<KeychainEntry> | undefined;
  const loadEntry = (): Promise<KeychainEntry> => {
    entryPromise ??= import("@napi-rs/keyring").then(
      ({ AsyncEntry }) => new AsyncEntry(KEYCHAIN_SERVICE, PAT_KEYCHAIN_ACCOUNT),
    );
    return entryPromise;
  };
  return createKeychainPersonalAccessTokenStore({
    getPassword: async (signal) => (await loadEntry()).getPassword(signal),
    setPassword: async (password, signal) => (await loadEntry()).setPassword(password, signal),
  });
}
