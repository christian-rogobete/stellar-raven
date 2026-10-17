import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { getCatalog } from "../src/catalog/load.ts";
import { searchCatalogPage } from "../src/catalog/search.ts";
import {
  createRankedSearchResolver, createRankingCallBudget,
  type CatalogPageResolver, type SearchRankingProvider
} from "../src/catalog/search-ranking.ts";
import { buildSandbox } from "../src/executor/providers.ts";
import type { ExecuteOutcome } from "../src/executor/run.ts";
import { registerTools, SEARCH_DESCRIPTION, EXECUTE_DESCRIPTION } from "../src/mcp/tools.ts";
import { staticSkillSource } from "./helpers/skill-source.ts";
import { createJevRankingBudget, createJevRankingProvider, JEV_MODEL,
  JEV_RESERVED_INPUT_TOKENS, JEV_RESERVED_NANO_USD } from "../src/adapters/jev-ranking.ts";

const catalog = getCatalog();
const query = "soroban contract storage";
const pool = searchCatalogPage(catalog, { query, limit: 50 });
const reversed = [...pool.hits].reverse();
const reverse: SearchRankingProvider = async ({ candidates }) =>
  candidates.map((hit, i) => ({ id: hit.id, score: (i + 1) / candidates.length }));
const closers: (() => Promise<void>)[] = [];

function resolver(provider: SearchRankingProvider = reverse, calls = 10, timeoutMs = 500) {
  return createRankedSearchResolver({ provider, budget: createRankingCallBudget(calls), timeoutMs });
}

