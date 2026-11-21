/**
 * Smoke test for live mode: calls the documents routes through this app's /api/sm proxy and
 * validates each response with the same zod schemas lib/api.ts uses.
 *
 *   npm run dev   (with NEXT_PUBLIC_USE_FIXTURES=false and the backend running)
 *   node scripts/check-live-api.mts [http://localhost:3000]
 */
import type { z } from "zod";
import {
  actionItemsSchema,
  alertsSchema,
  evidenceSchema,
  readingsSchema,
  searchSchema,
  sourceDetailSchema,
  sourcesSchema,
  summarySchema,
} from "../lib/schemas.ts";

const base = (process.argv[2] ?? "http://localhost:3000") + "/api/sm/projects/RIV";
const asOf = encodeURIComponent("2026-11-12T18:00:00+01:00");
let failed = 0;

async function check<S extends z.ZodTypeAny>(label: string, path: string, schema: S, test?: (d: z.infer<S>) => boolean) {
  const res = await fetch(base + path);
  const body = await res.json().catch(() => null);
  const parsed = schema.safeParse(body);
  const ok = res.ok && parsed.success && (!test || test(parsed.data));
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `  (HTTP ${res.status}) ${parsed.success ? "" : parsed.error.issues.slice(0, 3).map((i) => i.path.join(".") + ": " + i.message).join("; ")}`}`);
}

await check("sources list", `/sources?as_of=${asOf}`, sourcesSchema, (d) => d.length >= 29);
await check("source detail with passages", `/sources/R10?as_of=${asOf}`, sourceDetailSchema, (d) => d.passages.some((p) => p.id === "R10:EXC-B"));
await check("evidence R10:EXC-B (page 2)", `/evidence/R10%3AEXC-B?as_of=${asOf}`, evidenceSchema, (d) => d.passage.page === 2);
await check("evidence alias E01:body", `/evidence/E01%3Abody?as_of=${asOf}`, evidenceSchema, (d) => d.passage.locator === "body.1");
await check("summary M07", `/sources/M07/summary?as_of=${asOf}`, summarySchema, (d) => d.open_actions.length > 0);
await check("summary E04 quotes the footer", `/sources/E04/summary?as_of=${asOf}`, summarySchema, (d) => !!d.quoted_external_instructions?.length);
await check("readings R11 (OCR)", `/sources/R11/readings?as_of=${asOf}`, readingsSchema, (d) => d.readings.some((r) => r.activity_code === "EXC-B" && r.value === 80));
await check("search", `/search?q=${encodeURIComponent("Who owns EX-02?")}&as_of=${asOf}`, searchSchema, (d) => d.results[0]?.source_id === "EQ");
await check("action items", `/action-items?as_of=${asOf}`, actionItemsSchema, (d) => d.length > 0);
await check("alerts (P1 route still live)", `/alerts?as_of=${asOf}`, alertsSchema);
const file = await fetch(`${base}/sources/E01/file?as_of=${asOf}`);
const fileOk = file.ok && (file.headers.get("content-type") ?? "").startsWith("text/plain");
if (!fileOk) failed++;
console.log(`${fileOk ? "PASS" : "FAIL"} original email served as text/plain`);
console.log(failed ? `${failed} failing` : "All live checks passed");
process.exit(failed ? 1 : 0);
