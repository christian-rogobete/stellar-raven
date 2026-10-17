/**
 * Optional host ranking over a bounded native catalog page.
 * Host adapters own transport, request approval, and monetary accounting.
 */
import {
  finalizeSearchPage,
  MAX_SEARCH_LIMIT,
  searchCatalogPage,
  type SearchHit,
  type SearchOptions,
  type SearchPage
} from "./search.ts";
import type { Catalog } from "./types.ts";

export type RankingCandidate = Readonly<
  Pick<SearchHit, "id" | "service" | "kind" | "description">
>;

export type RankingInput = Readonly<{
  query: string;
  candidates: readonly RankingCandidate[];
}>;

/**
 * A provider returns an array of { id, score }, not a dictionary: duplicate
 * identities can be rejected here. A live adapter must separately validate its
 * wire response, model identity, usage, and transport limits before returning.
 */
export type SearchRankingProvider = (
  input: RankingInput,
  context: { signal: AbortSignal }
) => Promise<unknown>;

const ERROR_CODES = [
  "approval", "aborted", "timeout", "configuration", "budget", "input", "transport",
  "http-auth", "http-rate-limit", "http-error", "response", "model", "usage", "unknown"
] as const;
export type RankingProviderErrorCode = typeof ERROR_CODES[number];

/** Accept only the closed host diagnostic vocabulary; arbitrary strings stay private. */
export function safeRankingErrorCode(value: unknown): RankingProviderErrorCode | undefined {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value)
    ? value as RankingProviderErrorCode : undefined;
}

/** Host adapters report a fixed category without attaching provider text or payloads. */
export class RankingProviderError extends Error {
  readonly code: RankingProviderErrorCode;

  constructor(code: RankingProviderErrorCode) {
    const safeCode = safeRankingErrorCode(code) ?? "unknown";
    super(`Ranking provider: ${safeCode}`);
    this.code = safeCode;
  }
}

/** Shared across the caller's searches; a reserved attempt is never refunded. */
export type RankingCallBudget = { tryReserve: () => boolean };

/** Create a shared attempt limit; failed attempts remain spent. */
export function createRankingCallBudget(maxCalls: number): RankingCallBudget {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) {
    throw new RangeError("Ranking call limit must be a nonnegative safe integer");
  }
  let remaining = maxCalls;
  return {
    tryReserve: () => {
      if (remaining === 0) return false;
      remaining -= 1;
      return true;
    }
  };
}

type NativeReason =
  | "disabled" | "aborted" | "bypass" | "insufficient-candidates"
  | "budget" | "timeout" | "provider-error" | "invalid-response";

export type RankingDecision =
  | { method: "native"; reason: NativeReason; errorCode?: RankingProviderErrorCode }
  | { method: "provider"; candidateCount: number };

export type ProviderRanking = Extract<RankingDecision, { method: "provider" }>;

/** Only a successful override is model-facing; fallback keeps the native envelope. */
export function providerRankingFields(ranking?: RankingDecision): { ranking?: ProviderRanking } {
  return ranking?.method === "provider" ? { ranking } : {};
}

export const PROVIDER_ORDER_NOTE = "Hit order is authoritative: a host ranking provider ordered the bounded candidate pool. score and tier retain native lexical provenance and do not determine this order. confidence reports native score facts for the visible hits, not model certainty.";

export type ResolvedSearchPage = { page: SearchPage; ranking: RankingDecision };
export type CatalogPageResolver = (
  catalog: Catalog,
  options: SearchOptions,
  context?: { signal?: AbortSignal }
) => Promise<ResolvedSearchPage>;

function validatedScores(value: unknown, hits: readonly SearchHit[]): Map<string, number> | null {
  if (!Array.isArray(value) || value.length !== hits.length) return null;
  const expected = new Set(hits.map((hit) => hit.id));
  const scores = new Map<string, number>();
  let sum = 0;
  for (const row of value) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
    const { id, score } = row as { id?: unknown; score?: unknown };
    if (typeof id !== "string" || !expected.has(id) || scores.has(id) ||
        typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      return null;
    }
    scores.set(id, score);
    sum += score;
  }
  return sum > 0 ? scores : null;
}

