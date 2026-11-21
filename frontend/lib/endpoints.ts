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

  // Planned in the workplan, not built yet
  today: { route: "GET /projects/{pid}/today?as_of", implemented: false },
  ask: { route: "POST /projects/{pid}/ask", implemented: false },
  uploadSource: { route: "POST /projects/{pid}/sources", implemented: false },
  job: { route: "GET /projects/{pid}/jobs/{id}", implemented: false },
  proposals: { route: "GET /projects/{pid}/sources/{sid}/proposals", implemented: false },
  confirm: { route: "POST /projects/{pid}/sources/{sid}/confirm", implemented: false },
  summary: { route: "GET /projects/{pid}/sources/{sid}/summary", implemented: false },
  evidence: { route: "GET /projects/{pid}/evidence/{passage_id}", implemented: false },
  createDraft: { route: "POST /projects/{pid}/drafts", implemented: false },
  getDraft: { route: "GET /drafts/{id}", implemented: false },
  patchDraft: { route: "PATCH /drafts/{id}", implemented: false },
  review: { route: "POST /drafts/{id}/versions/{v}/review", implemented: false },
  export: { route: "POST /drafts/{id}/versions/{v}/export", implemented: false },

  // Proposed by the frontend (not yet in the workplan): list and context reads the screens need
  project: { route: "GET /projects/{pid}", implemented: false },
  activities: { route: "GET /projects/{pid}/activities", implemented: false },
  sources: { route: "GET /projects/{pid}/sources?as_of", implemented: false },
  incidents: { route: "GET /projects/{pid}/incidents?as_of", implemented: true },
  incident: { route: "GET /projects/{pid}/incidents/{id}?as_of", implemented: true },
  incidentAnalysis: { route: "GET /projects/{pid}/incidents/{id}/analysis?as_of", implemented: true },
  analyzeIncident: { route: "POST /projects/{pid}/incidents/{id}/analyze?as_of", implemented: true },
  alertContext: { route: "GET /projects/{pid}/alerts/{id}/context?as_of", implemented: false },
  dismissAlert: { route: "POST /projects/{pid}/alerts/{id}/dismiss", implemented: false },
  drafts: { route: "GET /projects/{pid}/drafts?as_of", implemented: false },
} as const;

export type EndpointKey = keyof typeof ENDPOINTS;

export const USE_FIXTURES = process.env.NEXT_PUBLIC_USE_FIXTURES !== "false";

export function servedFromFixtures(key: EndpointKey): boolean {
  return USE_FIXTURES || !ENDPOINTS[key].implemented;
}

// Set NEXT_PUBLIC_PROJECT_ID=TST (with the TST token in SITEMATE_API_TOKEN) to browse the dummy agent cases.
export const PROJECT_ID = process.env.NEXT_PUBLIC_PROJECT_ID || "RIV";
