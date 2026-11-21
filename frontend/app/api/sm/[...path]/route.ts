import type { NextRequest } from "next/server";
import { backendConfig, demoPackFile } from "@/lib/server/backend";
import { AUTH_REQUIRED, SESSION_COOKIE } from "@/lib/session";

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

  // The signed-in user's session token (httpOnly cookie). The shared SITEMATE_API_TOKEN is only a
  // fallback when sign-in is not required (fixture mode); in live mode every call acts as a person.
  const session = req.cookies.get(SESSION_COOKIE)?.value;
  const bearer = session || (AUTH_REQUIRED ? "" : token);
  if (!bearer) return Response.json({ detail: "Not signed in" }, { status: 401 });
  const headers = new Headers({ accept: req.headers.get("accept") ?? "application/json" });
  headers.set("authorization", `Bearer ${bearer}`);
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const range = req.headers.get("range"); // lets <audio> seek in a stored recording
  if (range) headers.set("range", range);

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/${joined}${req.nextUrl.search}`, {
      method,
      headers,
      body: method === "GET" ? undefined : await req.arrayBuffer(),
      cache: "no-store",
      // POST may run the LLM (reasoning, uploads, capture chains several calls); reranked search and PATCH are slower than plain reads.
      signal: AbortSignal.timeout(
        method === "POST" ? 150_000 : method === "PATCH" || joined.endsWith("/search") ? 60_000 : 15_000,
      ),
    });
  } catch {
    return Response.json(
      { detail: `SiteMate API unreachable at ${baseUrl}. Start the backend or set NEXT_PUBLIC_USE_FIXTURES=true.` },
      { status: 502 },
    );
  }

  const out = new Headers();
  for (const h of ["content-type", "content-disposition", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"]) {
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
