# Plan: 3D progress model from uploaded 2D drawings

Status: built (steps 1–6; step 7 IFC is optional and not built) · Owner: SiteMate team · Date: 22 Nov 2026
Code: `backend/model3d/`, migration `0010_model3d`, `frontend/app/(app)/model/`, `frontend/components/model3d/`, `frontend/lib/model3d.ts`

## 1. Goal

1. The site manager uploads the **2D structural drawings** (PDF) and enters the **deadline** (target completion date).
2. SiteMate turns the 2D drawings into a **3D model of the building**, with every slab, wall and column as its own element.
3. The progress of every element is **read from the database**, from the records SiteMate already collects (signed daily reports and confirmed capture events). Nothing is entered by hand just for the 3D view.
4. The model is coloured by that progress:
   - **Built**: solid grey
   - **In progress**: the activity's colour, filled up to the % done
   - **Not started**: a faint ghost outline
5. A **timeline slider** (the "3D line") scrubs the date. The model shows how the building looked on that day, how it *should* have looked according to the plan, and how it is forecast to look on the deadline.
6. If the forecast finish is later than the deadline, the page says so, and shows by how many days and why.

If the building is half built, the user sees half a building: the raft and basement are solid, Level 1 is partly filled, and Levels 2 to roof are ghosts.

Reference for the look: `mock_data/Plan_4_Structural_3D_Model.pdf`, sheet 3D03 "4D construction sequence" (grey = complete, colour = in progress, ghost = not started).

## 2. Is it possible?

**Yes, for grid-based reinforced-concrete frames like Riverside Block B.** It is not possible for arbitrary drawings.

| Works | Does not work |
|---|---|
| The drawings carry their numbers as **text**: the grid (7 lines × 7.2 m, 4 lines × 8.0 m), the level table (TOS and slab thickness per level), element sizes (columns 400/450/500, walls 200/250/350), and pour bays by grid range. `Plan_3` has all of these. | Measuring geometry from the drawn lines. Vector-line interpretation is unreliable and out of scope. |
| A **parametric massing model** (LOD ~200): boxes for slabs, walls and columns placed on the grid. This is enough to show progress clearly. | An exact BIM model with openings, rebar and stair geometry. That needs a real IFC file (optional, phase 2). |
| Progress from the database: signed quantities (m³) per activity and confirmed pour events. | Progress per individual element from photos (computer vision). Out of scope. |

If a drawing set is missing a value (e.g. no element schedule), the manager fills it in on the review screen. Nothing is guessed.

## 3. Overview

```
 2D drawings PDF + deadline
        │
        ▼
 ingest (existing documents.ingest) ──► sources, source_passages
        │
        ▼
 P5 "Building spec" extraction (LLM, cited) ──► validate in code ──► manager review ──► Activate
        │
        ▼
 Model generator (code) ──► building_models, model_elements, model_pours
        │
        ▼
 PROGRESS ENGINE (code) ── reads from the DB ──────────────────────────────┐
     observations (signed m³ per activity per day)       ← daily reports   │
     events (confirmed pour / production events)         ← voice + text    │
     sources (available_at, for the date slider)                           │
     plan_targets, activity_plan (planned state)                           │
     metrics.cumulative + forward_pass (forecast state)                    │
        │                                                                  │
        ▼                                                                  │
 element_progress (status + % per pour, per date, versioned) ◄─────────────┘
        │
        ▼
 /model page: 3D viewer (three.js) + timeline slider + Actual | Planned | Compare + deadline banner
```

## 4. Step 1: extract a "building spec" from the 2D drawings (LLM, cited)

New prompt **P5 Building spec**, in `backend/model3d/prompts.py`. It follows the same rules as P1: untrusted input, JSON schema, every value carries a ref `sheet:locator` that the server checks against the passages.

The output is a small JSON document, not geometry:

