import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { createJevRankingBudget, createJevRankingProvider, JEV_MODEL, JEV_RESERVED_INPUT_TOKENS,
  JEV_RESERVED_NANO_USD } from "../../src/adapters/jev-ranking";
import { createRankedSearchResolver, createRankingCallBudget } from "../../src/catalog/search-ranking";
import { getCatalog } from "../../src/catalog/load";
import { searchCatalogPage } from "../../src/catalog/search";
import { createExecuteRunner } from "../../src/executor/run";
import { JEV_REDIRECT_COUNTS_URL } from "./jev-fixture";

function defaultTransport() {
  const ledger = createJevRankingBudget({ maxAttempts: 1,
    maxReservedInputTokens: JEV_RESERVED_INPUT_TOKENS, maxReservedNanoUsd: JEV_RESERVED_NANO_USD });
  const approval = ledger.approveRequest({ approved: true, maxAttempts: 1,
    signal: new AbortController().signal, expiresInMs: 60_000 });
  return { ledger, provider: createJevRankingProvider({ apiKey: "synthetic-test-key", approval, timeoutMs: 2000 }) };
}

const transportCandidates = [
  { id: "b.read", service: "docs", kind: "operation" as const, description: "Read public documentation." },
  { id: "a.guide", service: "docs", kind: "skill" as const, description: "A documentation guide." }
];

it("uses the real Worker fetch to read a local Jev response", async () => {
  const { provider, ledger } = defaultTransport();
  const result = await provider({ query: "smoke-jev:success", candidates: transportCandidates },
    { signal: new AbortController().signal });
  expect(result).toEqual([{ id: "b.read", score: 0.2 }, { id: "a.guide", score: 0.1 }]);
  expect(ledger.snapshot()).toMatchObject({ attempts: 1, knownUsageAttempts: 1, reportedInputTokens: 100 });
});

it.each([301, 302, 303, 307, 308])("rejects HTTP %i without fetching the redirect target", async status => {
  await fetch(JEV_REDIRECT_COUNTS_URL, { method: "DELETE" });
  const { provider, ledger } = defaultTransport();
  await expect(provider({ query: `smoke-jev:${status}`, candidates: transportCandidates },
    { signal: new AbortController().signal })).rejects.toMatchObject({ code: "http-error" });
  expect(await (await fetch(JEV_REDIRECT_COUNTS_URL)).json()).toEqual({});
  expect(ledger.snapshot()).toMatchObject({ attempts: 1, knownUsageAttempts: 0, unknownUsageAttempts: 1 });
});

it("runs the Jev transport adapter on the Worker host and falls back after its shared grant is spent", async () => {
  const catalog = getCatalog(), query = "soroban contract storage";
  const pool = searchCatalogPage(catalog, { query, limit: 50 });
  const ledger = createJevRankingBudget({ maxAttempts: 1,
    maxReservedInputTokens: JEV_RESERVED_INPUT_TOKENS, maxReservedNanoUsd: JEV_RESERVED_NANO_USD });
  const approval = ledger.approveRequest({ approved: true, maxAttempts: 1,
    signal: new AbortController().signal, expiresInMs: 60_000 });
  let calls = 0;
  const provider = createJevRankingProvider({ apiKey: "synthetic-test-key", approval, timeoutMs: 2000,
    fetchImpl: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body.questions.tool.criteria).sort()).toEqual(pool.hits.map(h => h.id).sort());
      return new Response(JSON.stringify({ model: JEV_MODEL, answers: { tool: { type: "choice",
        probabilities: Object.fromEntries(pool.hits.map((h, i) => [h.id, (i + 1) / pool.hits.length])),
        choice: pool.hits.at(-1)!.id, confidence: 0.73 } }, usage: { input_tokens: 100, output_tokens: 20 }
      }), { headers: { "Content-Type": "application/json" } });
    } });
  const resolver = createRankedSearchResolver({ provider, budget: createRankingCallBudget(3), timeoutMs: 2000 });
  const run = createExecuteRunner(env as unknown as Env);
  const code = `async () => { const page = await codemode.search({ query: ${JSON.stringify(query)}, limit: 5 });
    return { ids: page.hits.map(h => h.id), ranking: page.ranking ?? null }; }`;
  const decode = (text: string) => JSON.parse(text.split("\n\n--- host evidence summary ---")[0]!);
  const first = await run(code, { searchResolver: resolver });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(first.error);
  expect(decode(first.result)).toEqual({ ids: [...pool.hits].reverse().slice(0, 5).map(h => h.id),
    ranking: { method: "provider", candidateCount: pool.hits.length } });
  const second = await run(code, { searchResolver: resolver });
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error(second.error);
  expect(decode(second.result)).toEqual({ ids: searchCatalogPage(catalog, { query, limit: 5 }).hits.map(h => h.id), ranking: null });
  expect(calls).toBe(1);
  expect(ledger.snapshot()).toMatchObject({ attempts: 1, knownUsageAttempts: 1, unknownCostAttempts: 0 });
});
