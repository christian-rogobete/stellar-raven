import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildJevRankingBody, createJevRankingBudget, createJevRankingProvider,
  JEV_ENDPOINT, JEV_INSTRUCTION, JEV_MODEL, JEV_RESERVED_INPUT_TOKENS, JEV_RESERVED_NANO_USD,
  type JevRankingApproval
} from "../src/adapters/jev-ranking.ts";
import type { FetchLike } from "../src/adapters/types.ts";
import type { RankingInput } from "../src/catalog/search-ranking.ts";
import { createRankedSearchResolver, createRankingCallBudget } from "../src/catalog/search-ranking.ts";
import { getCatalog } from "../src/catalog/load.ts";
import { searchCatalogPage } from "../src/catalog/search.ts";

const input: RankingInput = { query: "Read documentation", candidates: [
  { id: "b.read", service: "b", kind: "operation", description: "Read public documentation." },
  { id: "a.skill", service: "a", kind: "skill", description: "A guide to documentation." }
] };
const key = "local-test-key-never-a-real-credential";
const signal = () => new AbortController().signal;
const budget = (maxAttempts = 4) => createJevRankingBudget({
  maxAttempts, maxReservedInputTokens: maxAttempts * JEV_RESERVED_INPUT_TOKENS,
  maxReservedNanoUsd: maxAttempts * JEV_RESERVED_NANO_USD
});
const reply = () => ({ model: JEV_MODEL, answers: { tool: {
  type: "choice", probabilities: { "b.read": 0.8, "a.skill": 0.19 },
  choice: "b.read", confidence: 0.73
} }, usage: { input_tokens: 100, output_tokens: 12 } });
const response = (body: unknown = reply()) => new Response(JSON.stringify(body), {
  headers: { "Content-Type": "application/json; charset=utf-8" }
});
function nestedExtra(depth: number): unknown {
  let value: unknown = 0;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}
