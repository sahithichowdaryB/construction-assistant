import { NextResponse, type NextRequest } from "next/server";
import { AUTH_REQUIRED, HOME_COOKIE, ROLE_HOME, SESSION_COOKIE } from "@/lib/session";

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
  if (signedIn) {
    const home = req.cookies.get(HOME_COOKIE)?.value;
    const roleHomes: string[] = Object.values(ROLE_HOME);
    const workspace = roleHomes.find((route) => pathname === route || pathname.startsWith(route + "/"));
    const oldNotices = pathname === "/drafts" || pathname.startsWith("/drafts/");
    const sharedHub = ["/today", "/alerts", "/incidents", "/schedule", "/documents", "/actions", "/search", "/settings"].includes(pathname);
    const outsideWorkspace = (sharedHub && home !== ROLE_HOME.site_manager) || (pathname === "/capture" && home !== ROLE_HOME.foreman);
    if (home && roleHomes.includes(home) && (pathname === "/" || isAuthPage || oldNotices || outsideWorkspace || (workspace && workspace !== home))) {
      const url = req.nextUrl.clone();
      url.pathname = home;
      if (oldNotices && home !== ROLE_HOME.foreman) {
        const incident = req.nextUrl.searchParams.get("incident");
        if (home === ROLE_HOME.site_manager && pathname === "/drafts/new" && incident) {
          url.pathname = `/incidents/${encodeURIComponent(incident)}`;
          url.searchParams.set("noticeAt", req.nextUrl.searchParams.get("as_of") || new Date().toISOString());
        } else if (/^\/drafts\/[\da-f-]{36}$/i.test(pathname)) {
          url.searchParams.set("notice", pathname.slice("/drafts/".length));
        }
      }
      url.searchParams.delete("next");
      return NextResponse.redirect(url);
    }
  }
  return NextResponse.next();
}

export const config = {
  // Everything except API routes, Next internals and static files.
  matcher: ["/((?!api/|_next/|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)"],
};
