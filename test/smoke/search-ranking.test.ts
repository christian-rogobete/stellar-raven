import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCatalog } from "../../src/catalog/load";
import { searchCatalogPage } from "../../src/catalog/search";
import {
  createRankedSearchResolver, createRankingCallBudget, RankingProviderError,
  type SearchRankingProvider
} from "../../src/catalog/search-ranking";
import { createExecuteRunner } from "../../src/executor/run";
import { buildDemoTools } from "../../src/demo/tools";
import { createDemoToolBudget } from "../../src/demo/budget";

const query = "soroban contract storage";
const catalog = getCatalog();
const pool = searchCatalogPage(catalog, { query, limit: 50 });
const reversed = [...pool.hits].reverse();
const reverse: SearchRankingProvider = async ({ candidates }) =>
  candidates.map((hit, i) => ({ id: hit.id, score: (i + 1) / candidates.length }));

function ranked(provider = reverse, calls = 10) {
  return createRankedSearchResolver({ provider, budget: createRankingCallBudget(calls), timeoutMs: 1000 });
}

// Small projections stay below the real model-boundary cap. Discovery alone
// has no source metadata; the Playground additionally appends its evidence note.
function jsonResult(text: string) {
  return JSON.parse(text.split("\n--- SOURCE METADATA ---")[0]!.split("\n\n--- host evidence summary ---")[0]!);
}
const code = `async () => {
  const page = await codemode.search({ query: ${JSON.stringify(query)}, limit: 5 });
  const unavailable = [];
  for (const name of ["searchResolver", "searchSignal"]) {
    try { await codemode[name](); unavailable.push(false); }
    catch (error) { unavailable.push(true); }
  }
  return { ids: page.hits.map(h => h.id), ranking: page.ranking ?? null,
    unavailable };
}`;
type Callable = { execute: (args: any, context?: any) => Promise<any> };
const callable = (tools: Record<string, unknown>, name: string) => tools[name] as Callable;

afterEach(() => vi.restoreAllMocks());

