# SiteMate backend

The FastAPI service uses PostgreSQL in the private `sitemate` schema. On the provisioned development machine, the connection strings and demo bearer token are in the Git-ignored `backend/.env`. Run the commands below from `backend`.

## Run and inspect

```powershell
.venv/Scripts/python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Open [Swagger](http://127.0.0.1:8000/docs) or [database health](http://127.0.0.1:8000/health/db). To use Swagger, copy the development bearer token with the following command, click **Authorize**, and paste the token. Project membership is checked on progress and original-file requests. The demo credential represents one Riverside member. Provision individual identities before sharing the API publicly.

```powershell
.venv/Scripts/python.exe -c "from dotenv import dotenv_values; print(dotenv_values('.env')['RIVERSIDE_DEMO_TOKEN'], end='')" | Set-Clipboard
```

Try `GET /projects/RIV/activities/EXC-B/progress?date=2026-11-10`. Use the optional timezone-aware `as_of` to replay earlier evidence. The result includes the target, chosen reading, signed shortfall severity, source/page, and eligible observations. Use `GET /projects/RIV/sources/R10/file` with the same bearer credential to open the original PDF. The source files are served from the checked-in demo pack, so keep the backend and demo pack together when deploying.

## Reproduce the database

In the Supabase Table Editor select the private `sitemate` schema. Migration
`0002_workflows` adds ingestion jobs, incident facts and citations, diaries,
summaries, action items, alert revisions, notice versions, reviews and exports.
The Riverside seed records six signed shortfall alerts and one diary entry.
Use `GET /projects/RIV/alerts` for the mobile alert list. Pass a timezone-aware
`as_of` to see only the revisions available by that instant. The current
HTTP service is read-only; capture, review and export writes need their own handlers.

1. Create a Python virtual environment with `python -m venv .venv` and install dependencies with `.venv/Scripts/python.exe -m pip install -r requirements.txt`.
2. Create `.env` from `.env.example` for a new database. The migration URL uses the Supabase session pooler. Configure a separate random password for the read-only `sitemate_reader` login and a random bearer token of at least 32 characters. Keep credentials outside source control.
3. Apply migrations, provision the reader, and seed the project.

```powershell
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe provision_reader.py
.venv/Scripts/python.exe seed_riverside.py
```

The transactional seed upserts the source manifest, registers, dependencies, dated targets, signed report readings and provisional diary estimate. The R11 scan uses a manually verified transcription bound to its file hash. The evaluation answer key is used only by the verifier.

With the API running, execute `.venv/Scripts/python.exe verify_riverside.py` to check the 50 activity/day cases, historical cutoffs, PDF access and project isolation.

## Documents and search (P4)

The `documents/` package parses originals into cited passages, reads scanned pages with OCR,
writes structured summaries and action items, and serves project-scoped evidence search.

| Module | Job |
|---|---|
| `parsers.py` | One parser per file type. Text PDFs (pypdf), scanned pages (vision-model OCR), `.eml`, `.docx` minutes, diary text, CSV/JSON registers, voice transcripts, photo captions. Every passage has a stable locator. |
| `ingest.py` | Pipeline and CLI. Hashes the file, upserts passages, records `ingestion_jobs` (one row per source and stage, reused on retry). |
| `summaries.py` | Cited summaries: observations, decisions, open actions, provisional values and quoted external instructions. Server-side validation drops uncited items and keeps an owner or due date only if the cited text states it. |
| `search.py` | Full-text and trigram search over passages, filtered by project and `available_at <= as_of`, then optionally reranked by Claude. |
| `llm.py` | Claude API client (Anthropic SDK): structured JSON output, refusal fallbacks, reranking. |
| `routes.py` | HTTP routes (below). |
| `schema.py` | Idempotent DDL behind migration `0005_documents`. |

**Locators.** Reports use `p{page}.{section}`, `p{page}.signoff`, `{ACTIVITY}` for a measured
row and `zero-{ACTIVITY}` for the report's explicit zero rule. The other formats use:
- emails: `header`, `body.{n}`
- minutes: `title`, `header.{n}`, `{section}.{n}`
- diary: `handover`
- registers and project register: the row ID or field name
- voice notes: `transcript`
- photos: `caption`
- every source: `meta`

Seeded locators (`R10:EXC-B`, `D10:handover`, `SCH:EXC-B`) are unchanged, so observations and
alert evidence still resolve.

**Safety rules.**
- A quantity table row (text layer or OCR) that differs from what is stored is never
  overwritten. The job goes to `needs_review` with the differences.
- OCR rows are checked against the activity register (code, unit) and the schedule's planned
  quantity before they become proposals.
- Email bodies are stored with `untrusted = true`. Summaries list instruction-like text (E04)
  under `quoted_external_instructions` and never act on it.

### Set up and run

```powershell
.venv/Scripts/python.exe -m documents.schema     # idempotent DDL (same as migration 0005_documents)
.venv/Scripts/python.exe provision_reader.py     # reader grants for the document tables
.venv/Scripts/python.exe seed_riverside.py
.venv/Scripts/python.exe -m documents.ingest     # parse all 29 sources, OCR R11, caption photos, summarise
.venv/Scripts/python.exe -m documents.ingest --source R10 --no-summaries   # one source, parse only
.venv/Scripts/python.exe verify_documents.py     # with the API running: P4 acceptance checks
```

Set `ANTHROPIC_API_KEY` in `.env`. All model calls go through `documents/llm.py` with the
Anthropic Python SDK:

- **Model:** `claude-sonnet-5-5` (`DOCS_LLM_MODEL`). Summaries, scanned-page OCR and photo captions
  run at effort `medium` (`DOCS_LLM_EFFORT`); search reranking runs at `low`.
- **JSON:** every call uses structured outputs (`output_config.format` with a JSON schema), so the
  reply is always schema-valid JSON.
- **Refusals:** requests use server-side refusal fallbacks (`fallbacks: "default"`).

If Claude is unavailable, parsing of text formats still works: OCR jobs go to `needs_review`
(show the original), summaries are marked `failed` and can be retried, and search falls back to
database ranking (the reranker pauses for 5 minutes after a 429 or 529).

### Routes (all under `/projects/{project_id}`, bearer token required)

| Method and path | Purpose |
|---|---|
| `GET /sources?as_of=&kind=` | Sources available at `as_of`, with passage count, summary version and job states |
| `GET /sources/{id}` | Source detail, file URL and jobs |
| `GET /sources/{id}/passages` | Passages in reading order (passage viewer) |
| `GET /evidence/{source_id}/{locator}` | Resolve a citation to its text, page and original file |
| `GET /sources/{id}/proposals` | Quantity readings parsed from a report: `proposed`, `accepted` or `conflict` |
| `GET /sources/{id}/summary?as_of=&version=` | Latest (or given) cited summary |
| `POST /sources/{id}/summary` | Regenerate the summary (new version, background job) |
| `GET /action-items?as_of=&include_completed=` | Open actions with owner, due date, `overdue` and citation |
| `PATCH /action-items/{id}` | `{"completed": true}` |
| `GET /search?q=&as_of=&limit=&rerank=` | Project-scoped evidence search; results carry `untrusted` |
| `GET /sources/{id}/preview` | Structured preview of Word, CSV, email and text originals, with passage locators |
| `GET /sources/{id}/storage` | Where the original is stored and every row (all columns) derived from it |
| `GET /sources/{id}/file?download=true` | The original; inline by default, as an attachment with its original name when `download=true` |
| `POST /sources` (multipart `file`, `source_id`, `kind`, `available_at`) | Store privately, hash, queue parse and summary. `available_at` defaults to the real upload time and is returned. Same file again is a no-op; a different file under an existing ID returns 409. |
| `POST /sources/{id}/ingest?summarize=` | Retry or re-run parsing (idempotent) |
| `GET /jobs/{job_id}` | Job status, attempts, error, review reasons and proposals |

Write routes need the `contributor`, `manager` or `approver` role. The demo member is seeded as
`manager`.

## Sign-in and the three-screen demo

One login, three users, three screens, all on the Zone B excavator breakdown (Riverside, `RIV`).

| Role (`project_members.role`) | Screen | Routes | Tables written |
|---|---|---|---|
| `contributor` (foreman) | `/foreman`: record a note, check the facts, confirm | `POST /projects/{pid}/field-notes`, `POST …/field-notes/{id}/confirm` | `sources`, `source_passages`, `capture_facts`, `fact_evidence` |
| `manager` (site manager) | `/manager`: 65 of 100 m³ on EXC-B, then draft the delay notice | `POST /projects/{pid}/drafts`, `POST …/drafts/{id}/versions` | `drafts`, `draft_versions` (reads `alerts`, `plan_targets`, `observations`) |
| `approver` | `/approver`: notice text, missing contract clause, Approve or Request changes | `POST …/drafts/{id}/versions/{v}/review` | `reviews` |

**Accounts.** Users are Supabase Auth accounts (`auth.users`). `project_members.auth_user_id` links an
account to a project role. `POST /auth/login` checks the password inside the database
(`sitemate.verify_password`, bcrypt via pgcrypto) and returns a random session token; only its SHA-256 is
stored in `sitemate.sessions`. `GET /auth/me` and `POST /auth/logout` use the same token. Five failed
attempts for one email lock that email for 10 minutes. Static `token_hash` members still work for scripts.

**Live data.** `GET /projects/{pid}/site-day?date=&as_of=` computes every planned activity's plan, signed and
estimated quantity, shortfall, equipment, field notes and notice status from `plan_targets`, `observations`
and the registers. `GET /projects/{pid}/related?activity_code=&date=&as_of=` finds other records about that work
with the documents search. `POST /drafts` takes an `alert_id`, or an `activity_code` and `work_date`: the
shortfall is checked against the signed figures and recorded as an alert when it exceeds the threshold.

**Password reset.** `POST /auth/password/forgot` stores a single-use, 30-minute link (`sitemate.password_resets`,
hash only) and answers the same for unknown emails. No mail service is configured, so the link is logged;
`AUTH_DEV_RESET_LINKS=true` also shows it on the page (development only). `POST /auth/password/reset` sets the new
password (10+ characters, letters and numbers) and signs out every session of that account.

**Rules.** Field-note facts are `proposed` until the foreman confirms them. A value the note does not state
(the machine ID) is filled from the equipment register and marked `inferred`. The notice quotes only
confirmed notes, cites every statement, and shows `[MISSING: …]` for contract details the project record
lacks. An approver cannot approve while anything is missing; the manager fills it in as a new version.

```powershell
.venv/Scripts/python.exe auth_schema.py           # idempotent DDL (same as migration 0008_auth_sessions)
.venv/Scripts/python.exe seed_demo_users.py       # create the 3 accounts; prints passwords once
.venv/Scripts/python.exe seed_demo_users.py --reset-passwords
.venv/Scripts/python.exe reset_demo_workflow.py   # remove demo notes, notices and reviews to run it again
```

## Write with SiteMate (emails and letters from a description)

The site manager describes a situation ("Excavator broke down at 10, three workers stopped, GroundWorks hasn't sent
the backup plan"), picks what is needed (email, delay notice, additional cost notice, notice of concern, defect notice)
and optionally the recipient, the day and what to stress. `correspondence.py` then:

1. **Understands** the text with Claude, choosing activity, machines and contractor only from the database lists and
   taking times and numbers only from the manager's words (checked afterwards).
2. **Gathers** read-only, as of the clock: plan and signed quantities, follow-on work, equipment register, the incident
   and its reports, confirmed field notes, open or overdue `action_items`, related documents (documents search).
3. **Calculates in code** the working hours lost (within the working day from Settings), idle worker-hours, output lost
   and, for cost notices, cost lines from `cost_rates`. A missing rate stays `[MISSING: …]`; example rates block approval.
4. **Writes** with Claude from numbered facts only; every fact paragraph cites its records.
5. **Checks**: a paragraph without a valid fact, or a sentence with a number not in the facts, costs or the request,
   is removed and listed under "Removed by the check".
6. **Saves** a private draft (`drafts` with `request`, `recipient`, `analysis`; `draft_versions` v1) and logs the run in
   `agent_runs`. The manager edits or regenerates ("make it firmer"), then sends it for approval; the approver uses the
   usual review queue. Approved versions download as PDF or Word, emails also as `.eml` (opens unsent in Outlook).

| Route (under `/projects/{pid}`) | Who | Purpose |
|---|---|---|
| `GET /correspondence/options` | manager | Letter types, recipients (client, contractors, internal) and rate status |
| `POST /correspondence?as_of=` | manager | Run the agent and create the draft |
| `GET /correspondence`, `GET /correspondence/{id}` | manager (approver: one) | Drafts with the analysis ("What I found") |
| `POST /correspondence/{id}/regenerate` | manager | New version from the latest records, optional instruction |
| `POST /correspondence/{id}/submit` | manager | Send to the approver's queue |
| `GET`/`PUT /cost-rates`, `POST /cost-rates/examples` | manager edits | Rate table and working day; example values for demos |
| `GET /drafts/{id}/versions/{v}/export?format=pdf\|docx\|eml` | manager, approver | Approved versions only |

```powershell
.venv/Scripts/python.exe correspondence_schema.py   # idempotent DDL (same as migration 0009_correspondence)
```

## 3D progress model (2D drawings + deadline -> 3D building coloured by progress)

Plan: [../plan/3d-progress-model-plan.md](../plan/3d-progress-model-plan.md). Package `model3d/`:

| Module | Job |
|---|---|
| `spec.py` | Building spec format (grid, levels, columns, walls, pours, activities in mm), the Riverside reference spec, validation (blocking/warning review notes, calendar) |
| `prompts.py` | P5 "Building spec": reads the drawings' text tables into the spec, cited; three structured-output parts |
| `generator.py` | Spec -> 3D boxes (metres) assigned to pours, split at construction joints. Pure |
| `progress.py` | Pour states from `observations` (signed m3 fill pours in order) and confirmed `production` events; planned windows; forecast (latest slip carried forward); timeline; "why" reasons from events, report remarks and the drawings |
| `store.py`, `routes.py`, `schema.py` | Database access, HTTP routes, idempotent DDL behind migration `0010_model3d` |
| `seed_demo.py` | Demo: activates the Riverside model from the reference spec and writes 5 signed structure reports (A300 raft, A310 walls) |

```bash
.venv/Scripts/python.exe -m alembic upgrade head                      # 0010_model3d (or: python -m model3d.schema)
.venv/Scripts/python.exe -m model3d.seed_demo --apply --model 2027-03-08   # demo model + reports (dry run without --apply)
.venv/Scripts/python.exe -m pytest tests/test_model3d.py              # pure tests
.venv/Scripts/python.exe verify_model3d.py                            # DB + routes in one rolled-back transaction; --llm runs P5 on Plan_3
```

Routes (under `/projects/{pid}`): `POST /models` (drawings PDF + `deadline`, manager), `GET /models`, `GET /models/{id}`,
`PATCH /models/{id}` (spec, deadline), `POST /models/{id}/activate`, `POST /models/{id}/extract`, `GET /models/active`
(geometry), `GET /models/active/progress?date=&as_of=` (stored as an `element_progress` version when the records changed),
`GET /models/active/timeline`. Progress is only ever read from the database; nothing is entered for the 3D view itself.

## Performance evaluation (daily deviations and overall performance)

Plan: [../plan/performance-evaluation-plan.md](../plan/performance-evaluation-plan.md). Package `performance/`:

| Module | Job |
|---|---|
| `metrics.py` | Pure arithmetic (no DB, no model): statuses, thresholds, calendar, cumulative metrics, SPI, S-curve, forecast, critical path, ledger rules, score, notice deadlines |
| `baseline.py` | Plan upload: deterministic CSV mapping or prompts P1a/P1b over the passages (PDFs are also sent as documents so Gantt bars are read), grounding validation, manager edits, activation (one transaction) |
| `daily.py` | Daily evaluation: gather (as_of), metrics, P2 summary, P3 attribution, ledger, alerts, suggestions; versioned |
| `overall.py` | Snapshot to a date: cumulative, S-curve, SPI, forecast, milestones, attribution split, score, P4 narrative |
| `prompts.py` | P1-P4 contracts (SECURITY header, JSON schemas), ref and number validators, the adapter over the existing LLM clients |
| `notices.py` | Additional cost, defect, concern and late-start delay notices for `POST /drafts` (`notice_type`) |
| `export.py`, `routes.py`, `schema.py` | PDF/Word report, HTTP routes, idempotent DDL behind migration `0009_performance` |

```bash
.venv/bin/alembic upgrade head                  # 0009_performance, after 0009_correspondence (or: python -m performance.schema)
.venv/bin/python provision_reader.py && .venv/bin/python provision_ops.py   # grants on the new tables
.venv/bin/python -m performance.baseline --backfill RIV   # schedule.csv as baseline rev 1 (seed_riverside.py does this too)
.venv/bin/python verify_performance.py          # with the API running; add --write for the draft/dispute/model checks
```

Rules: numbers come from `metrics.py` only; every model item must cite a supplied passage and may only repeat supplied
numbers (otherwise it is dropped); record text is untrusted; reads filter `available_at <= as_of` and results are
versioned (a ledger row is valid from `daily_version` until `superseded_version`); thresholds, calendar, notice periods,
rates and ledger points are data in `performance_settings`; nothing is drafted or sent without a manager action.

Routes (under `/projects/{pid}`): `POST/GET /baselines`, `GET/PATCH /baselines/{id}`, `POST /baselines/{id}/activate`,
`POST /baselines/{id}/extract`, `GET /daily-evaluations?from=&to=`, `GET /daily-evaluations/{date}` (computed from code
when missing or stale), `POST /daily-evaluations/{date}/recompute`, `GET /performance?date=`, `POST /performance/narrative`,
`GET /performance/s-curve`, `GET /performance/ledger`, `PATCH /performance/ledger/{id}`, `GET /performance/report.{pdf,docx}`.
Performance alerts (`late_start`, `equipment_idle`, `missing_report`, `quality_hold`) are listed with
`GET /alerts?kind=performance` (or `kind=all`); the default alert list is unchanged. The worker (`worker.py`) runs
`daily_eval` jobs (2-minute debounce per project and day; triggers: signed report parsed, capture event saved, the 18:00
sweep, manual recompute).

## Legacy: the previous Node.js capture agent (superseded, not used any more)

`src/` is a Node.js service that turns a recorded voice note into reviewed project memory.
It is a LangGraph pipeline over four LangChain tools in `src/agent/tools/`:

```
audio ─Whisper─▶ transcript ─fact_extraction (Claude fills JSON)─▶ events
  ─database_search (SQL: activities, equipment, progress, incidents, passages as of recording time)─▶ matches
  ─relationship_matching (dependencies, contractors, shared equipment, open alerts)─▶ relationships
  ─question_generation (Claude + sitemate.business_rules)─▶ validated facts / missing fields / questions
  ─[pause: ask manager ─▶ answers ─▶ question_generation]* (max AGENT_MAX_QUESTION_ROUNDS)
  ─▶ update project memory: sources, source_passages, incidents, capture_facts (proposed), fact_evidence
