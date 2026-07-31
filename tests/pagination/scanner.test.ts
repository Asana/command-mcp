import { describe, expect, it } from "vitest";
import type { CommandError } from "../../src/errors.js";
import {
  collectPages,
  createScanBudget,
  type PageLoadResult,
  scanPages,
} from "../../src/pagination/scanner.js";

describe("createScanBudget", () => {
  it("stops consumption at the maximum and reports exhaustion", () => {
    const budget = createScanBudget(3);

    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false);
    expect(budget.consumed).toBe(3);
    expect(budget.exhausted).toBe(true);
  });

  it("never reports a negative remaining allowance", () => {
    const budget = createScanBudget(2);
    budget.consume();
    budget.consume();
    budget.consume();

    expect(budget.remaining).toBe(0);
    expect(budget.remaining).toBeGreaterThanOrEqual(0);
  });

  it("accumulates consumption across separate scans sharing one budget", async () => {
    const budget = createScanBudget(5);
    const loadPage = async (
      _pageSize: number,
      offset: string | undefined,
    ): Promise<PageLoadResult<number>> => {
      if (offset === undefined) {
        return { items: [1, 2, 3], nextOffset: "second" };
      }
      return { items: [4, 5, 6] };
    };

    const first = await scanPages({
      limit: 3,
      budget,
      loadPage,
      visit: (item) => item,
    });
    expect(first.examined).toBe(3);
    expect(budget.consumed).toBe(3);

    const second = await scanPages({
      startOffset: "second",
      limit: 10,
      budget,
      loadPage,
      visit: (item) => item,
    });
    expect(second.examined).toBe(2);
    expect(budget.consumed).toBe(5);
    expect(budget.exhausted).toBe(true);
  });
});

describe("scanPages", () => {
  it("honors the output limit", async () => {
    const result = await scanPages({
      limit: 2,
      budget: createScanBudget(100),
      loadPage: async () => ({
        items: ["a", "b", "c", "d"],
        nextOffset: "more",
      }),
      visit: (item) => item,
    });

    expect(result.results).toEqual(["a", "b"]);
    expect(result.nextOffset).toBe("more");
    expect(result.truncated).toBe(false);
  });

  it("honors the scan budget", async () => {
    const requestedPageSizes: number[] = [];
    const result = await scanPages({
      limit: 10,
      budget: createScanBudget(3),
      loadPage: async (pageSize) => {
        requestedPageSizes.push(pageSize);
        return {
          items: ["a", "b", "c", "d", "e"],
          nextOffset: "more",
        };
      },
      visit: (item) => item,
    });

    expect(result.results).toEqual(["a", "b", "c"]);
    expect(result.examined).toBe(3);
    expect(result.truncated).toBe(true);
    expect(requestedPageSizes[0]).toBe(3);
  });

  it("requests the minimum of the API page max, remaining output, and budget allowance", async () => {
    const requestedPageSizes: number[] = [];
    await scanPages({
      limit: 20,
      budget: createScanBudget(40),
      loadPage: async (pageSize, offset) => {
        requestedPageSizes.push(pageSize);
        if (offset === undefined) {
          return {
            items: Array.from({ length: 15 }, (_, index) => index),
            nextOffset: "page-2",
          };
        }
        return { items: Array.from({ length: pageSize }, (_, index) => index + 100) };
      },
      visit: (item) => item,
    });

    expect(requestedPageSizes[0]).toBe(20);
    expect(requestedPageSizes[1]).toBe(5);
  });

  it("reports truncation when a safety bound stops the scan while source data remains", async () => {
    const result = await scanPages({
      limit: 10,
      budget: createScanBudget(2),
      loadPage: async () => ({
        items: ["a", "b", "c"],
        nextOffset: "more",
      }),
      visit: (item) => item,
    });

    expect(result.truncated).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe("more");
  });

  it("does not report truncation when the output limit is satisfied even with a next offset", async () => {
    const result = await scanPages({
      limit: 2,
      budget: createScanBudget(100),
      loadPage: async () => ({
        items: ["a", "b", "c", "d"],
        nextOffset: "more",
      }),
      visit: (item) => item,
    });

    expect(result.results).toHaveLength(2);
    expect(result.nextOffset).toBe("more");
    expect(result.truncated).toBe(false);
  });

  it("counts examined source records rather than returned results", async () => {
    const result = await scanPages({
      limit: 10,
      budget: createScanBudget(100),
      loadPage: async () => ({
        items: [1, 2, 3, 4, 5],
      }),
      visit: (item) => (item % 2 === 0 ? item : undefined),
    });

    expect(result.results).toEqual([2, 4]);
    expect(result.examined).toBe(5);
  });

  it("resumes from a supplied starting offset", async () => {
    const seenOffsets: Array<string | undefined> = [];
    await scanPages({
      startOffset: "resume-here",
      limit: 1,
      budget: createScanBudget(10),
      loadPage: async (_pageSize, offset) => {
        seenOffsets.push(offset);
        return { items: ["only"], nextOffset: "after" };
      },
      visit: (item) => item,
    });

    expect(seenOffsets).toEqual(["resume-here"]);
  });

  it("terminates when pages keep returning a next offset without matching records", async () => {
    let requests = 0;
    const result = await scanPages({
      limit: 5,
      budget: createScanBudget(100),
      maxPageRequests: 3,
      loadPage: async () => {
        requests += 1;
        return { items: ["skip", "skip"], nextOffset: "still-more" };
      },
      visit: () => undefined,
    });

    expect(requests).toBe(3);
    expect(result.results).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.hasMore).toBe(true);
  });
});

describe("collectPages", () => {
  it("aggregates items across multiple pages", async () => {
    const items = await collectPages({
      loadPage: async (_pageSize, offset) => {
        if (offset === undefined) {
          return { items: [1, 2], nextOffset: "page-2" };
        }
        if (offset === "page-2") {
          return { items: [3, 4] };
        }
        return { items: [] };
      },
    });

    expect(items).toEqual([1, 2, 3, 4]);
  });

  it("throws asana_api_error when the request-count safety limit is exceeded", async () => {
    await expect(
      collectPages({
        maxPageRequests: 2,
        loadPage: async () => ({
          items: [1],
          nextOffset: "forever",
        }),
      }),
    ).rejects.toMatchObject({
      code: "asana_api_error",
    } satisfies Partial<CommandError>);
  });
});
