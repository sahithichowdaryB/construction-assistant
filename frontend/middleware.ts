import { NextResponse, type NextRequest } from "next/server";
import { AUTH_REQUIRED, HOME_COOKIE, SESSION_COOKIE } from "@/lib/session";

/**
 * Pages need a signed-in session when the app runs against the live API. The cookie's presence is
 * enough here: the API checks the token itself on every call, so a stale cookie only leads back to
 * sign-in (GET /api/auth/me clears it).
 */
export function middleware(req: NextRequest) {
  if (!AUTH_REQUIRED) return NextResponse.next();
  const { pathname, search } = req.nextUrl;
  const signedIn = !!req.cookies.get(SESSION_COOKIE)?.value;
  const isAuthPage = pathname === "/login" || pathname === "/signup";
  const isPublic = isAuthPage || pathname === "/forgot-password" || pathname === "/reset-password";

  if (!signedIn && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  if (signedIn && (pathname === "/" || isAuthPage)) {
    const home = req.cookies.get(HOME_COOKIE)?.value;
    if (home && home.startsWith("/") && !home.startsWith("//")) return NextResponse.redirect(new URL(home, req.url));
  }
  return NextResponse.next();
}

export const config = {
  // Everything except API routes, Next internals and static files.
  matcher: ["/((?!api/|_next/|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)"],
};