```json
{
  "grid": {"x": [{"name":"1","at":0}, {"name":"2","at":7200}, ...],
           "y": [{"name":"A","at":0}, {"name":"B","at":8000}, ...]},
  "levels": [{"name":"Raft","tos":-3.50,"slab":1400,"activity":"A300"},
             {"name":"GF","tos":0.00,"slab":400,"activity":"A310"},
             {"name":"L1","tos":3.20,"slab":300,"activity":"A410"}, ...],
  "element_types": [{"mark":"C1","kind":"column","size":[400,400],"levels":"GF-L4"},
                    {"mark":"CW","kind":"wall","thk":250,"levels":"B1-RF"}, ...],
  "placements": [{"mark":"C1","grid":"1A"}, {"mark":"C2","grid":"2B"},
                 {"mark":"CW","from":"4B","to":"5C","shape":"box"},
                 {"mark":"SW1","from":"1B","to":"1C"}, ...],
  "pours": [{"id":"A410-V","activity":"A410","contains":"walls+columns","m3":92.8,"planned":"2026-12-04"},
            {"id":"A410-SA","activity":"A410","contains":"slab","grid_range":"1-4","m3":164.0,"planned":"2026-12-14"}, ...],
  "activities": [{"code":"A300","name":"Raft foundation","start":"2026-10-02","finish":"2026-11-05","m3":1800}, ...],
  "refs": {...}
}
```

Where the values come from in `Plan_3`:

| Spec field | Sheet |
|---|---|
| grid lines and spacing | S101–S104 dimension strings (7200 × 6, 8000 × 3) |
| levels, TOS, slab thickness, activity | S001 "Levels & programme link", S201 sections |
| element types and sizes | S301 §1 element schedule |
| column and wall positions | S103 column labels (1A, 2B, …), core/shear wall labels (CW1, SW1) |
| pours, m³, planned dates, grid range | S301 §3 pour schedule, S101/S102/S103 pour labels |
| activity windows | S001 level table (and Plan 1 when uploaded) |

**Validation in code** (each failure becomes a `review_reason`):
- grid spacings add up to the footprint (43,200 × 24,000)
- levels go up, and level height matches the sections (3.20 m)
- every placement references a known grid point and element type
- the pours of an activity add up to its m³ within 3%
- every activity code in the spec exists in `sitemate.activities`. If it doesn't, the activity is created on activation, so progress rows can be linked to it
- a pour date that falls on a non-working day is flagged (e.g. **A420-V on Fri 25.12.2026**)

## 5. Step 2: manager review and deadline

On the upload page the manager sees:
- the extracted spec in a table, next to the drawing sheet (reuse `evidence-viewer`)
- a **live 3D preview** of the generated model, so wrong grids or levels are obvious at a glance
- a **Deadline** date field (required), prefilled with the contractual date if the drawings or Plan 1 state one
- an **Activate** button. Nothing becomes active without the manager.

A changed drawing set or deadline creates a new model revision. Older progress views keep the revision they used.

## 6. Step 3: generate the 3D elements (code, deterministic)

`backend/model3d/generator.py` turns the spec into boxes:
- **slab**: footprint polygon minus openings (if given) × slab thickness, at TOS
- **column**: size × storey height, at its grid point
- **wall**: from–to on the grid × thickness × storey height
- **raft and downstands**: from the foundation sheet

Each element gets `element_id`, `kind`, `level`, `activity_code`, `pour_id`, its box geometry in metres, and `volume_m3`. The volumes are checked against the pour m³ and shown as "model vs drawing" (e.g. −2%).

The same spec always gives the same model, so this is unit-testable without a database.

## 7. Step 4: progress from the database

All progress is **read from existing database tables**. The 3D view never has its own progress input. When a daily report or voice note is processed by the existing pipeline, the model updates automatically.

### 7.1 Tables read

| Table | Columns used | What it gives the 3D model |
|---|---|---|
| **`sitemate.observations`** (main source) | `activity_code`, `work_date`, `quantity`, `basis`, `source_id`, `locator` | Quantity done per activity per day, from signed daily reports. Only `basis = 'signed'` counts as built. `estimated` rows show as "reported, not signed" (hatched). |
| **`sitemate.events`** (early signal) | `event_type`, `summary`, `attributes`, `activity_code`, `zone`, `occurred_at`, `status` | Confirmed production or pour events from voice notes and text captures (e.g. "Level 1 pour A complete"). They mark a pour built before the signed report arrives, with an "unsigned" badge. Only `status = 'confirmed'`. |
| **`sitemate.sources`** / **`source_passages`** | `available_at`, `id`, `locator`, text | The `as_of` filter: the slider only uses records available by that date. Also the citation shown when an element is tapped (report R10, voice note V07…). |
| **`sitemate.plan_targets`** / **`activity_plan`** | `activity_code`, `work_date`, `quantity`, planned start and finish | The **Planned** state at each date, for the Planned and Compare views. |
| **`sitemate.activities`** | `code`, `name`, `unit` | Links the drawing's activity codes (A300–A450) to the progress rows. |
| **`incident_analyses`**, **`daily_activity_results`** (existing) | cause, confidence, refs | The **Why?** panel when the forecast is past the deadline. |
| `model_pours` (new, from step 3) | `pour_id`, `activity_code`, `seq`, `m3` | The order in which an activity's quantity fills its pours. |

