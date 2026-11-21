# SiteMate frontend

Mobile-first Next.js 15 app shell for SiteMate (Challenge B). Every screen is routed, typed and rendered from
Riverside demo data. It calls the FastAPI backend where a route exists and uses fixtures where it doesn't.
The frontend makes no AI calls and never calculates business results: it shows what the API or a fixture returns.

Stack: Next.js 15 (App Router), TypeScript (strict), Tailwind 4, shadcn/ui (Radix), TanStack Query,
lucide-react, date-fns-tz, and zod for validating real API responses.

## Run

```bash
cd frontend
npm install
cp .env.example .env.local     # then edit as needed
npm run dev                    # http://localhost:3000
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 3000 |
| `npm run build` | Production build (also lints and type-checks) |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `node scripts/build-fixtures.mjs` | Regenerates the register-derived fixtures from `../data/riverside-demo` |

## Environment variables

| Variable | Where it is used | Default |
| --- | --- | --- |
| `SITEMATE_API_URL` | Server only (proxy) | `http://127.0.0.1:8000` |
| `SITEMATE_API_TOKEN` | Server only. The proxy sends it as `Authorization: Bearer …` | empty |
| `NEXT_PUBLIC_USE_FIXTURES` | Client and server. `true` serves every endpoint from fixtures; `false` uses the live API for implemented routes | `true` |

