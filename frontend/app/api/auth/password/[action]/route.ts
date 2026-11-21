import type { NextRequest } from "next/server";
import { backendConfig } from "@/lib/server/backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = new Set(["forgot", "reset"]);

/** POST /api/auth/password/forgot and /reset, forwarded to FastAPI. No session is involved. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (!ACTIONS.has(action)) return Response.json({ detail: "Not found" }, { status: 404 });
  const body = await req.text();
  if (body.length > 4000) return Response.json({ detail: "Request too large" }, { status: 413 });
  const { baseUrl } = backendConfig();
  try {
    const upstream = await fetch(`${baseUrl}/auth/password/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const data = await upstream.json().catch(() => ({ detail: "Unexpected response" }));
    return Response.json(data, { status: upstream.status });
  } catch {
    return Response.json({ detail: "The SiteMate API is not reachable. Start the backend and try again." }, { status: 502 });
  }
}
