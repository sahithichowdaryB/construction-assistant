import type { NextRequest } from "next/server";

/**
 * Server-side proxy to the SiteMate capture agent (backend/src/app.js, Node + Claude).
 * The browser calls /api/agent/projects/{pid}/captures[/{thread}/answers]; this handler forwards to
 * AGENT_API_URL and attaches AGENT_API_TOKEN, so the token never reaches the client.
 * Only the two capture routes are forwarded.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

const ALLOWED = /^projects\/[A-Za-z0-9_-]+\/captures(\/[A-Za-z0-9-]+\/answers)?$/;

export async function POST(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  const joined = path.join("/");
  if (!ALLOWED.test(joined)) return Response.json({ detail: "Invalid path" }, { status: 400 });

  const baseUrl = (process.env.AGENT_API_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
  const token = process.env.AGENT_API_TOKEN || "";
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);

  try {
    const upstream = await fetch(`${baseUrl}/${joined}`, {
      method: "POST",
      headers,
      body: await req.arrayBuffer(),
      cache: "no-store",
      signal: AbortSignal.timeout(150_000), // the agent runs the LLM, which can take a minute
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json(
      { detail: `Capture agent unreachable at ${baseUrl}. Start it with "npm run dev" in backend/.` },
      { status: 502 },
    );
  }
}