describe("host ranking through the real Worker boundary", () => {
  it("keeps Playground error categories in host logs and returns the complete native response", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const provider: SearchRankingProvider = async () => { throw new RankingProviderError("http-auth"); };
    const opts = { env: env as unknown as Env, emit: () => {} };
    const rankedTools = buildDemoTools({ ...opts, searchResolver: ranked(provider) });
    const nativeTools = buildDemoTools(opts);
    expect(await callable(rankedTools.tools, "search").execute({ query }))
      .toEqual(await callable(nativeTools.tools, "search").execute({ query }));
    const event = logs.mock.calls.map(([value]) => JSON.parse(String(value))).find(row => row.rankingReason);
    expect(event).toMatchObject({ evt: "demo-search", rankingReason: "provider-error", rankingErrorCode: "http-auth" });
  });

  it("passes request context into a real sandbox without retaining it for the next execute", async () => {
    const run = createExecuteRunner(env as unknown as Env);
    const provider = vi.fn(reverse);
    const resolver = ranked(provider, 1);
    const first = await run(code, { searchResolver: resolver });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    expect(jsonResult(first.result)).toEqual({
      ids: reversed.slice(0, 5).map((hit) => hit.id),
      ranking: { method: "provider", candidateCount: pool.hits.length },
      unavailable: [true, true]
    });
    const nativeIds = searchCatalogPage(catalog, { query, limit: 5 }).hits.map((hit) => hit.id);
    for (const context of [undefined, { searchResolver: resolver }]) {
      const next = await run(code, context);
      expect(next.ok).toBe(true);
      if (!next.ok) throw new Error(next.error);
      expect(jsonResult(next.result)).toMatchObject({ ids: nativeIds, ranking: null });
    }
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("keeps Playground default 5 and cap 6, final telemetry, and a shared budget across model attempts and execute", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const provider = vi.fn(reverse);
    const resolver = ranked(provider, 2);
    const budget = createDemoToolBudget();
    const opts = { env: env as unknown as Env, emit: () => {}, budget, searchResolver: resolver };
    const first = buildDemoTools(opts);
    const a = await callable(first.tools, "search").execute({ query });
    expect(a.hits.map((hit: any) => hit.id)).toEqual(reversed.slice(0, 5).map((hit) => hit.id));
    expect(a.ranking).toEqual({ method: "provider", candidateCount: pool.hits.length });
    expect(a.nextSteps).toContain("not model certainty");
    expect(a.nextSteps).not.toContain("gated hits lead except");
    // Rebuilding tools for another model attempt must not recreate the provider budget.
    const second = buildDemoTools(opts);
    const b = await callable(second.tools, "search").execute({ query, limit: 50 });
    expect(b.hits.map((hit: any) => hit.id)).toEqual(reversed.slice(0, 6).map((hit) => hit.id));
    expect(second.budgetReport().searchCalls).toBe(2);
    const executed = await callable(second.tools, "execute").execute({ code });
    expect(typeof executed).toBe("string");
    expect(jsonResult(executed)).toMatchObject({
      ids: searchCatalogPage(catalog, { query, limit: 5 }).hits.map((hit) => hit.id), ranking: null
    });
    expect(provider).toHaveBeenCalledTimes(2);
    const events = logs.mock.calls.map(([text]) => JSON.parse(String(text))).filter((row) => row.evt === "demo-search");
    expect(events[1].top).toEqual(b.hits.slice(0, 3).map((hit: any) => hit.id));
    expect(events[1].effectiveLimit).toBe(6);
    expect(events[1].gatedHits).toBe(b.hits.filter((hit: any) => hit.tier === "gated").length);
    expect(events[1]).toMatchObject({ rankingMethod: "provider", rankingCandidateCount: pool.hits.length });
    const sandboxEvent = logs.mock.calls.map(([text]) => JSON.parse(String(text))).find(row => row.source === "codemode");
    expect(sandboxEvent).toMatchObject({ rankingMethod: "native", rankingReason: "budget" });
  });

  it("does not leak resolver state through the cached Playground runner and propagates turn abort", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const provider = vi.fn(reverse);
    const aborted = new AbortController();
    aborted.abort();
    const stopped = buildDemoTools({
      env: env as unknown as Env, emit: () => {}, searchResolver: ranked(provider), searchSignal: aborted.signal
    });
    const native = buildDemoTools({ env: env as unknown as Env, emit: () => {} });
    expect(await callable(stopped.tools, "search").execute({ query }))
      .toEqual(await callable(native.tools, "search").execute({ query }));
    const stoppedRun = await callable(stopped.tools, "execute").execute({ code });
    expect(jsonResult(stoppedRun).ranking).toBeNull();
    expect(provider).not.toHaveBeenCalled();
    const fresh = buildDemoTools({ env: env as unknown as Env, emit: () => {}, searchResolver: ranked(provider) });
    const freshRun = await callable(fresh.tools, "execute").execute({ code });
    expect(jsonResult(freshRun).ranking?.method).toBe("provider");
    const plainRun = await callable(native.tools, "execute").execute({ code });
    expect(jsonResult(plainRun).ranking).toBeNull();
    expect(provider).toHaveBeenCalledTimes(1);
    const events = logs.mock.calls.map(([text]) => JSON.parse(String(text))).filter(row => row.evt === "demo-search");
    expect(events[0]).toMatchObject({ rankingMethod: "native", rankingReason: "aborted" });
    expect(events[1]).not.toHaveProperty("rankingMethod");
  });

  it.each([
    { tool: "search", host: false }, { tool: "search", host: true },
    { tool: "execute", host: false }, { tool: "execute", host: true }
  ])("honors the SDK call abort for $tool with host signal $host", async ({ tool, host }) => {
    const provider = vi.fn(reverse);
    const caller = new AbortController();
    caller.abort();
    const { tools } = buildDemoTools({
      env: env as unknown as Env, emit: () => {}, searchResolver: ranked(provider),
      searchSignal: host ? new AbortController().signal : undefined
    });
    const result = await callable(tools, tool).execute(tool === "search" ? { query } : { code }, { abortSignal: caller.signal });
    if (tool === "search") expect(result.ranking).toBeUndefined();
    else expect(jsonResult(result).ranking).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });
});
