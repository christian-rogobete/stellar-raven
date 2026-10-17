# Optional tool ranking

Raven accepts a host-supplied ranking provider for tool discovery. The resolver gathers up to
50 candidates from Raven search, asks the provider to order them, and returns the requested page size.
Service and kind filters still apply. A query that equals a catalog ID returns Raven's original page without a provider call.
A provider can promote a candidate outside the original visible page, but cannot recover a tool absent from the candidate pool.

The supplied Jev adapter uses `jev-1.14.0`. The normal server and Playground do not configure it.
Setting an API key alone does not activate ranking. A custom host must pass a resolver to its tools
and supply request approval, cancellation, and spending controls.

## Try one approved search

[The command-line example](../examples/jev-search.ts) runs one search against the committed catalog.
It requires Node 24, dependencies installed with `npm ci`, and a TypeSafe API key in the `JEV_API_KEY` process environment.
The flag authorizes sending this query and tool descriptions to TypeSafe and paying for at most one request.

```sh
node examples/jev-search.ts --allow-paid-ranking "verify a groth16 proof inside a soroban contract"
```

The example prints original and selected tool IDs, the ranking decision, and the budget snapshot.
It executes no discovered tools and contacts no source APIs. Invalid arguments or a missing key fail before provider dispatch.
An exact ID or a pool with fewer than two candidates needs no provider call.
Provider failure returns the original page and an operator diagnostic. A successful CLI exit therefore does not imply Jev ordered the results;
check that `ranking.method` is `provider` before treating the selected IDs as a provider result.

Each invocation allows one attempt, with a two-second deadline and no retry. Failed attempts retain their reserve.
The example creates a fresh budget for that invocation. Repeating the command can incur another charge.
The adapter's dated tariff reserves 65,536 input tokens and 0.002752512 USD per attempt.
Verify the [model, context limits, and price](https://docs.typesafe.ai/models) before enabling paid use or changing the model.
The adapter does not enable long context. A reservation is an accounting bound under that tariff, not an API-side spend limit.

## Connect a host

Use the construction in the example with the host's real request signal and approval result:

1. Obtain approval for the actual request before issuing a grant. An operator policy must also authorize its cost.
2. Keep one `createJevRankingBudget` object for the bounded host usage it governs. Call `approveRequest` for the approved request.
3. Pass its grant, the server-side key, and a timeout to `createJevRankingProvider`.
4. Pass the provider and a shared attempt budget to `createRankedSearchResolver`.
5. Pass that resolver as `searchResolver` to `registerTools` for MCP or to `buildDemoTools` for a custom Playground host.
   Playground also accepts `searchSignal`; MCP uses its request signal. Use the same resolver across searches in that request.

MCP and Playground forward the resolver into `execute` discovery. A cached executor receives it through the call context;
the provider, approval, key, and budget stay outside model-authored code.
Unit tests exercise MCP and sandbox search with injected providers. Worker tests cover Playground and real `fetch` against offline fixtures.
Worker tests also cover redirect refusal and request isolation.

The adapter budget is in memory. It does not survive process replacement or coordinate Worker isolates.
A public service must enforce its account-wide spending policy before issuing grants, retain unknown costs,
and provide an operator stop. The adapter's counters do not replace those controls or user consent.
To disable provider ranking, omit the resolver from tool registration. To stop further calls within an active request, abort its signal.

## Results and failures

A successful result includes `ranking.method: "provider"` and the candidate count.
The visible order is authoritative. Raven's `score`, `tier`, and `confidence` fields describe lexical provenance,
not Jev probabilities or provider certainty.
Tied provider scores retain the order of the pool returned by Raven search with limit 50.

Absent configuration, exact-ID bypass, a short pool, an exhausted attempt budget, cancellation,
a timeout, or invalid provider output returns the complete original result page.
Operator traces record a fixed fallback reason and, where available, a fixed provider-error category.
The ordinary model-facing envelope stays unchanged on fallback. The adapter does not log provider payloads or arbitrary error messages.

TypeSafe receives the search query, candidate IDs, services, kinds, short descriptions, and the fixed ranking instruction.
It does not receive retrieved source content, the conversation history, full tool schemas, or source credentials from this adapter.
Search queries can still contain private information supplied by the caller; the host's consent and data policy must cover that transfer.

[Saved comparison evidence](../research/2026-10-17-tool-ranking/README.md) includes the measured gains, known losses, and an offline recalculation.