```

Facts are stored with `review_status='proposed'`; a person confirms them later. Each manager answer is
stored as its own passage (`answer:<question id>`) so every fact cites where it came from.

## Event pipeline: capture → event → incident → alert → action

```
capture (voice | photos | text)
  → perceive (Whisper, Claude vision)            Python  ai-agent/app/capture/pipeline.py, served by FastAPI (capture.py)
  → classify: split into events, SUGGEST a category + type + rationale
  → ⏸ person confirms the category (state saved in sitemate.captures, so it survives restarts)
  → search DB → relationships → required-field questions (per category)
  → ⏸ speaker reviews the extracted facts: edit, remove, fill gaps, or discard (nothing is saved before this)
  → persist in ONE transaction: passages, events, then
      correlation under an advisory lock (auto-link / LLM adjudicate / new incident),
      severity (rule matrix + bounded LLM nudge), alert + revision, facts, debounced agent job
  ⇒ worker (Python, backend/worker.py) claims agent_jobs:
      reasoning  → analyze_incident (root cause)  → plan_actions (recommended actions, guardrailed)
  → manager approves / edits / enacts actions on the Alerts page
```

Categories and event types live in `sitemate.event_categories` / `event_types` (seeded from `rules/event_taxonomy.json`;
add a row with a `project_id` to override per project). Grouping weights and thresholds are in `src/config.js`.

Setup and run (everything is Python except the web UI):

```bash
.venv/bin/alembic upgrade head                  # includes 0005_event_pipeline, 0006_capture_state, 0007_capture_review
.venv/bin/python provision_agent.py             # sitemate_agent: capture writes   (AGENT_DATABASE_URL)
.venv/bin/python provision_reader.py            # sitemate_reader: read-only API   (DATABASE_URL)
.venv/bin/python provision_ops.py               # sitemate_ops: manager actions + worker (OPS_DATABASE_URL)
.venv/bin/python -m uvicorn main:app --port 8000   # API + capture pipeline (needs ANTHROPIC_API_KEY, AGENT_DATABASE_URL)
.venv/bin/python worker.py                      # async reasoning / action planning / escalation / auto-resolve
(cd ../frontend && npm run dev)                 # web UI on :3000
.venv/bin/python seed_event_pipeline.py         # optional demo on project TST (see its docstring)
```

The capture code lives in `ai-agent/app/capture/` (the incident cause analysis in `ai-agent/app/` is untouched) and is
served by `backend/capture.py`. The Node service in `src/` is the previous implementation of the same pipeline; it is no
longer needed or started, and can be deleted. The model is `CAPTURE_LLM_MODEL`, else `CLAUDE_MODEL`, else `LLM_MODEL`.

Capture endpoints on FastAPI, port 8000 (bearer token of a `contributor`, `manager` or `approver` member):

- `POST /projects/{pid}/captures` — multipart: `audio` (one file), `images` (up to 5, JPEG/PNG/WebP/GIF, 5 MB each),
  `transcript`, optional `recorded_at`. Returns `202 needs_category` with `thread_id` and one suggestion per event.
- `POST /projects/{pid}/captures/{thread}/categories` — `{"events":[{"index":0,"category":"equipment","event_type":"equipment_failure","keep":true}],"added":[{"summary","category","event_type"}]}`.
  Events you do not mention keep the AI's suggestion; `keep:false` means "not an event".
- `POST /projects/{pid}/captures/{thread}/review` — `{"edits":[{"index","value"}],"removed":[0],"additions":[{"event_index","field_name","value"}],"discard":false}`.
  Only the person who recorded the note may review it; `discard` deletes the capture and its files; facts are saved as `confirmed` by that person.
- `GET /projects/{pid}/captures` (this member's saved notes) and `GET /projects/{pid}/captures/{source}/audio` (their recording, Range requests supported).
- `POST /projects/{pid}/captures/{thread}/answers` — `{"answers":[{"id":"q1","answer":"EX-02"}]}`; answer `unknown` to record a gap.
  The final `201 saved` response includes `incident_links` (new incident or which one it joined, report/reporter counts, severity).
- `GET /projects/{pid}/event-categories` — categories with their types.

FastAPI (`main.py` + `ops.py`): `GET /incidents` (severity, status, report/reporter counts), `GET /incidents/{id}/events`,
`PATCH /incidents/{id}`, `POST /incidents/{id}/merge`, `POST /incidents/{id}/events/{eid}/unlink`,
`GET /alerts?status&kind`, `GET /alerts/{id}`, `POST /alerts/{id}/{ack|assign|dismiss|resolve|reopen}`,
`GET /alerts/{id}/actions`, `POST /alerts/{id}/actions/{aid}/{approve|reject|complete}`, `PATCH …/actions/{aid}`,
`GET /capture-prompts`. Manager actions need a `manager` or `approver` token and `OPS_DATABASE_URL`.

Notes: audio still needs `OPENAI_API_KEY` or `WHISPER_BASE_URL`; photos and audio are stored on local disk
(`AGENT_IMAGE_DIR`, `AGENT_UPLOAD_DIR`) behind `src/services/storage.js`, so object storage can be swapped in.
Grouping uses structured keys plus a word-overlap similarity and LLM adjudication; there are no embeddings and no
`pg_trgm` dependency.

Tests, from `backend/` (needs a migrated scratch database; never a shared one):
`TEST_DATABASE_URL=postgresql+psycopg://postgres@127.0.0.1:54329/sm .venv/bin/pytest tests ../ai-agent/tests`.
Add `TEST_AGENT_URL`, `TEST_READER_URL` and `TEST_OPS_URL` (the three provisioned roles) to run the suites under the real
least-privilege logins. Without `TEST_DATABASE_URL` only the pure-logic tests run. The suites create and delete their own
projects but toggle triggers on the history tables.

Business rules are rows in `sitemate.business_rules` (seeded from `rules/business_rules.json`); categories without a
type-specific rule use the category's `required_fields`.