### 7.2 How the status is calculated (code, `model3d/progress.py`)

For each activity and the chosen date D:

```sql
-- signed quantity to date, filtered by what was known at as_of
SELECT o.activity_code, SUM(o.quantity) AS done_m3
FROM sitemate.observations o
JOIN sitemate.sources s ON s.project_id = o.project_id AND s.id = o.source_id
WHERE o.project_id = :pid AND o.basis = 'signed'
  AND o.work_date <= :d AND s.available_at <= :as_of
GROUP BY o.activity_code;
```

1. `done_m3` is poured into the activity's pours in `seq` order:
   - a pour that is fully covered is **built**
   - the next pour is **in progress** with `pct = leftover m³ / pour m³`
   - the rest are **not started**
2. A confirmed `events` row that names a pour (or activity + grid range) marks that pour **built (unsigned)** if the signed quantity hasn't reached it yet.
3. Every element inherits the status and % of its pour.

Example: A410 has 197 m³ signed. Pour V (92.8 m³) is built. Pour SA (164 m³) gets the leftover 104 m³, so it's 64% done. Pour SB is not started.

- The **Planned** state uses `plan_targets` the same way.
- The **Forecast** state at the deadline uses the existing `metrics.cumulative` (recent rate) and `forward_pass`.

### 7.3 Result stored: `element_progress`

The result per pour (status, %, basis `signed` or `event`, refs, `as_of`) is written to the new table `element_progress`, versioned and never overwritten. It's recomputed by the worker when a new observation or confirmed event arrives, using the existing `agent_jobs` queue. Page loads only read it. This keeps database connections low, given the 15-client pooler limit.

## 8. Step 5: the 3D viewer and timeline ("3D line")

New page `frontend/app/(app)/model/page.tsx`. It uses **three.js** via `@react-three/fiber` v9 and `@react-three/drei` (React 19 compatible), which are new dependencies loaded only on this page.

- **3D view**: orbit, zoom and pan. Elements are coloured by status. The activity colours match Plan 4: A300 brown, A310 teal, A410 blue, A420 green, A430 yellow, A440 orange, A450 purple.
- **In-progress fill**: an in-progress pour is filled from one end of its grid range to `pct`, using a clipping plane, so "64% of slab A on Level 1" looks 64% built.
- **Mode toggle**: **Actual** | **Planned** | **Compare**. Compare shows actual elements solid and planned-but-missing elements as a red outline, so the shortfall is visible.
- **Timeline slider** under the model, from project start to deadline:
  - a marker for **today**, for the **deadline** and for the **forecast finish**
  - play/pause to animate the building growing day by day
  - a small chart above the slider with planned vs actual cumulative m³ (the curve from Plan 4 sheet 3D04)
- **Deadline banner**: "Forecast finish 21 Mar 2027 vs deadline 08 Mar 2027: **9 working days late**". It is red when late and green when on time. "Why?" opens the causes from `incident_analyses` and `daily_activity_results`, with citation chips.
- **Tap an element**: shows its mark, level, pour, planned date, actual date and the database record behind it (report R10, voice note V07).
- **Mobile**: works in the Android Capacitor app (WebGL). A low-detail mode merges the elements of each level when the phone is slow.

Optional phase 2: if a project has a real IFC model (Plan 4 names `RRB_STR_v07.ifc`), load it with `web-ifc` instead of steps 1 and 3. The progress from the database and the viewer stay the same.

## 9. New tables (migration `0010_model3d`)

