const endpoint = "https://api.typesafe.ai/v1/systemone";
const redirectOrigin = "https://jev-redirect.invalid";
export const JEV_REDIRECT_COUNTS_URL = "https://jev-smoke.invalid/redirect-counts";
const followed = new Map<string, number>();

/** Local responses for real Worker fetches; no request reaches an external service. */
export async function jevFixtureResponse(request: Request): Promise<Response | undefined> {
  if (request.url === JEV_REDIRECT_COUNTS_URL) {
    if (request.method === "DELETE") followed.clear();
    return Response.json(Object.fromEntries(followed));
  }
  const url = new URL(request.url);
  if (url.origin === redirectOrigin) {
    const status = url.pathname.slice(1);
    followed.set(status, (followed.get(status) ?? 0) + 1);
    return new Response("Unexpected redirect follow", { status: 502 });
  }
  if (request.url !== endpoint || request.method !== "POST") return undefined;
  const body = await request.json() as { state?: string; questions: { tool: { criteria: Record<string, string> } } };
  if (!body.state?.startsWith("smoke-jev:")) return undefined;
  const status = Number(body.state.slice("smoke-jev:".length));
  if ([301, 302, 303, 307, 308].includes(status)) {
    return new Response(null, { status, headers: { location: `${redirectOrigin}/${status}` } });
  }
  const ids = Object.keys(body.questions.tool.criteria);
  return Response.json({ model: "jev-1.14.0", answers: { tool: {
    type: "choice", probabilities: Object.fromEntries(ids.map((id, i) => [id, (i + 1) / 10])),
    choice: ids.at(-1), confidence: 0.5
  } }, usage: { input_tokens: 100, output_tokens: 1 } });
}
