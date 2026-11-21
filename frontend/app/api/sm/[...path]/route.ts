import type { NextRequest } from "next/server";
import { backendConfig, demoPackFile } from "@/lib/server/backend";

/**
 * Server-side proxy to the SiteMate FastAPI service.
 * The browser calls /api/sm/<path>; this handler forwards to SITEMATE_API_URL/<path> and attaches
 * the bearer token, so the token never reaches the client and the backend's GET-only CORS policy
 * doesn't matter.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

// ":" is allowed for passage ids such as "R10:EXC-B" (GET /projects/{pid}/evidence/{passage_id}).
const SAFE_SEGMENT = /^[A-Za-z0-9._~:-]+$/;
const FILE_ROUTE = /^projects\/([^/]+)\/sources\/([^/]+)\/file$/;

async function forward(req: NextRequest, ctx: Ctx, method: "GET" | "POST" | "PATCH") {
  const { path } = await ctx.params;
  if (!path.length || path.some((s) => !SAFE_SEGMENT.test(s) || s === "." || s === "..")) {
    return Response.json({ detail: "Invalid path" }, { status: 400 });
  }
  const joined = path.join("/");
  const { baseUrl, token, useFixtures } = backendConfig();
  const fileMatch = method === "GET" ? joined.match(FILE_ROUTE) : null;

  // With fixtures on, originals come from the local demo pack so the evidence viewer works offline.
  if (fileMatch && useFixtures) {
    return demoPackFile(fileMatch[1], fileMatch[2], req.nextUrl.searchParams.get("as_of"));
  }

  const headers = new Headers({ accept: req.headers.get("accept") ?? "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/${joined}${req.nextUrl.search}`, {
      method,
      headers,
      body: method === "GET" ? undefined : await req.arrayBuffer(),
      cache: "no-store",
      // Uploads and reranked search can take longer than plain reads.
      signal: AbortSignal.timeout(method === "GET" && !joined.endsWith("/search") ? 15_000 : 60_000),
    });
  } catch {
    return Response.json(
      { detail: `SiteMate API unreachable at ${baseUrl}. Start the backend or set NEXT_PUBLIC_USE_FIXTURES=true.` },
      { status: 502 },
    );
  }

  const out = new Headers();
  for (const h of ["content-type", "content-disposition", "content-length", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if (fileMatch && !req.nextUrl.searchParams.has("download")) {
    // Viewing, not downloading: browsers save text/csv instead of showing it, so show it as text.
    if (out.get("content-type")?.startsWith("text/csv")) out.set("content-type", "text/plain; charset=utf-8");
    out.delete("content-disposition");
    out.delete("content-length");
  }
  out.set("x-sitemate-source", "api");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export function GET(req: NextRequest, ctx: Ctx) {
  return forward(req, ctx, "GET");
}

export function POST(req: NextRequest, ctx: Ctx) {
  return forward(req, ctx, "POST");
}

export function PATCH(req: NextRequest, ctx: Ctx) {
  return forward(req, ctx, "PATCH");
}