async function mcp(searchResolver?: CatalogPageResolver, extra = {}) {
  const server = new McpServer({ name: "ranking-adapter", version: "0.0.0" });
  registerTools(server, { ...extra, searchResolver });
  const client = new Client({ name: "ranking-adapter-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  closers.push(async () => { await Promise.all([client.close(), server.close()]); });
  return client;
}

function sandbox(searchResolver?: CatalogPageResolver, searchSignal?: AbortSignal) {
  const providers = buildSandbox(catalog, staticSkillSource({}), {}, { searchResolver, searchSignal });
  const fns = providers.find((p) => p.name === "codemode")!.fns;
  if (!fns.search) throw new Error("test requires sandbox search");
  return { ...fns, search: fns.search };
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

describe("optional host ranking at real search adapters", () => {
  it.each(["configuration", "http-auth", "http-rate-limit", "http-error", "model", "response", "transport"] as const)(
    "keeps Jev %s diagnostics host-only across MCP and sandbox", async code => {
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      const makeProvider = () => {
        const ledger = createJevRankingBudget({ maxAttempts: 2,
          maxReservedInputTokens: 2 * JEV_RESERVED_INPUT_TOKENS, maxReservedNanoUsd: 2 * JEV_RESERVED_NANO_USD });
        return createJevRankingProvider({ apiKey: code === "configuration" ? "" : "synthetic-test-key",
          approval: ledger.approveRequest({ approved: true, maxAttempts: 2,
            signal: new AbortController().signal, expiresInMs: 60_000 }), timeoutMs: 1000,
          fetchImpl: async () => {
            if (code === "transport") throw new Error("private-transport-detail");
            const status = code === "http-auth" ? 401 : code === "http-rate-limit" ? 429 : code === "http-error" ? 503 : 200;
            return new Response(JSON.stringify({ model: code === "model" ? "foreign-model" : JEV_MODEL,
              usage: { input_tokens: 100, output_tokens: 1 }, answers: "private-invalid-response" }),
            { status, headers: { "Content-Type": "application/json" } });
          }
        });
      };
      const ranked = await mcp(resolver(makeProvider()));
      const native = await mcp();
      const request = { name: "search", arguments: { query, limit: 5 } };
      expect(await ranked.callTool(request)).toEqual(await native.callTool(request));
      const event = logs.mock.calls.map(([value]) => JSON.parse(String(value))).find(row => row.rankingReason);
      expect(event).toMatchObject({ rankingMethod: "native", rankingReason: "provider-error", rankingErrorCode: code });
      logs.mockClear();
      expect(await sandbox(resolver(makeProvider())).search({ query, limit: 5 }))
        .toEqual(await sandbox().search({ query, limit: 5 }));
      const sandboxEvent = logs.mock.calls.map(([value]) => JSON.parse(String(value))).find(row => row.rankingReason);
      expect(sandboxEvent).toMatchObject({ source: "codemode", rankingErrorCode: code });
      expect(JSON.stringify([event, sandboxEvent])).not.toMatch(/private-|synthetic-test-key|foreign-model/);
    }
  );

  it("returns provider order through MCP with identical text/structured content and final telemetry", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const client = await mcp(resolver());
    const result = await client.callTool({ name: "search", arguments: { query, limit: 5 } });
    const body = result.structuredContent as Record<string, any>;
    expect(result.isError).toBeFalsy();
    expect(body.hits).toEqual(reversed.slice(0, 5));
    expect(body.ranking).toEqual({ method: "provider", candidateCount: pool.hits.length });
    expect(result.content?.[0]).toEqual({ type: "text", text: JSON.stringify(body) });
    expect(body.nextSteps).toContain("not model certainty");
    expect(body.nextSteps).not.toContain("gated hits rank first");
    const event = logs.mock.calls.map(([value]) => JSON.parse(String(value))).find((row) => row.source === "tool");
    expect(event.top).toEqual(reversed.slice(0, 3).map((hit) => hit.id));
    expect(event.gatedHits).toBe(body.hits.filter((hit: any) => hit.tier === "gated").length);
    expect(event.omittedCount).toBe(body.total - body.hits.length);
    expect(event).toMatchObject({ rankingMethod: "provider", rankingCandidateCount: pool.hits.length });
    expect(event).not.toHaveProperty("rankingReason");
    const { tools } = await client.listTools();
    const search = tools.find((tool) => tool.name === "search")!;
    expect(search.description).toContain("Search with optional host ranking");
    expect(search.description).toContain('When ranking.method is "provider"');
    expect(search.description).not.toContain("gated hits lead except");
    expect(JSON.stringify(search.outputSchema)).toContain("not the final sort key");
    expect(JSON.stringify(search.outputSchema)).toContain("Operation hits include a rendered TypeScript signature you can call from `execute`.");
    expect(tools.find((tool) => tool.name === "execute")?.description).toContain("Optional host ranking");
  });

  it.each(["invalid", "failure", "timeout"])("keeps complete native MCP bytes after %s and adds no ranking field", async (mode) => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const provider: SearchRankingProvider = mode === "invalid" ? async () => []
      : mode === "failure" ? async () => { throw new Error("private-provider-error"); }
      : async () => new Promise(() => {});
    const native = await mcp();
    const ranked = await mcp(resolver(provider, 1, 10));
    const request = { name: "search", arguments: { query, limit: 5 } };
    const expected = await native.callTool(request);
    expect(await ranked.callTool(request)).toEqual(expected);
    expect(await ranked.callTool(request)).toEqual(expected); // exhausted budget
    const events = logs.mock.calls.map(([value]) => JSON.parse(String(value))).filter(row => row.source === "tool");
    expect(events).toHaveLength(3);
    expect(events[0]).not.toHaveProperty("rankingMethod");
    expect(events[1]).toMatchObject({ rankingMethod: "native", rankingReason:
      mode === "invalid" ? "invalid-response" : mode === "failure" ? "provider-error" : "timeout" });
    expect(events[2]).toMatchObject({ rankingMethod: "native", rankingReason: "budget" });
    expect(events[1]).not.toHaveProperty("rankingCandidateCount");
    expect(JSON.stringify(events)).not.toContain("private-provider-error");
    expect(JSON.stringify(events)).not.toContain(query);
    const descriptions = (await native.listTools()).tools;
    expect(descriptions.find((tool) => tool.name === "search")?.description).toBe(SEARCH_DESCRIPTION);
    expect(descriptions.find((tool) => tool.name === "execute")?.description).toBe(EXECUTE_DESCRIPTION);
  });

  it("shares one attempt budget between concurrent MCP and sandbox calls without exposing the hook", async () => {
    const provider = vi.fn(reverse);
    const shared = resolver(provider, 1);
    const client = await mcp(shared);
    const fns = sandbox(shared);
    const [a, b] = await Promise.all([
      client.callTool({ name: "search", arguments: { query, limit: 5 } }),
      fns.search({ query, limit: 5 })
    ]);
    expect(provider).toHaveBeenCalledTimes(1);
    const bodies = [a.structuredContent, b] as Record<string, any>[];
    expect(bodies.filter((body) => body.ranking?.method === "provider")).toHaveLength(1);
    expect(bodies.find((body) => !body.ranking)?.hits).toEqual(searchCatalogPage(catalog, { query, limit: 5 }).hits);
    expect(Object.keys(fns)).not.toContain("searchResolver");
    expect(Object.keys(fns)).not.toContain("searchSignal");
  });

  it("records sandbox provider and budget outcomes while preserving fallback bytes", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const fns = sandbox(resolver(reverse, 1));
    const first = await fns.search({ query, limit: 5 });
    expect(first).toMatchObject({
      hits: reversed.slice(0, 5), ranking: { method: "provider", candidateCount: pool.hits.length }
    });
    const fallback = await fns.search({ query, limit: 5 });
    expect(fallback).toEqual(await sandbox().search({ query, limit: 5 }));
    const events = logs.mock.calls.map(([value]) => JSON.parse(String(value))).filter(row => row.source === "codemode");
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ rankingMethod: "provider", rankingCandidateCount: pool.hits.length });
    expect(events[1]).toMatchObject({ rankingMethod: "native", rankingReason: "budget" });
    expect(events[2]).not.toHaveProperty("rankingMethod");
    expect(fallback).not.toHaveProperty("rankingReason");
  });

  it("validates sandbox filters and recovery before provider work; abort returns exact native envelope", async () => {
    const provider = vi.fn(reverse);
    const abort = new AbortController();
    const fns = sandbox(resolver(provider), abort.signal);
    expect(await fns.search({ query, service: "unknown" })).toMatchObject({ ok: false });
    expect(await fns.search({ query, recoverFrom: ["not-an-operation"] })).toMatchObject({ ok: false });
    expect(provider).not.toHaveBeenCalled();
    abort.abort();
    expect(await fns.search({ query, limit: 5 })).toEqual(await sandbox().search({ query, limit: 5 }));
    expect(provider).not.toHaveBeenCalled();
  });

  it("propagates MCP client cancellation to the provider", async () => {
    let announce!: () => void;
    let cancelled!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
    const provider: SearchRankingProvider = async (_input, { signal }) => {
      signal.addEventListener("abort", cancelled, { once: true });
      announce();
      return new Promise(() => {});
    };
    const client = await mcp(resolver(provider, 1, 2000));
    const controller = new AbortController();
    const pending = client.callTool({ name: "search", arguments: { query } }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBeDefined();
    await started;
    controller.abort();
    // Provider's 2s own deadline must not make a missing client-abort bridge pass.
    let timer: ReturnType<typeof setTimeout>;
    try {
      expect(await Promise.race([
        aborted.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 500); })
      ])).toBe(true);
      await rejected;
    } finally {
      clearTimeout(timer!);
    }
  });

  it("passes the same resolver and request signal into MCP execute without losing owner context", async () => {
    const shared = resolver();
    const runExecute = vi.fn(async () => ({
      ok: false, error: "test stub", logs: [],
      operationSummary: { total: 0, ok: 0, error: 0, softEmpty: 0 },
      evidenceSummary: { kind: "none", skillRead: false, skillRuns: 0, artifactReads: 0 }
    } as ExecuteOutcome));
    const client = await mcp(shared, { runExecute, executeContext: () => ({ artifactOwner: "owner-test" }) });
    await client.callTool({ name: "execute", arguments: { code: "async () => 1" } });
    expect(runExecute).toHaveBeenCalledWith("async () => 1", expect.objectContaining({
      artifactOwner: "owner-test", searchResolver: shared, searchSignal: expect.any(AbortSignal)
    }));
  });

  it("preserves host cancellation as well as MCP cancellation for execute", async () => {
    const provider = vi.fn(reverse);
    const shared = resolver(provider);
    const host = new AbortController();
    host.abort();
    let observedSignal: AbortSignal | undefined;
    const runExecute = vi.fn(async (_code: string, context: import("../src/executor/run.ts").ExecuteCallContext = {}) => {
      observedSignal = context.searchSignal;
      const result = await context.searchResolver!(catalog, { query }, { signal: context.searchSignal });
      expect(result.ranking).toEqual({ method: "native", reason: "aborted" });
      return {
        ok: false, error: "test stub", logs: [],
        operationSummary: { total: 0, ok: 0, error: 0, softEmpty: 0 },
        evidenceSummary: { kind: "none", skillRead: false, skillRuns: 0, artifactReads: 0 }
      } as ExecuteOutcome;
    });
    const client = await mcp(shared, { runExecute, executeContext: () => ({ searchSignal: host.signal }) });
    await client.callTool({ name: "execute", arguments: { code: "async () => 1" } });
    expect(runExecute).toHaveBeenCalledTimes(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(provider).not.toHaveBeenCalled();
  });
});
