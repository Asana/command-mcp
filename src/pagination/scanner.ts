import { CommandError } from "../errors.js";

export const API_PAGE_MAX = 100;
export const MAX_PAGE_REQUESTS = 200;

export type PageLoadResult<T> = {
  items: T[];
  nextOffset?: string | number;
};

export type PageLoader<T> = (
  pageSize: number,
  offset: string | number | undefined,
) => Promise<PageLoadResult<T>>;

export type ScanBudget = {
  readonly consumed: number;
  readonly remaining: number;
  readonly exhausted: boolean;
  consume(): boolean;
};

export function createScanBudget(maximum: number): ScanBudget {
  let consumed = 0;

  return {
    get consumed() {
      return consumed;
    },
    get remaining() {
      return Math.max(0, maximum - consumed);
    },
    get exhausted() {
      return consumed >= maximum;
    },
    consume() {
      if (consumed >= maximum) {
        return false;
      }
      consumed += 1;
      return true;
    },
  };
}

export type ScanPagesOptions<T, R> = {
  startOffset?: string | number;
  limit: number;
  budget: ScanBudget;
  loadPage: PageLoader<T>;
  visit: (item: T) => R | undefined;
  maxPageRequests?: number;
};

export type ScanPagesResult<R> = {
  results: R[];
  nextOffset?: string | number;
  hasMore: boolean;
  examined: number;
  truncated: boolean;
};

export async function scanPages<T, R>(
  options: ScanPagesOptions<T, R>,
): Promise<ScanPagesResult<R>> {
  const {
    startOffset,
    limit,
    budget,
    loadPage,
    visit,
    maxPageRequests = MAX_PAGE_REQUESTS,
  } = options;

  const results: R[] = [];
  let offset: string | number | undefined = startOffset;
  let examined = 0;
  let pageRequests = 0;
  let lastPageNextOffset: string | number | undefined;
  let stoppedBySafetyBound = false;

  while (results.length < limit && !budget.exhausted) {
    if (pageRequests >= maxPageRequests) {
      stoppedBySafetyBound = true;
      break;
    }

    const resultsNeeded = limit - results.length;
    const pageSize = Math.min(API_PAGE_MAX, resultsNeeded, budget.remaining);
    if (pageSize <= 0) {
      stoppedBySafetyBound = true;
      break;
    }

    pageRequests += 1;
    const page = await loadPage(pageSize, offset);
    lastPageNextOffset = page.nextOffset;

    const itemsToExamine = page.items.slice(0, budget.remaining);
    for (const item of itemsToExamine) {
      if (!budget.consume()) {
        stoppedBySafetyBound = true;
        break;
      }
      examined += 1;
      const result = visit(item);
      if (result !== undefined) {
        results.push(result);
        if (results.length >= limit) {
          break;
        }
      }
    }

    if (results.length >= limit) {
      break;
    }

    if (budget.exhausted) {
      stoppedBySafetyBound = true;
      break;
    }

    if (page.nextOffset === undefined) {
      break;
    }

    offset = page.nextOffset;
  }

  const outputLimitReached = results.length >= limit;
  const hasMore = lastPageNextOffset !== undefined;
  const truncated = hasMore && stoppedBySafetyBound && !outputLimitReached;
  const nextOffset = outputLimitReached || truncated ? lastPageNextOffset : undefined;

  return {
    results,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    hasMore,
    examined,
    truncated,
  };
}

export type CollectPagesOptions<T> = {
  loadPage: PageLoader<T>;
  maxPageRequests?: number;
};

export async function collectPages<T>(options: CollectPagesOptions<T>): Promise<T[]> {
  const { loadPage, maxPageRequests = MAX_PAGE_REQUESTS } = options;
  const collected: T[] = [];
  let offset: string | number | undefined;
  let pageRequests = 0;

  while (true) {
    if (pageRequests >= maxPageRequests) {
      throw new CommandError(
        "asana_api_error",
        "Exceeded the safety limit while loading paginated data from Asana",
      );
    }

    pageRequests += 1;
    const page = await loadPage(API_PAGE_MAX, offset);
    collected.push(...page.items);

    if (page.nextOffset === undefined) {
      break;
    }

    offset = page.nextOffset;
  }

  return collected;
}
