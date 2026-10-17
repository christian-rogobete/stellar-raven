import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadManifest, searchCatalogPage } from "../src/catalog/search.ts";
import { createRankedSearchResolver, createRankingCallBudget } from "../src/catalog/search-ranking.ts";
import { createJevRankingBudget, createJevRankingProvider, JEV_RESERVED_INPUT_TOKENS,
  JEV_RESERVED_NANO_USD } from "../src/adapters/jev-ranking.ts";
import type { FetchLike } from "../src/adapters/types.ts";

/** Run one explicitly approved search with at most one paid provider request. */
export async function runRankedSearch(args: string[], apiKey?: string, transport: FetchLike = fetch) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: { "allow-paid-ranking": { type: "boolean", default: false } } });
  if (!values["allow-paid-ranking"]) throw new Error("Pass --allow-paid-ranking to approve this paid request.");
  if (positionals.length !== 1 || !positionals[0]?.trim()) throw new Error("Provide one nonempty search query.");
  if (!apiKey) throw new Error("Set JEV_API_KEY in the process environment.");
  const catalogPath = fileURLToPath(new URL("../catalog/manifest.json", import.meta.url).href);
  const catalog = loadManifest(JSON.parse(readFileSync(catalogPath, "utf8")));
  const query = positionals[0], signal = new AbortController().signal;
  const budget = createJevRankingBudget({ maxAttempts: 1, maxReservedInputTokens: JEV_RESERVED_INPUT_TOKENS,
    maxReservedNanoUsd: JEV_RESERVED_NANO_USD });
  const approval = budget.approveRequest({ approved: values["allow-paid-ranking"], maxAttempts: 1,
    signal, expiresInMs: 10_000 });
  const resolver = createRankedSearchResolver({
    provider: createJevRankingProvider({ apiKey, approval, timeoutMs: 2000, fetchImpl: transport }),
    budget: createRankingCallBudget(1), timeoutMs: 2000
  });
  const native = searchCatalogPage(catalog, { query, limit: 5 });
  const ranked = await resolver(catalog, { query, limit: 5 }, { signal });
  return { native: native.hits.map(hit => hit.id), selected: ranked.page.hits.map(hit => hit.id),
    ranking: ranked.ranking, budget: budget.snapshot() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRankedSearch(process.argv.slice(2), process.env.JEV_API_KEY).then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    console.error(error instanceof Error ? error.message : "Search example failed.");
    process.exitCode = 1;
  });
}
