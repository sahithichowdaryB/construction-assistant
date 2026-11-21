import type { NextRequest } from "next/server";
import { backendConfig } from "@/lib/server/backend";
import { APP_ROLE, HOME_COOKIE, ROLE_HOME, SESSION_COOKIE, type Membership } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Signs in against FastAPI and keeps the session token in an httpOnly cookie. */
export async function POST(req: NextRequest) {
  let body: { email?: unknown; password?: unknown; remember?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ detail: "Invalid request" }, { status: 400 });
  }
  if (typeof body.email !== "string" || typeof body.password !== "string") {
    return Response.json({ detail: "Email and password are required" }, { status: 422 });
  }
  const { baseUrl } = backendConfig();
  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": req.headers.get("user-agent") ?? "" },
      body: JSON.stringify({ email: body.email, password: body.password, remember: body.remember === true }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return Response.json({ detail: "The SiteMate API is not reachable. Start the backend and try again." }, { status: 502 });
  }
  const data = await upstream.json().catch(() => null);
  if (!upstream.ok || !data?.token) {
    return Response.json({ detail: data?.detail ?? "Sign-in failed" }, { status: upstream.status === 200 ? 502 : upstream.status });
  }

  const membership: Membership | undefined = data.memberships?.[0];
  const home = membership ? ROLE_HOME[APP_ROLE[membership.role]] : "/today";
  const maxAge = Math.max(60, Math.floor((Date.parse(data.expires_at) - Date.now()) / 1000));
  const secure = req.nextUrl.protocol === "https:";
  const res = Response.json({ user: data.user, memberships: data.memberships, expires_at: data.expires_at, home });
  const cookie = (name: string, value: string, httpOnly: boolean) =>
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}${secure ? "; Secure" : ""}`;
  res.headers.append("set-cookie", cookie(SESSION_COOKIE, data.token, true));
  res.headers.append("set-cookie", cookie(HOME_COOKIE, home, false));
  return res;
}
