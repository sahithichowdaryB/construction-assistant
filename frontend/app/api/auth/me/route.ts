import type { NextRequest } from "next/server";
import { backendConfig } from "@/lib/server/backend";
import { HOME_COOKIE, SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in user and their project roles, or 401 (cookies cleared) when the session is gone. */
export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return Response.json({ detail: "Not signed in" }, { status: 401 });
  const { baseUrl } = backendConfig();
  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return Response.json({ detail: "The SiteMate API is not reachable" }, { status: 502 });
  }
  const data = await upstream.json().catch(() => null);
  if (upstream.status === 401) {
    const res = Response.json({ detail: data?.detail ?? "Session expired" }, { status: 401 });
    for (const name of [SESSION_COOKIE, HOME_COOKIE]) res.headers.append("set-cookie", `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
    return res;
  }
  return Response.json(data, { status: upstream.status });
}
