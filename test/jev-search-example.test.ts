import { expect, it, vi } from "vitest";
import { runRankedSearch } from "../examples/jev-search.ts";
import { JEV_ENDPOINT, JEV_MODEL, JEV_RESERVED_NANO_USD } from "../src/adapters/jev-ranking.ts";

it("requires request approval before using the supplied provider", async () => {
  const transport = vi.fn();
  await expect(runRankedSearch(["soroban storage"], "test-key", transport)).rejects.toThrow("--allow-paid-ranking");
  expect(transport).not.toHaveBeenCalled();
});

it("requires a key and a nonempty query before using the supplied provider", async () => {
  const transport = vi.fn();
  await expect(runRankedSearch(["--allow-paid-ranking", "soroban storage"], undefined, transport)).rejects.toThrow("JEV_API_KEY");
  await expect(runRankedSearch(["--allow-paid-ranking", " "], "test-key", transport)).rejects.toThrow("nonempty search query");
  expect(transport).not.toHaveBeenCalled();
});

it("uses one Jev response to order the bounded candidates and reports its usage", async () => {
  let chosen = "";
  const transport = vi.fn(async (url, init) => {
    expect(url).toBe(JEV_ENDPOINT);
    expect(init?.redirect).toBe("manual");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(JEV_MODEL);
    expect(body.state).toBe("soroban storage");
    const question = body.questions.tool;
    const ids = Object.keys(question.criteria);
    chosen = ids.at(-1)!;
    return Response.json({ model: JEV_MODEL, usage: { input_tokens: 100, output_tokens: 10 },
      answers: { tool: { type: "choice", confidence: 1, choice: chosen, probabilities: Object.fromEntries(ids.map(id => [id, id === chosen ? 1 : 0])) } } });
  });
  const result = await runRankedSearch(["--allow-paid-ranking", "soroban storage"], "test-key", transport);
  expect(result.ranking.method).toBe("provider");
  expect(result.selected[0]).toBe(chosen);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(result.budget).toMatchObject({ attempts: 1, knownUsageAttempts: 1, reportedInputTokens: 100,
    reportedOutputTokens: 10, reservedNanoUsd: JEV_RESERVED_NANO_USD });
});

it("returns the native order after an HTTP failure without retrying or refunding the reserve", async () => {
  const transport = vi.fn(async () => new Response("unavailable", { status: 503 }));
  const result = await runRankedSearch(["--allow-paid-ranking", "soroban storage"], "test-key", transport);
  expect(result.selected).toEqual(result.native);
  expect(result.ranking).toEqual({ method: "native", reason: "provider-error", errorCode: "http-error" });
  expect(result.budget).toMatchObject({ attempts: 1, unknownUsageAttempts: 1, reservedNanoUsd: JEV_RESERVED_NANO_USD });
  expect(transport).toHaveBeenCalledTimes(1);
});
