#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runCli } from "./cli.js";
import { asCommandError } from "./errors.js";

async function main(): Promise<void> {
  const envFile = resolve(process.cwd(), ".env");
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  await runCli();
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(asCommandError(error).toPayload())}\n`);
  process.exitCode = 1;
});
