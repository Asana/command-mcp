import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { CommandError } from "./errors.js";
import type { PersonalAccessTokenStore } from "./oauth_credentials.js";

type OutputWriter = {
  write(data: string): unknown;
};

export type AsanaPersonalAccessTokenLoginOptions = {
  readonly credentialStore: PersonalAccessTokenStore;
  readonly stdout?: OutputWriter;
  readonly stderr?: OutputWriter;
  readonly readPersonalAccessToken?: () => Promise<string>;
};

async function defaultReadPersonalAccessToken(stderr: OutputWriter): Promise<string> {
  if (!process.stdin.isTTY) {
    stderr.write("Paste your Asana personal access token, then press Enter:\n");
    const readline = createInterface({ input: process.stdin });
    try {
      return await readline.question("");
    } finally {
      readline.close();
    }
  }

  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) {
        stderr.write(String(chunk));
      }
      callback();
    },
  });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = readline.question("Paste your Asana personal access token: ");
    muted = true;
    return await answer;
  } finally {
    muted = false;
    readline.close();
    stderr.write("\n");
  }
}

export async function runAsanaPersonalAccessTokenLogin(
  options: AsanaPersonalAccessTokenLoginOptions,
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const rawToken = await (
    options.readPersonalAccessToken ?? (() => defaultReadPersonalAccessToken(stderr))
  )();
  const personalAccessToken = rawToken.trim();
  if (personalAccessToken.length === 0) {
    throw new CommandError("invalid_input", "The Asana personal access token cannot be blank");
  }

  await options.credentialStore.save({ version: 1, personalAccessToken });
  stdout.write(`Asana personal access token saved to ${options.credentialStore.location}\n`);
}
