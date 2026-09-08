import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(import.meta.dirname, "../src");
const WRAPPER_CALL_PATTERN = /^\.(optional|nullable|nullish)\(/;

function listTypeScriptFiles(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      listTypeScriptFiles(fullPath, files);
    } else if (entry.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Zod v4 silently drops a schema's description when `.optional()`, `.nullable()`, or
 * `.nullish()` is chained after `.describe(...)` (the wrapper doesn't forward it) — no type
 * error, no runtime error, just an undocumented field in the public tool schema. `.describe()`
 * must always be the last call in a chain. See CODE-1176-adjacent zod v4 migration notes.
 */
function findDescribeBeforeWrapper(content: string): number[] {
  const violationLines: number[] = [];
  let searchIndex = 0;
  while (true) {
    const describeStart = content.indexOf(".describe(", searchIndex);
    if (describeStart === -1) {
      break;
    }

    let parenDepth = 0;
    let cursor = describeStart + ".describe(".length - 1;
    let stringDelimiter: string | null = null;
    let closeIndex = -1;
    for (; cursor < content.length; cursor += 1) {
      const character = content[cursor];
      if (stringDelimiter !== null) {
        if (character === "\\") {
          cursor += 1;
          continue;
        }
        if (character === stringDelimiter) {
          stringDelimiter = null;
        }
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        stringDelimiter = character;
        continue;
      }
      if (character === "(") {
        parenDepth += 1;
      } else if (character === ")") {
        parenDepth -= 1;
        if (parenDepth === 0) {
          closeIndex = cursor;
          break;
        }
      }
    }
    if (closeIndex === -1) {
      searchIndex = describeStart + 1;
      continue;
    }

    let afterIndex = closeIndex + 1;
    while (afterIndex < content.length && /\s/.test(content[afterIndex] ?? "")) {
      afterIndex += 1;
    }
    if (WRAPPER_CALL_PATTERN.test(content.slice(afterIndex, afterIndex + 12))) {
      violationLines.push(content.slice(0, describeStart).split("\n").length);
    }
    searchIndex = closeIndex + 1;
  }
  return violationLines;
}

describe("zod .describe() chain order", () => {
  it("never calls .optional(), .nullable(), or .nullish() after .describe() in src/", () => {
    const violations: string[] = [];
    for (const filePath of listTypeScriptFiles(SRC_ROOT)) {
      const content = readFileSync(filePath, "utf8");
      const lines = findDescribeBeforeWrapper(content);
      for (const line of lines) {
        violations.push(`${relative(SRC_ROOT, filePath)}:${line}`);
      }
    }
    expect(
      violations,
      `Found .describe().optional()/.nullable()/.nullish() ordering (drops the description under zod v4). Swap to .optional().describe(...) etc. at:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
