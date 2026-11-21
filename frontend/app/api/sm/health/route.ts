import { backendConfig } from "@/lib/server/backend";
import type { HealthStatus } from "@/lib/types";

/** Passthrough to GET /health/db, reporting whether the app runs on fixtures or the live API. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { baseUrl, useFixtures } = backendConfig();
  const mode: HealthStatus["mode"] = useFixtures ? "fixtures" : "live";
  try {
    const res = await fetch(`${baseUrl}/health/db`, { cache: "no-store", signal: AbortSignal.timeout(4_000) });
    const body = (await res.json().catch(() => ({}))) as { database?: string; detail?: string };
    const status: HealthStatus = res.ok
      ? { mode, api: "connected", database: body.database ?? null, detail: null }
      : { mode, api: "error", database: null, detail: body.detail ?? `HTTP ${res.status}` };
    return Response.json(status);
  } catch {
    const status: HealthStatus = { mode, api: "unreachable", database: null, detail: `No response from ${baseUrl}` };
    return Response.json(status);
  }
}
