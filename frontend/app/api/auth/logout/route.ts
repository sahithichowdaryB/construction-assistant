import type { NextRequest } from "next/server";
import { backendConfig } from "@/lib/server/backend";
import { HOME_COOKIE, SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revokes the session in the database and clears the cookies. */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    const { baseUrl } = backendConfig();
    await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined); // the cookie is cleared either way
  }
  const res = new Response(null, { status: 204 });
  for (const name of [SESSION_COOKIE, HOME_COOKIE]) {
    res.headers.append("set-cookie", `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
  }
  return res;
}
