/**
 * Which backend routes exist today. Every client function in lib/api.ts is keyed by one of these.
 *
 * - implemented: true  -> served by FastAPI through /api/sm/* when NEXT_PUBLIC_USE_FIXTURES=false
 * - implemented: false -> always served from fixtures/ until the backend ships the route
 *
 * To flip a page to the real API once its route exists, set `implemented: true` here and make sure the
 * matching function in lib/api.ts parses the response (add a zod schema in lib/schemas.ts).
 */
export const ENDPOINTS = {
  health: { route: "GET /health/db", implemented: true },
  alerts: { route: "GET /projects/{pid}/alerts?as_of", implemented: true },
  progress: { route: "GET /projects/{pid}/activities/{code}/progress?date&as_of", implemented: true },
  sourceFile: { route: "GET /projects/{pid}/sources/{sid}/file", implemented: true },

  // Documents and search (backend/documents)
  sources: { route: "GET /projects/{pid}/sources?as_of", implemented: true },
  source: { route: "GET /projects/{pid}/sources/{sid}?as_of (with passages)", implemented: true },
  summary: { route: "GET /projects/{pid}/sources/{sid}/summary", implemented: true },
  regenerateSummary: { route: "POST /projects/{pid}/sources/{sid}/summary", implemented: true },
  evidence: { route: "GET /projects/{pid}/evidence/{passage_id}", implemented: true },
  readings: { route: "GET /projects/{pid}/sources/{sid}/readings", implemented: true },
  storage: { route: "GET /projects/{pid}/sources/{sid}/storage", implemented: true },
  preview: { route: "GET /projects/{pid}/sources/{sid}/preview (Word, CSV, email, text)", implemented: true },
  uploadDocument: { route: "POST /projects/{pid}/sources (document file)", implemented: true },
  documentJob: { route: "GET /projects/{pid}/jobs/{id} (document ingestion)", implemented: true },
  search: { route: "GET /projects/{pid}/search?q&as_of", implemented: true },
  actionItems: { route: "GET /projects/{pid}/action-items?as_of", implemented: true },
  completeAction: { route: "PATCH /projects/{pid}/action-items/{id}", implemented: true },

  // Planned in the workplan, not built yet
  today: { route: "GET /projects/{pid}/today?as_of", implemented: false },
  ask: { route: "POST /projects/{pid}/ask (Ask SiteMate, cited answers)", implemented: true },
  uploadSource: { route: "POST /projects/{pid}/sources (capture: typed or voice note)", implemented: false },
  job: { route: "GET /projects/{pid}/jobs/{id} (capture)", implemented: false },
  proposals: { route: "GET /projects/{pid}/sources/{sid}/proposals", implemented: false },
  confirm: { route: "POST /projects/{pid}/sources/{sid}/confirm", implemented: false },
  createDraft: { route: "POST /projects/{pid}/drafts", implemented: false },
  getDraft: { route: "GET /drafts/{id}", implemented: false },
  patchDraft: { route: "PATCH /drafts/{id}", implemented: false },
  review: { route: "POST /drafts/{id}/versions/{v}/review", implemented: false },
  export: { route: "POST /drafts/{id}/versions/{v}/export", implemented: false },

  // Proposed by the frontend (not yet in the workplan): list and context reads the screens need
  project: { route: "GET /projects/{pid}", implemented: true },
  activities: { route: "GET /projects/{pid}/activities?as_of", implemented: true },
  incidents: { route: "GET /projects/{pid}/incidents (as_of optional; omitted = all incidents)", implemented: true },
  incident: { route: "GET /projects/{pid}/incidents/{id}?as_of", implemented: true },
  // Reasoning always comes from the backend (database + LLM); there are no fixtures for it.
  reasoning: { route: "GET /projects/{pid}/incidents/{id}/reasoning?as_of", implemented: true },
  runReasoning: { route: "POST /projects/{pid}/incidents/{id}/reasoning?as_of", implemented: true },
  alertContext: { route: "GET /projects/{pid}/alerts/{id}/context?as_of", implemented: true },
  dismissAlert: { route: "POST /projects/{pid}/alerts/{id}/dismiss", implemented: true },
  drafts: { route: "GET /projects/{pid}/drafts?as_of", implemented: false },
  // Daily recap stories built from action items (backend/recaps.py), published 06:00 the next morning.
  recaps: { route: "GET /projects/{pid}/recaps?as_of (available_at <= as_of)", implemented: true },
} as const;

export type EndpointKey = keyof typeof ENDPOINTS;

export const USE_FIXTURES = process.env.NEXT_PUBLIC_USE_FIXTURES !== "false";

export function servedFromFixtures(key: EndpointKey): boolean {
  return USE_FIXTURES || !ENDPOINTS[key].implemented;
}

// Set NEXT_PUBLIC_PROJECT_ID=TST (with the TST token in SITEMATE_API_TOKEN) to browse the dummy agent cases.
export const PROJECT_ID = process.env.NEXT_PUBLIC_PROJECT_ID || "RIV";
