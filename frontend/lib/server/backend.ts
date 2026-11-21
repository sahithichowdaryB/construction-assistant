import "server-only";

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Server-side configuration. These variables are never exposed to the client bundle. */
export function backendConfig() {
  return {
    baseUrl: (process.env.SITEMATE_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, ""),
    token: process.env.SITEMATE_API_TOKEN || "",
    useFixtures: process.env.NEXT_PUBLIC_USE_FIXTURES !== "false",
  };
}

const PACK_ROOT = path.resolve(process.cwd(), "..", "data", "riverside-demo");
const UPLOADS_ROOT = path.join(PACK_ROOT, "uploads");

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".eml": "text/plain; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".wav": "audio/wav",
  ".jpg": "image/jpeg",
};

/**
 * Fixture-mode stand-in for GET /projects/RIV/sources/{sid}/file. Reads the original from the
 * checked-in Riverside demo pack (read-only), honouring available_at <= as_of like the backend.
 */
export async function demoPackFile(projectId: string, sourceId: string, asOf: string | null): Promise<Response> {
  if (projectId !== "RIV") return Response.json({ detail: "Source unavailable" }, { status: 404 });
  let index: { records: { id: string; path: string; available_at: string }[] };
  try {
    index = JSON.parse(await readFile(path.join(PACK_ROOT, "index.json"), "utf8"));
  } catch {
    return Response.json({ detail: "Demo pack not found next to the frontend" }, { status: 404 });
  }
  const record = index.records.find((r) => r.id === sourceId);
  if (!record) return Response.json({ detail: "Source unavailable" }, { status: 404 });
  if (asOf) {
    const cutoff = Date.parse(asOf);
    if (Number.isNaN(cutoff)) return Response.json({ detail: "as_of must be an ISO instant" }, { status: 422 });
    if (Date.parse(record.available_at) > cutoff) return Response.json({ detail: "Source unavailable" }, { status: 404 });
  }
  const file = path.resolve(PACK_ROOT, record.path);
  if (!file.startsWith(UPLOADS_ROOT + path.sep)) return Response.json({ detail: "Source file unavailable" }, { status: 404 });
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
  } catch {
    return Response.json({ detail: "Source file unavailable" }, { status: 404 });
  }
  const body = await readFile(file);
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-disposition": `inline; filename="${path.basename(file)}"`,
      "x-sitemate-source": "fixture-demo-pack",
      "cache-control": "private, max-age=60",
    },
  });
}