/**
 * A factory keeps one attempt budget across searches. Its timeout bounds waiting
 * even if the provider ignores cancellation. It never retries or logs payloads.
 */
export function createRankedSearchResolver(options: {
  provider?: SearchRankingProvider;
  budget: RankingCallBudget;
  timeoutMs: number;
}): CatalogPageResolver {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2000) {
    throw new RangeError("Ranking timeout must be between 1 and 2000 ms");
  }
  // Capture configuration so changes to the caller's options cannot alter an
  // in-flight attempt's provider, timeout, or budget.
  const { provider, budget, timeoutMs } = options;
  return async (catalog, requested, context = {}) => {
    const opts = { ...requested };
    const fallback = searchCatalogPage(catalog, opts);
    const native = (reason: NativeReason, errorCode?: RankingProviderErrorCode): ResolvedSearchPage => ({
      page: fallback, ranking: { method: "native", reason, ...(errorCode ? { errorCode } : {}) }
    });
    if (!provider) return native("disabled");
    if (context.signal?.aborted) return native("aborted");
    if (!Number.isInteger(fallback.effectiveLimit) ||
        catalog.entries.some((entry) => entry.id === opts.query.trim())) {
      return native("bypass");
    }
    const pool = searchCatalogPage(catalog, { ...opts, limit: MAX_SEARCH_LIMIT });
    if (pool.hits.length < 2) return native("insufficient-candidates");

    // Provider receives immutable value copies, never page hits, scores, schemas,
    // credentials, catalog internals, or objects it could mutate for callers.
    const input: RankingInput = Object.freeze({
      query: opts.query,
      candidates: Object.freeze(pool.hits.map((hit) => Object.freeze({
        id: hit.id, service: hit.service, kind: hit.kind, description: hit.description
      })))
    });
    try {
      if (!budget.tryReserve()) return native("budget");
    } catch {
      return native("budget");
    }

    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    const expired = () => {
      if (performance.now() < deadline) return false;
      controller.abort();
      return true;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interrupt: (() => void) | undefined;
    type Outcome = { kind: "response"; value: unknown } | { kind: "error"; errorCode?: RankingProviderErrorCode }
      | { kind: "timeout" } | { kind: "aborted" };
    const interrupted = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({ kind: "timeout" });
        controller.abort();
      }, timeoutMs);
      interrupt = () => {
        resolve({ kind: "aborted" });
        controller.abort();
      };
      context.signal?.addEventListener("abort", interrupt, { once: true });
    });
    try {
      const response = Promise.resolve().then(async (): Promise<Outcome> => {
        if (context.signal?.aborted || controller.signal.aborted) return { kind: "aborted" };
        try {
          return { kind: "response", value: await provider(input, { signal: controller.signal }) };
        } catch (error) {
          return { kind: "error", errorCode: error instanceof RankingProviderError
            ? safeRankingErrorCode(error.code) : undefined };
        }
      });
      const outcome = await Promise.race([response, interrupted]);
      if (context.signal?.aborted || outcome.kind === "aborted") return native("aborted");
      // A blocking provider can settle a microtask before the overdue timer.
      // Reject late results as well; this cannot preempt synchronous host code.
      if (outcome.kind === "timeout" || expired()) return native("timeout");
      if (outcome.kind === "error") return native("provider-error", outcome.errorCode);
      let scores: Map<string, number> | null;
      try {
        scores = validatedScores(outcome.value, pool.hits);
      } catch {
        return native("invalid-response");
      }
      if (!scores) return native("invalid-response");
      const hits = pool.hits
        .map((hit, index) => ({ hit, index }))
        .sort((a, b) => scores.get(b.hit.id)! - scores.get(a.hit.id)! || a.index - b.index)
        .slice(0, fallback.effectiveLimit)
        .map(({ hit }) => hit);
      const page = finalizeSearchPage(catalog, opts, hits, {
        total: pool.total,
        effectiveLimit: fallback.effectiveLimit,
        recoveryMetadata: pool.recoveryMetadata
      });
      if (expired()) return native("timeout");
      return { page, ranking: { method: "provider", candidateCount: pool.hits.length } };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (interrupt) context.signal?.removeEventListener("abort", interrupt);
    }
  };
}