```
building_models   (project_id, id uuid, revision int, status draft|active|superseded, source_ids text[],
                   spec jsonb, review_reasons jsonb, deadline date, created_by, activated_by, activated_at)
model_elements    (project_id, model_id, element_id, kind, level, activity_code, pour_id, mark,
                   geometry jsonb, volume_m3 numeric, source_id, locator)   PK (model_id, element_id)
model_pours       (project_id, model_id, pour_id, activity_code, seq int, planned_date, m3 numeric,
                   grid_range text, source_id, locator)
element_progress  (project_id, model_id, pour_id, as_of timestamptz, status, pct numeric,
                   basis signed|event, refs jsonb)                           -- versioned, never overwritten
```

Reader grants go in `provision_reader.py`, and writes use the ops role.

## 10. API (under `/projects/{project_id}`, bearer token, `as_of` supported)

| Method and path | Role | Purpose |
|---|---|---|
| `POST /models` | manager | upload drawings + deadline, run P5 and the generator, return a draft |
| `GET /models/{id}` | member | spec, review reasons, element list (geometry), pours |
| `PATCH /models/{id}` | manager | edit the spec or deadline, which regenerates the elements |
| `POST /models/{id}/activate` | manager | activate (one transaction, previous revision superseded) |
| `GET /models/active/progress?date=&mode=actual\|planned\|forecast` | member | status and % per pour on that date, read from `element_progress` |
| `GET /models/active/timeline?from=&to=` | member | per-day cumulative planned/actual m³, today, forecast finish, deadline |

The element geometry is sent once and cached. The progress call is small (about 23 pours), so scrubbing the slider is cheap.

## 11. Demo data (must fix before the demo)

The database today has 51 rows in `observations` (50 signed), but only for the old CSV activities (EXC-A, EXC-B, FND, SLAB, POUR-L1…, 8–12 Nov). It has **no rows for A300–A450**, the activities in the 2D drawings. Without them the model shows every element as "not started".

Fix: put the demo progress **into the database through the normal path**, so the 3D view reads it like real data:
- add daily reports for A300 (complete, October to 5 Nov) and A310 (about 50%, 6–20 Nov) to the demo pack, and let the existing ingest write them to `observations` with `basis = 'signed'`
- add one or two voice notes like "Level 1 walls poured" so `events` drives an "unsigned" pour

On 22 Nov the model then shows the raft built, the basement half built and everything above as ghosts. This matches Plan 4 sheet 3D03, view B.

## 12. Build order

| Step | Scope | Done when |
|---|---|---|
| 1 | `model3d/generator.py` + tests, with a **hand-written spec for Riverside** (no LLM yet) | About 270 elements are generated. Volumes per activity are within 3% of S301 |
| 2 | Viewer page with three.js, colours, orbit, static "all planned" model | The building looks like Plan 4 view 1 |
| 3 | Demo reports for A300/A310 ingested into `observations` | The rows exist in the database with `basis = 'signed'` |
| 4 | `model3d/progress.py` reading `observations`, `events`, `sources`, `plan_targets` + `element_progress` + worker job + routes | On 22 Nov the raft is solid, the basement half filled and the rest ghosts |
| 5 | Timeline slider, Planned/Compare modes, deadline banner, "Why?" link | Scrubbing replays the build. Compare shows the red missing parts |
| 6 | Upload page: P5 extraction from `Plan_3`, validation, review grid, 3D preview, deadline field, Activate | Uploading `Plan_3` gives a spec equal to the hand-written one in step 1 (after review) |
| 7 (optional) | IFC upload path | `.ifc` files load directly |

Steps 1–5 give a working demo even before the upload extraction exists.

## 13. Risks

- **Extraction accuracy.** Column positions are read from labels on S103. If labels are missing, the manager places them in the review grid. The 3D preview makes errors visible immediately.
- **Massing, not BIM.** The model is boxes on a grid. It is labelled "progress model, not for construction". The 2D drawings govern, as Plan 4 itself states.
- **Progress granularity.** Reports give m³ per activity, so progress is per pour, not per element. Within a pour, the fill is proportional to m³, not to which exact elements are done.
- **Progress is only as fresh as the database.** If no report or capture has been processed, the model doesn't move. The page shows "last update: report R12, 12 Nov 17:30" so this is clear.
- **Performance on phones.** About 300 boxes is light for WebGL. Merging per level is the fallback.
- **Bundle size.** three.js adds about 150 kB gzipped. Load it only on the `/model` page (dynamic import).
