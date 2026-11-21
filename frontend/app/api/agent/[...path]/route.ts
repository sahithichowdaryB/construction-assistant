import type { NextRequest } from "next/server";

/**
 * Server-side proxy to the SiteMate capture agent (backend/src/app.js, Node + Claude).
 * The browser calls /api/agent/projects/{pid}/captures...; this handler forwards to AGENT_API_URL and
 * attaches AGENT_API_TOKEN, so the token never reaches the client. Only the capture routes are forwarded:
 *   POST projects/{pid}/captures                  new note (JSON transcript or multipart audio)
 *   POST projects/{pid}/captures/{thread}/answers answers to the agent's questions
 *   POST projects/{pid}/captures/{thread}/review  the speaker's edits to the extracted facts, just before saving
 *   GET  projects/{pid}/captures                  this member's saved notes
 *   GET  projects/{pid}/captures/{source}/audio   a stored recording (Range requests are passed through)
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

const ID = "[A-Za-z0-9_-]+";
const POST_ROUTES = new RegExp(`^projects/${ID}/captures(/${ID}/(answers|review))?$`);
const GET_ROUTES = new RegExp(`^projects/${ID}/captures(/${ID}/audio)?$`);

async function forward(req: NextRequest, ctx: Ctx, method: "GET" | "POST") {
  const { path } = await ctx.params;
  const joined = path.join("/");
  if (!(method === "POST" ? POST_ROUTES : GET_ROUTES).test(joined)) {
    return Response.json({ detail: "Invalid path" }, { status: 400 });
  }

  const baseUrl = (process.env.AGENT_API_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
  const token = process.env.AGENT_API_TOKEN || "";
  const headers = new Headers({ accept: req.headers.get("accept") ?? "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (method === "POST") headers.set("content-type", req.headers.get("content-type") ?? "application/json");
  const range = req.headers.get("range");
  if (range) headers.set("range", range);

  try {
    const upstream = await fetch(`${baseUrl}/${joined}`, {
      method,
      headers,
      body: method === "POST" ? await req.arrayBuffer() : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(method === "POST" ? 150_000 : 30_000), // POST runs the LLM, which can take a minute
    });
    const out = new Headers();
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"]) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return Response.json(
      { detail: `Capture agent unreachable at ${baseUrl}. Start it with "npm run dev" in backend/.` },
      { status: 502 },
    );
  }
}

export const GET = (req: NextRequest, ctx: Ctx) => forward(req, ctx, "GET");
export const POST = (req: NextRequest, ctx: Ctx) => forward(req, ctx, "POST");
