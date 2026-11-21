export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Demo logins for the sign-in page, development only.
 *
 * Read from SITEMATE_DEV_ACCOUNTS in .env.local (Git-ignored), never from source, so the passwords are
 * not committed. Format: "Label|email|password;Label|email|password". In a production build this
 * route always answers with an empty list.
 */
export function GET() {
  const raw = process.env.SITEMATE_DEV_ACCOUNTS ?? "";
  if (process.env.NODE_ENV === "production" || !raw.trim()) return Response.json({ accounts: [] });
  const accounts = raw
    .split(";")
    .map((entry) => entry.split("|").map((part) => part.trim()))
    .filter((parts) => parts.length === 3 && parts.every(Boolean))
    .map(([label, email, password]) => ({ label, email, password }));
  return Response.json({ accounts }, { headers: { "cache-control": "no-store" } });
}