The token never reaches the browser. The browser only calls `/api/sm/*` on this app. The route handler
`app/api/sm/[...path]/route.ts` forwards GET, POST and PATCH to `SITEMATE_API_URL` and adds the bearer token
(the backend's CORS allows GET only, and only from localhost:3000). `/api/sm/health` wraps `GET /health/db`
and reports the data mode. Settings shows it as "API: connected" and "Data: fixtures" or "Data: live API".

With fixtures on, `/api/sm/projects/RIV/sources/{id}/file` serves the original from `../data/riverside-demo/uploads`
(read-only, honouring `available_at <= as_of`), so the evidence viewer works without the backend.

## Real vs fixture endpoints

The source of truth is `lib/endpoints.ts`. Settings lists the same table at runtime.

| Endpoint | Status |
| --- | --- |
| `GET /health/db` | **Real** |
| `GET /projects/{pid}/alerts?as_of` | **Real** |
| `GET /projects/{pid}/activities/{code}/progress?date&as_of` | **Real** |
| `GET /projects/{pid}/sources/{sid}/file` | **Real** (demo pack fallback in fixture mode) |
| Documents and search: `GET /sources?as_of`, `GET /sources/{id}` (with passages), `GET`/`POST /sources/{id}/summary`, `GET /evidence/{passage_id}`, `GET /sources/{id}/readings`, `GET /sources/{id}/preview`, `GET /sources/{id}/storage`, `POST /sources` (Documents upload), `GET /jobs/{id}` (document jobs), `GET /search`, `GET`/`PATCH /action-items` | **Real** (`backend/documents`) |
| `GET /projects/{pid}/incidents[?as_of]`, `GET /projects/{pid}/incidents/{id}[?as_of]` | **Real**. The UI omits `as_of` by default so every incident is listed (built from `incidents`, `capture_facts`, `fact_evidence`) |
| `GET /projects/{pid}/incidents/{id}/reasoning?as_of`, `POST …/reasoning` | **Real only, no fixtures**. The cause-and-evidence agent (see `../ai-agent/README.md`). Needs `NEXT_PUBLIC_USE_FIXTURES=false` |
| `GET /today`, `POST /ask`, `POST /sources` + `GET /jobs/{id}` from Capture (typed or voice notes), `GET /sources/{id}/proposals`, `POST /sources/{id}/confirm`, `POST /drafts`, `GET`/`PATCH /drafts/{id}`, `POST /drafts/{id}/versions/{v}/review`, `POST …/export` | Planned. Fixtures |
| `GET /projects/{pid}`, `GET /activities`, `GET /alerts/{id}/context`, `POST /alerts/{id}/dismiss`, `GET /drafts?as_of` | Proposed by the frontend. Fixtures |

Documents pages in live mode: **Documents** (upload with job status and review notes), **Document detail** (original,
extracted report quantities, cited summary with provisional values and quoted external text, regenerate, passages),
**Search** (`/search`, evidence search at the as-of time) and **Actions** (`/actions`, open actions with owner, due date
and citation). Passage ids are `<source_id>:<locator>`; the backend also resolves short legacy locators used in fixtures
(`E01:body`, `R10:incidents`). With the backend and frontend running in live mode, `node scripts/check-live-api.mts`
validates every documents response through the proxy with the zod schemas.

Fixture routes run in the browser (`lib/fixture-server.ts`). They filter records by the as-of clock, add about 250 ms of
latency so loading states are visible, and keep draft lifecycle state in memory. That state resets on reload.
Capture confirmations are not persisted.

### Flipping a screen to the real API

1. Build the route in FastAPI.
2. Set `implemented: true` for its key in `lib/endpoints.ts`.
3. In `lib/api.ts`, give its function a `servedFromFixtures(key)` branch that calls `http(path, schema)`, like `getAlerts`, and add a zod schema in `lib/schemas.ts`.
4. Run with `NEXT_PUBLIC_USE_FIXTURES=false`. Pages and hooks don't change; query keys already include project id and `as_of`.

## Cause & evidence panel

`components/incident-reasoning.tsx` renders on `/incidents/[id]`: status, confidence meter, the agent's reasoning, quotes from
the supervisor-side records that state the cause (role chip, source, time stated), outside-party claims shown separately as
context, candidate causes with the code's score next to the LLM's choice, and what is still unknown. "Analyse cause" /
"Re-run reasoning" (site manager or approver) calls `POST …/reasoning`, which runs the agent on the backend (database + LLM), then refetches. With `NEXT_PUBLIC_USE_FIXTURES=false` the
Riverside incident id is a UUID from the database. To browse the dummy agent cases set `NEXT_PUBLIC_PROJECT_ID=TST` and use the
`TST_DEMO_TOKEN` value as `SITEMATE_API_TOKEN`.

## The as-of clock

The header control "Showing …" (`components/as-of-control.tsx`) replays the demo. Incidents are the exception: the list and detail show every incident unless the user ticks "Only show what was reported by the time I'm viewing". Every query sends `as_of` as an ISO
instant with a UTC offset, and all times are displayed in Europe/Vienna. Presets: 10 Nov 07:00, 10 Nov 10:15 (default),
10 Nov 17:30, 11 Nov 17:30 and 12 Nov 07:15. For demos you can deep-link with `?as_of=2026-11-10T17:30:00%2B01:00` and
`?role=approver`.

Things to look for: at 10:15 there's no EXC-B alert yet and no drafts. At 17:30, R10 arrives with the high EXC-B alert and delay draft v1.
At 11 Nov 17:30, R11 is missing (missing-report alert, quantity Unknown). At 12 Nov 07:15, the R11 scan arrives.

## Roles (demo only)

The role switcher stores the role in React context and localStorage. Disabled actions stay visible with a tooltip explaining why.

* **Foreman**: capture, confirm captured fields, upload
* **Site manager**: inspect alerts, dismiss or link, ask, create, edit and submit drafts, upload
* **Approver**: ask, approve, request changes (reason required), export the approved version

## Layout

```
app/(app)/            today, capture (Site notes), alerts[/id], schedule (Programme), incidents[/id], documents[/sourceId], drafts (Notices)[/new|/id], search, actions, settings
app/(auth)/           login, signup templates. Auth goes through lib/auth.ts, which is not connected to a provider yet
app/api/sm/           server-side proxy and health passthrough
components/           shared components (MicButton, ProvenanceBadge, CitationChip, EvidenceViewer, AlertCard, SeverityBadge,
                      ProgressBar, Timeline, DraftStatusBadge, GapHighlighter, DisclaimerBanner, AsOfControl, RoleSwitcher,
                      EmptyState / ErrorState / LoadingSkeleton in states.tsx, AskDrawer, EvidencePanel, ReviewForm)
lib/types.ts          domain types (mirrors plan/SiteMate-architecture.puml and backend/main.py)
lib/api.ts            one typed function per endpoint, throws ApiError {status, message}
lib/queries.ts        TanStack Query hooks
fixtures/             Riverside data (register-derived files are generated; narrative files are hand-written)
```

Settings has a "Simulate API errors" switch that makes fixture routes fail, so you can check the error and retry states.

## Rules the UI follows

* Unknown values render as "Unknown" or "Missing", never 0 or blank. A zero target shows "no percentage".
* The shortfall calculation line (`100 × max(plan − actual, 0) / plan = …`) is assembled for display only from the
  numbers the API returns. Severity and percentages always come from the server.
* Severity and provenance use colour plus an icon plus text.
* Drafts always show the disclaimer. Approve stays disabled while any gap or `[MISSING]`/`[UNVERIFIED]` marker remains.
  Export is enabled only for an approved version. Editing after approval creates a new draft version, and the old approval stays visible.