function setup(fetchImpl: FetchLike = async () => response(), maxAttempts = 4, timeoutMs = 1000) {
  const ledger = budget(maxAttempts), request = new AbortController();
  const approval = ledger.approveRequest({ approved: true, maxAttempts, signal: request.signal, expiresInMs: 60_000 });
  const provider = createJevRankingProvider({ apiKey: key, approval, timeoutMs, fetchImpl });
  return { ledger, request, approval, provider };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("host-only Jev provider", () => {
  it("renders full short descriptions with stable keys and the existing instruction", () => {
    const body = JSON.parse(buildJevRankingBody(input));
    expect(body).toEqual({ model: JEV_MODEL, state: input.query, questions: { tool: {
      type: "choice", instructions: JEV_INSTRUCTION, criteria: {
        "a.skill": "id: a.skill\nservice: a\nkind: skill\ndescription: A guide to documentation.\n",
        "b.read": "id: b.read\nservice: b\nkind: operation\ndescription: Read public documentation.\n"
      }
    } } });
    expect(Object.keys(body.questions.tool.criteria)).toEqual(["a.skill", "b.read"]);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("keeps rounded probabilities and different choice confidence, with exact transport", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      expect(url).toBe(JEV_ENDPOINT);
      expect(init).toMatchObject({ method: "POST", redirect: "manual" });
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
        authorization: `Bearer ${key}`, "content-type": "application/json"
      });
      expect(init?.body).toBe(buildJevRankingBody(input));
      return response();
    });
    const { provider, ledger } = setup(fetchImpl);
    expect(await provider(input, { signal: signal() })).toEqual([
      { id: "b.read", score: 0.8 }, { id: "a.skill", score: 0.19 }
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot()).toEqual({ attempts: 1, reservedInputTokens: 65536,
      reservedNanoUsd: JEV_RESERVED_NANO_USD, knownUsageAttempts: 1, unknownUsageAttempts: 0,
      knownCostAttempts: 1, unknownCostAttempts: 0,
      reportedInputTokens: 100, reportedOutputTokens: 12, reportedNanoUsd: 4200, blocked: false });
  });

  it("rejects absent, denied and forged approval without a request", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const ledger = budget();
    const denied = ledger.approveRequest({ approved: false, maxAttempts: 4, signal: signal(), expiresInMs: 60_000 });
    for (const approval of [undefined, denied, { approved: true } as JevRankingApproval]) {
      const provider = createJevRankingProvider({ apiKey: key, approval, timeoutMs: 1000, fetchImpl });
      await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "approval" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ledger.snapshot().attempts).toBe(0);
  });

  it.each(["request", "caller"])("does not spend with a pre-aborted %s signal", async which => {
    const fetchImpl = vi.fn<FetchLike>();
    const { provider, request, ledger } = setup(fetchImpl);
    const caller = new AbortController();
    (which === "request" ? request : caller).abort();
    await expect(provider(input, { signal: caller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ledger.snapshot().attempts).toBe(0);
  });

  it("bounds concurrent calls across separate request grants without refunds", async () => {
    const ledger = budget(2), fetchImpl = vi.fn<FetchLike>(async () => response());
    const providers = [1, 2, 3].map(() => createJevRankingProvider({ apiKey: key, timeoutMs: 1000, fetchImpl,
      approval: ledger.approveRequest({ approved: true, maxAttempts: 5, signal: signal(), expiresInMs: 60_000 }) }));
    const results = await Promise.allSettled(providers.flatMap(provider =>
      [1, 2, 3].map(() => provider(input, { signal: signal() }))));
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(ledger.snapshot()).toMatchObject({ attempts: 2, reservedNanoUsd: 2 * JEV_RESERVED_NANO_USD });
  });

  it("enforces each request grant within a larger shared budget", async () => {
    const ledger = budget(5), fetchImpl = vi.fn<FetchLike>(async () => response());
    const approval = ledger.approveRequest({ approved: true, maxAttempts: 1, signal: signal(), expiresInMs: 60_000 });
    const provider = createJevRankingProvider({ apiKey: key, approval, timeoutMs: 1000, fetchImpl });
    await provider(input, { signal: signal() });
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "budget" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("enforces the shared attempt cap with spare token and money reserves", async () => {
    const ledger = createJevRankingBudget({ maxAttempts: 1,
      maxReservedInputTokens: 2 * JEV_RESERVED_INPUT_TOKENS,
      maxReservedNanoUsd: 2 * JEV_RESERVED_NANO_USD });
    const fetchImpl = vi.fn<FetchLike>(async () => response());
    const providers = [1, 2].map(() => createJevRankingProvider({ apiKey: key, timeoutMs: 1000, fetchImpl,
      approval: ledger.approveRequest({ approved: true, maxAttempts: 2, signal: signal(), expiresInMs: 60_000 }) }));
    const results = await Promise.allSettled(providers.map(provider => provider(input, { signal: signal() })));
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { code: "budget" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot()).toMatchObject({ attempts: 1, reservedInputTokens: JEV_RESERVED_INPUT_TOKENS,
      reservedNanoUsd: JEV_RESERVED_NANO_USD });
  });

  it("rechecks grant expiry after constructing the request body", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1);
    const ledger = budget(), fetchImpl = vi.fn<FetchLike>();
    const approval = ledger.approveRequest({ approved: true, maxAttempts: 2, signal: signal(), expiresInMs: 1 });
    const provider = createJevRankingProvider({ apiKey: key, approval, timeoutMs: 1000, fetchImpl });
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "timeout" });
    expect(ledger.snapshot()).toMatchObject({ attempts: 0, reservedInputTokens: 0, reservedNanoUsd: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a successful response if another attempt has blocked the shared ledger", async () => {
    let release!: (value: Response) => void;
    const foreign = reply(); foreign.model = "other-model";
    const fetchImpl = vi.fn<FetchLike>()
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(response(foreign));
    const { provider, ledger } = setup(fetchImpl);
    const pending = expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "budget" });
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "model" });
    release(response());
    await pending;
    expect(ledger.snapshot()).toMatchObject({ attempts: 2, knownUsageAttempts: 2, blocked: true });
  });

  it("expires a grant before spending, even without request cancellation", async () => {
    vi.useFakeTimers();
    const ledger = budget(), fetchImpl = vi.fn<FetchLike>();
    const approval = ledger.approveRequest({ approved: true, maxAttempts: 2, signal: signal(), expiresInMs: 10 });
    const provider = createJevRankingProvider({ apiKey: key, approval, timeoutMs: 1000, fetchImpl });
    await vi.advanceTimersByTimeAsync(11);
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "timeout" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ends an ongoing request at grant expiry even with a longer transport deadline", async () => {
    vi.useFakeTimers();
    const ledger = budget(), fetchImpl = vi.fn<FetchLike>(async () => new Promise(() => {}));
    const approval = ledger.approveRequest({ approved: true, maxAttempts: 2, signal: signal(), expiresInMs: 10 });
    const provider = createJevRankingProvider({ apiKey: key, approval, timeoutMs: 1000, fetchImpl });
    const pending = expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(11);
    await pending;
    expect(ledger.snapshot()).toMatchObject({ attempts: 1, unknownUsageAttempts: 1 });
  });

  it.each(["maxReservedInputTokens", "maxReservedNanoUsd"] as const)("enforces %s before sending", async field => {
    const limits = { maxAttempts: 2, maxReservedInputTokens: 2 * JEV_RESERVED_INPUT_TOKENS,
      maxReservedNanoUsd: 2 * JEV_RESERVED_NANO_USD };
    limits[field] = 1;
    const ledger = createJevRankingBudget(limits), fetchImpl = vi.fn<FetchLike>();
    const provider = createJevRankingProvider({ apiKey: key, timeoutMs: 1000, fetchImpl,
      approval: ledger.approveRequest({ approved: true, maxAttempts: 2, signal: signal(), expiresInMs: 60_000 }) });
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "budget" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, query: "x".repeat(8193) },
    { ...input, query: "\ud800" },
    { ...input, candidates: [input.candidates[0]!] },
    { ...input, candidates: [input.candidates[0]!, input.candidates[0]!] },
    { ...input, candidates: Array.from({ length: 51 }, (_, i) => ({ ...input.candidates[0]!, id: `a.${i}` })) },
    { ...input, candidates: input.candidates.map(c => ({ ...c, description: "x".repeat(40000) })) }
  ])("rejects invalid/oversized input without spending %#", async invalid => {
    const fetchImpl = vi.fn<FetchLike>(), { provider, ledger } = setup(fetchImpl);
    await expect(provider(invalid, { signal: signal() })).rejects.toMatchObject({ code: "input" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ledger.snapshot().attempts).toBe(0);
  });

  it("retains valid non-BMP text rather than splitting characters", () => {
    expect(JSON.parse(buildJevRankingBody({ ...input, query: "Wallet 🔑" })).state).toBe("Wallet 🔑");
  });

  it.each([401, 403, 429, 500, 529, 302])("never retries HTTP %i or reads its error body", async status => {
    const result = new Response(JSON.stringify({ ...reply(), extra: key }), {
      status, headers: { "Content-Type": "application/json", Location: "https://unrelated.invalid" }
    });
    const read = vi.spyOn(result.body!, "getReader");
    const cancel = vi.spyOn(result.body!, "cancel");
    const fetchImpl = vi.fn<FetchLike>(async () => result);
    const { provider, ledger } = setup(fetchImpl);
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: status === 401 || status === 403 ? "http-auth" : status === 429 ? "http-rate-limit" : "http-error" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot()).toMatchObject({ attempts: 1, knownUsageAttempts: 0, unknownUsageAttempts: 1 });
  });

  it.each([
    (x: ReturnType<typeof reply>) => { x.answers.tool.type = "noul"; },
    x => { x.answers.tool.choice = "unknown.id"; },
    x => { x.answers.tool.choice = "a.skill"; },
    x => { x.answers.tool.confidence = -1; },
    x => { x.answers.tool.probabilities["a.skill"] = 2; },
    x => { x.answers.tool.probabilities["a.skill"] = 0; x.answers.tool.probabilities["b.read"] = 0; },
    x => { (x.answers.tool.probabilities as Record<string, unknown>)["a.skill"] = true; },
    x => { delete (x.answers.tool.probabilities as Record<string, unknown>)["a.skill"]; },
    x => { (x.answers.tool.probabilities as Record<string, unknown>)["extra"] = 0.1; }
  ])("rejects invalid semantic response while retaining observed usage %#", async mutate => {
    const body = reply(); mutate(body);
    const { provider, ledger } = setup(async () => response(body));
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "response" });
    expect(ledger.snapshot()).toMatchObject({ knownUsageAttempts: 1, reportedInputTokens: 100 });
  });

  it.each([0, -1, 1.5, NaN, Infinity, "100", null])("rejects unusable input usage %s", async value => {
    const body = reply(); (body.usage as Record<string, unknown>).input_tokens = value;
    const { provider, ledger } = setup(async () => response(body));
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "usage" });
    expect(ledger.snapshot()).toMatchObject({ knownUsageAttempts: 0, unknownUsageAttempts: 1 });
  });

  it("retains observed overrun and blocks further starts across grants", async () => {
    const body = reply(); body.usage.input_tokens = JEV_RESERVED_INPUT_TOKENS + 1;
    const fetchImpl = vi.fn<FetchLike>(async () => response(body));
    const { provider, ledger } = setup(fetchImpl);
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "usage" });
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "budget" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot()).toMatchObject({ blocked: true, reportedInputTokens: 65537, knownUsageAttempts: 1 });
  });

  it("records a foreign model's usage without attributing the requested model's price", async () => {
    const body = reply(); body.model = "other-model";
    const fetchImpl = vi.fn<FetchLike>(async () => response(body));
    const { provider, ledger } = setup(fetchImpl);
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "model" });
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "budget" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot()).toMatchObject({ blocked: true, knownUsageAttempts: 1,
      reportedInputTokens: 100, knownCostAttempts: 0, unknownCostAttempts: 1, reportedNanoUsd: 0 });
  });

  it("rejects a late response by monotonic deadline when its timer cannot run yet", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const cancel = vi.fn();
    const fetchImpl: FetchLike = async () => {
      elapsed = 1001;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(reply())));
      }, cancel }), { headers: { "Content-Type": "application/json" } });
    };
    const { provider, ledger } = setup(fetchImpl);
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "timeout" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot().unknownUsageAttempts).toBe(1);
  });

  it.each([
    JSON.stringify(reply()).replace('{', '{"model":"first",'),
    JSON.stringify(reply()).replace('"a.skill":0.19', '"a.skill":0.1,"\\u0061.skill":0.19'),
    JSON.stringify(reply()).replace('{', '{"extra":[{"name":1,"name":2}],'),
    '\ufeff' + JSON.stringify(reply()),
    JSON.stringify({ ...reply(), extra: nestedExtra(64) })
  ])("rejects ambiguous or excessively nested JSON %#", async raw => {
    const { provider } = setup(async () => new Response(raw, { headers: { "Content-Type": "application/json" } }));
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "response" });
  });

  it("allows repeated object keys in separate objects and JSON punctuation within strings", async () => {
    const body = { ...reply(), extra: [{ name: "escaped quote\"},:[]" }, { name: "second" }] };
    const { provider } = setup(async () => response(body));
    await expect(provider(input, { signal: signal() })).resolves.toHaveLength(2);
  });

  it("accepts nesting at the 64-container boundary", async () => {
    const { provider } = setup(async () => response({ ...reply(), extra: nestedExtra(63) }));
    await expect(provider(input, { signal: signal() })).resolves.toEqual([
      { id: "b.read", score: 0.8 }, { id: "a.skill", score: 0.19 }
    ]);
  });

  it.each([65536, 65537])("enforces the response byte limit at %i bytes", async size => {
    const empty = JSON.stringify({ ...reply(), extra: "" });
    const raw = JSON.stringify({ ...reply(), extra: "x".repeat(size - new TextEncoder().encode(empty).length) });
    expect(new TextEncoder().encode(raw)).toHaveLength(size);
    const { provider } = setup(async () => new Response(raw, { headers: { "Content-Type": "application/json" } }));
    const pending = provider(input, { signal: signal() });
    if (size === 65536) {
      await expect(pending).resolves.toEqual([{ id: "b.read", score: 0.8 }, { id: "a.skill", score: 0.19 }]);
    } else {
      await expect(pending).rejects.toMatchObject({ code: "response" });
    }
  });

  it("rejects invalid UTF-8 within an otherwise valid response string", async () => {
    const raw = JSON.stringify({ ...reply(), extra: "PLACEHOLDER" });
    const [before, after] = raw.split("PLACEHOLDER");
    const encoder = new TextEncoder();
    const bytes = new Uint8Array([...encoder.encode(before), 0xc3, 0x28, ...encoder.encode(after)]);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject(reply());
    const { provider } = setup(async () => new Response(bytes, { headers: { "Content-Type": "application/json" } }));
    await expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "response" });
  });

  it.each(["wrong-type", "redirected"])("rejects %s", async kind => {
    const fetchImpl: FetchLike = async () => {
      if (kind === "wrong-type") return new Response(JSON.stringify(reply()), { headers: { "Content-Type": "text/html" } });
      const result = response(); Object.defineProperty(result, "redirected", { value: true }); return result;
    };
    await expect(setup(fetchImpl).provider(input, { signal: signal() })).rejects.toMatchObject({ code: "response" });
  });

  it.each(["fetch", "body"])("times out a hanging %s even if cancellation is ignored", async phase => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<FetchLike>(async () => phase === "fetch" ? new Promise(() => {}) :
      new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "application/json" } }));
    const { provider, ledger } = setup(fetchImpl, 4, 50);
    const pending = expect(provider(input, { signal: signal() })).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(51);
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot()).toMatchObject({ unknownUsageAttempts: 1, reservedNanoUsd: JEV_RESERVED_NANO_USD });
  });

  it.each(["request", "caller"])("aborts an in-flight request with the %s signal", async which => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Promise(() => {}));
    const { provider, request, ledger } = setup(fetchImpl);
    const caller = new AbortController();
    const pending = expect(provider(input, { signal: caller.signal })).rejects.toMatchObject({ code: "aborted" });
    (which === "request" ? request : caller).abort();
    await pending;
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(ledger.snapshot().unknownUsageAttempts).toBe(1);
  });

  it("never exposes network errors containing the host key", async () => {
    const { provider } = setup(async () => { throw new Error(`Authorization Bearer ${key}`); });
    await expect(provider(input, { signal: signal() })).rejects.toThrow(/^Ranking provider: transport$/);
  });

  it("preserves the complete actual native search page on provider failure", async () => {
    const catalog = getCatalog(), request = { query: "stellar soroban contract", limit: 10 };
    const { provider } = setup(async () => new Response("unavailable", { status: 529 }));
    const resolver = createRankedSearchResolver({ provider, budget: createRankingCallBudget(1), timeoutMs: 1000 });
    const result = await resolver(catalog, request);
    expect(result).toEqual({ page: searchCatalogPage(catalog, request), ranking: { method: "native", reason: "provider-error", errorCode: "http-error" } });
  });
});
