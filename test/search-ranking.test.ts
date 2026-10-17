import { afterEach, describe, expect, it, vi } from "vitest";
import { getCatalog } from "../src/catalog/load.ts";
import { prepareCatalogSearch } from "../src/catalog/search-resolution.ts";
import { searchCatalogPage, type SearchOptions } from "../src/catalog/search.ts";
import {
  createRankedSearchResolver,
  createRankingCallBudget,
  RankingProviderError,
  type RankingProviderErrorCode,
  type RankingInput,
  type SearchRankingProvider
} from "../src/catalog/search-ranking.ts";

const catalog = getCatalog();
const request = { query: "stellar soroban contract", limit: 10 };
const native = () => searchCatalogPage(catalog, request);
const descending = (input: RankingInput) => input.candidates.map((hit, index) => ({
  id: hit.id, score: (index + 1) / input.candidates.length
}));
const resolver = (provider?: SearchRankingProvider, calls = 1, timeoutMs = 100) =>
  createRankedSearchResolver({ provider, budget: createRankingCallBudget(calls), timeoutMs });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("opt-in host catalog ranking", () => {
  it("keeps the entire native page when disabled", async () => {
    const result = await resolver()(catalog, request);
    expect(result).toEqual({ page: native(), ranking: { method: "native", reason: "disabled" } });
  });

  it("selects bounded original hits and recomputes facts for the visible page", async () => {
    const pool = searchCatalogPage(catalog, { ...request, limit: 50 });
    const provider = vi.fn(async (input: RankingInput) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.candidates)).toBe(true);
      for (const candidate of input.candidates) {
        expect(Object.isFrozen(candidate)).toBe(true);
        expect(Object.keys(candidate)).toEqual(["id", "service", "kind", "description"]);
      }
      return descending(input);
    });
    const result = await resolver(provider)(catalog, request);
    expect(result.ranking).toEqual({ method: "provider", candidateCount: pool.hits.length });
    expect(result.page.hits).toEqual([...pool.hits].reverse().slice(0, 10));
    expect(result.page.effectiveLimit).toBe(10);
    expect(result.page.total).toBe(pool.total);
    expect(result.page.truncated).toBe(pool.total > 10);
    expect(result.page.confidence).toEqual({
      hitCount: 10,
      topScoreGap: Math.abs(result.page.hits[0]!.score - result.page.hits[1]!.score),
      topScoreTiers: { first: result.page.hits[0]!.tier, second: result.page.hits[1]!.tier }
    });
    expect(result.page.recoveryMetadata).toEqual(pool.recoveryMetadata);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("retains native pool order at ties and accepts rounded sums and zero tails", async () => {
    const pool = searchCatalogPage(catalog, { ...request, limit: 50 });
    for (const sum of [0.99, 1.01]) {
      const result = await resolver(async (input) => input.candidates.map((c, i) => ({
        id: c.id, score: i === 2 || i === 3 ? sum / 2 : 0
      })))(catalog, request);
      expect(result.ranking.method).toBe("provider");
      expect(result.page.hits.map((h) => h.id)).toEqual([
        pool.hits[2]!.id, pool.hits[3]!.id,
        ...pool.hits.filter((_, i) => i !== 2 && i !== 3).slice(0, 8).map((h) => h.id)
      ]);
    }
  });

  it("rebuilds wider advice when only backfill hits become visible", async () => {
    const opts = { ...request, limit: 5 };
    const pool = searchCatalogPage(catalog, { ...opts, limit: 50 });
    expect(pool.widerCandidates).toEqual([]);
    const backfill = new Set(pool.hits.filter(h => h.tier === "backfill").map(h => h.id));
    expect(backfill.size).toBeGreaterThanOrEqual(5);
    const result = await resolver(async (input) => input.candidates.map(c => ({
      id: c.id, score: backfill.has(c.id) ? 0.1 : 0
    })))(catalog, opts);
    expect(result.page.hits).toHaveLength(5);
    expect(result.page.hits.every(h => h.tier === "backfill")).toBe(true);
    expect(result.page.widerCandidates.length).toBeGreaterThan(0);
    expect(result.page.widerCandidates.length).toBeLessThanOrEqual(3);
    expect(result.page.widerCandidates.some(c => c.lane === "research")).toBe(true);
    expect(result.page.total).toBe(pool.total);
  });

  it("does not consume a provider call for empty or single-candidate pools", async () => {
    const provider = vi.fn(async (input: RankingInput) => descending(input));
    const run = resolver(provider);
    for (const entries of [[], [catalog.entries.find(e => e.id === "stellarDocs.search_docs")!]]) {
      const smallCatalog = { ...catalog, entries };
      const result = await run(smallCatalog, request);
      expect(result.page).toEqual(searchCatalogPage(smallCatalog, request));
      expect(result.ranking).toEqual({ method: "native", reason: "insufficient-candidates" });
    }
    expect(provider).not.toHaveBeenCalled();
    expect((await run(catalog, request)).ranking.method).toBe("provider");
  });

  it.each([1, 5, 10, 50, NaN, Infinity, -5, 500])("preserves original limit normalization for %s", async (limit) => {
    const opts = { ...request, limit };
    const result = await resolver(async (input) => descending(input))(catalog, opts);
    const expected = searchCatalogPage(catalog, opts);
    const pool = searchCatalogPage(catalog, { ...opts, limit: 50 });
    expect(result.ranking).toEqual({ method: "provider", candidateCount: pool.hits.length });
    expect(result.page.effectiveLimit).toBe(expected.effectiveLimit);
    expect(result.page.hits).toEqual([...pool.hits].reverse().slice(0, expected.effectiveLimit));
    expect(result.page.confidence.hitCount).toBe(result.page.hits.length);
  });

  it("leaves fractional native limits and exact-ID navigation untouched", async () => {
    const provider = vi.fn(async (input: RankingInput) => descending(input));
    const run = resolver(provider, 3);
    for (const opts of [
      { ...request, limit: 2.5 },
      { query: "scout.searchResearch", service: "stellarDocs" },
      { query: " skills.stellar-dev.dapp " }
    ]) {
      const result = await run(catalog, opts);
      expect(result.page).toEqual(searchCatalogPage(catalog, opts));
      expect(result.ranking).toEqual({ method: "native", reason: "bypass" });
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it("keeps kind/service filters and excludes sections from provider inputs", async () => {
    const provider = vi.fn(async (input: RankingInput) => descending(input));
    const opts: SearchOptions = { query: "project research", service: "scout", kind: "operation", limit: 5 };
    const pool = searchCatalogPage(catalog, { ...opts, limit: 50 });
    const result = await resolver(provider)(catalog, opts);
    expect(provider).toHaveBeenCalledTimes(1);
    const candidates = provider.mock.calls[0]![0].candidates;
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.every((c) => c.service === "scout" && c.kind === "operation")).toBe(true);
    expect(result.ranking).toEqual({ method: "provider", candidateCount: pool.hits.length });
    expect(result.page.hits).toEqual([...pool.hits].reverse().slice(0, 5));
  });

  it.each([
    "missing", "extra", "duplicate", "foreign", "nan", "infinity", "negative", "over-one",
    "boolean", "zero", "null", "dictionary"
  ])("falls back completely on %s scores", async (fault) => {
    const result = await resolver(async (input) => {
      const rows = descending(input);
      if (fault === "missing") return rows.slice(1);
      if (fault === "extra") return [...rows, { id: "extra", score: 0.1 }];
      if (fault === "duplicate") rows[1] = { ...rows[0]! };
      if (fault === "foreign") rows[0]!.id = "unexposed.operation";
      if (fault === "nan") rows[0]!.score = NaN;
      if (fault === "infinity") rows[0]!.score = Infinity;
      if (fault === "negative") rows[0]!.score = -0.1;
      if (fault === "over-one") rows[0]!.score = 1.1;
      if (fault === "boolean") return rows.map((r, i) => i ? r : { id: r.id, score: true });
      if (fault === "zero") return rows.map((r) => ({ ...r, score: 0 }));
      if (fault === "null") return null;
      if (fault === "dictionary") return Object.fromEntries(rows.map((r) => [r.id, r.score]));
      return rows;
    })(catalog, request);
    expect(result).toEqual({ page: native(), ranking: { method: "native", reason: "invalid-response" } });
  });

  it("keeps native pool order when all valid scores are equal", async () => {
    const result = await resolver(async (input) => input.candidates.map((c) => ({ id: c.id, score: 0.1 })))(catalog, request);
    const pool = searchCatalogPage(catalog, { ...request, limit: 50 });
    expect(result.ranking.method).toBe("provider");
    expect(result.page.hits).toEqual(pool.hits.slice(0, 10));
  });

  it("reserves at most the shared call budget across concurrent searches", async () => {
    const provider = vi.fn(async (input: RankingInput) => descending(input));
    const run = resolver(provider, 1);
    const results = await Promise.all([run(catalog, request), run(catalog, request), run(catalog, request)]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.ranking.method)).toEqual(["provider", "native", "native"]);
    expect(results[1]!.page).toEqual(native());
    expect(results[2]!.ranking).toEqual({ method: "native", reason: "budget" });
  });

  it("does not refund a failed provider attempt or expose its error", async () => {
    const provider = vi.fn(async () => { throw new Error("provider-private-error"); });
    const run = resolver(provider);
    expect(await run(catalog, request)).toEqual({ page: native(), ranking: { method: "native", reason: "provider-error" } });
    expect((await run(catalog, request)).ranking).toEqual({ method: "native", reason: "budget" });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("returns the full fallback on timeout even when provider ignores AbortSignal", async () => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    let signal!: AbortSignal;
    const provider: SearchRankingProvider = (_, context) => {
      signal = context.signal;
      return new Promise((resolve) => { release = resolve; });
    };
    const pending = resolver(provider, 1, 20)(catalog, request);
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result).toEqual({ page: native(), ranking: { method: "native", reason: "timeout" } });
    expect(signal.aborted).toBe(true);
    release([]);
    await Promise.resolve();
    expect(result.page).toEqual(native());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels waiting on caller abort and skips already aborted callers", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let providerSignal!: AbortSignal;
    const provider = vi.fn((_: RankingInput, ctx: { signal: AbortSignal }) => {
      providerSignal = ctx.signal;
      return new Promise(() => {});
    });
    const run = resolver(provider, 2);
    const pending = run(catalog, request, { signal: controller.signal });
    const settled = vi.fn();
    void pending.then(settled);
    await Promise.resolve();
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledTimes(1);
    expect((await pending).ranking).toEqual({ method: "native", reason: "aborted" });
    expect(providerSignal.aborted).toBe(true);
    expect((await run(catalog, request, { signal: controller.signal })).page).toEqual(native());
    expect(provider).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips a scheduled provider when the caller aborts before its start", async () => {
    const caller = new AbortController(), provider = vi.fn(async () => []);
    const pending = resolver(provider)(catalog, request, { signal: caller.signal });
    caller.abort();
    expect(await pending).toEqual({ page: native(), ranking: { method: "native", reason: "aborted" } });
    expect(provider).not.toHaveBeenCalled();
  });

  it("skips the provider when budget reservation aborts the caller", async () => {
    vi.useFakeTimers();
    const caller = new AbortController(), provider = vi.fn(async () => []);
    const tryReserve = vi.fn(() => { caller.abort(); return true; });
    const run = createRankedSearchResolver({ provider, budget: { tryReserve }, timeoutMs: 100 });
    expect(await run(catalog, request, { signal: caller.signal })).toEqual({
      page: native(), ranking: { method: "native", reason: "aborted" }
    });
    expect(tryReserve).toHaveBeenCalledTimes(1);
    expect(provider).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains only typed host error categories", async () => {
    const coded = new RankingProviderError("configuration");
    const result = await resolver(async () => { throw coded; })(catalog, request);
    expect(result).toEqual({ page: native(), ranking: {
      method: "native", reason: "provider-error", errorCode: "configuration"
    } });
    const foreign = Object.assign(new Error("private-error"), { code: "configuration" });
    expect((await resolver(async () => { throw foreign; })(catalog, request)).ranking)
      .toEqual({ method: "native", reason: "provider-error" });
  });

  it("replaces an unrecognized adapter error code with a fixed category", () => {
    const error = new RankingProviderError("private-provider-detail" as RankingProviderErrorCode);
    expect(error.code).toBe("unknown");
    expect(error.message).toBe("Ranking provider: unknown");
  });

  it("handles late provider rejection after the timeout fallback", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const pending = resolver(() => new Promise((_, fail) => { reject = fail; }), 1, 20)(catalog, request);
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result.ranking).toEqual({ method: "native", reason: "timeout" });
    reject(new Error("late-private-provider-error"));
    await vi.advanceTimersByTimeAsync(1);
    expect(result.page).toEqual(native());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a late synchronous result even before its overdue timer runs", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let signal!: AbortSignal;
    const provider: SearchRankingProvider = async (input, context) => {
      signal = context.signal;
      now = 101;
      return descending(input);
    };
    expect(await resolver(provider, 1, 100)(catalog, request)).toEqual({
      page: native(), ranking: { method: "native", reason: "timeout" }
    });
    expect(signal.aborted).toBe(true);
  });

  it("rejects results when validation reaches the deadline", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const provider: SearchRankingProvider = async (input) => descending(input).map(({ id, score }) => ({
      id,
      get score() { now = 100; return score; }
    }));
    expect(await resolver(provider, 1, 100)(catalog, request)).toEqual({
      page: native(), ranking: { method: "native", reason: "timeout" }
    });
  });

  it.each(["success", "failure", "invalid"])("clears its pending timer after %s", async outcome => {
    vi.useFakeTimers();
    const provider: SearchRankingProvider = async (input) => {
      if (outcome === "failure") throw new Error("test failure");
      return outcome === "invalid" ? [] : descending(input);
    };
    const result = await resolver(provider, 1, 100)(catalog, request);
    expect(result.ranking.method).toBe(outcome === "success" ? "provider" : "native");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the real staged resolver, preserves recovery, and validates before ranking", async () => {
    const provider = vi.fn(async (input: RankingInput) => descending(input));
    const ranked = resolver(provider, 2);
    expect(prepareCatalogSearch(catalog, "not-a-service", ranked).ok).toBe(false);
    const prepared = prepareCatalogSearch(catalog, undefined, ranked);
    if (!prepared.ok) throw new Error("unexpected service failure");
    expect(prepared.checkRecoveryIds(["unknown.id"]).ok).toBe(false);
    expect(provider).not.toHaveBeenCalled();
    const stage = prepared.checkRecoveryIds(["scout.searchProjects"]);
    const nativeStage = prepareCatalogSearch(catalog, undefined);
    if (!stage.ok || !nativeStage.ok) throw new Error("unexpected recovery failure");
    const originalStage = nativeStage.checkRecoveryIds(["scout.searchProjects"]);
    if (!originalStage.ok) throw new Error("unexpected recovery failure");
    const result = await stage.resolve({ ...request, reason: "weak" });
    const original = await originalStage.resolve({ ...request, reason: "weak" });
    expect(result.ranking?.method).toBe("provider");
    expect(result.recovery).toEqual(original.recovery);
    expect(result.page.hits).not.toEqual(original.page.hits);
  });
});
