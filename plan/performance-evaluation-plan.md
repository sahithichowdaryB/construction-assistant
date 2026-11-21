# Implementation plan: Daily deviation and overall performance evaluation

Status: proposed · Owner: SiteMate team · Date: 21 Nov 2026
Build prompt: [performance-evaluation-build-prompt.md](performance-evaluation-build-prompt.md)

## 1. Goal

The site manager uploads the plan the project must follow. SiteMate then evaluates the site against that plan at two levels:

1. **Daily evaluation.** The system collects everything recorded for one work day: voice notes, field notes, daily reports, diary entries and documents. It summarises them, measures performance per activity and flags deviations from the plan for that day.
2. **Overall evaluation.** The daily results are rolled up from project start to a chosen date. This gives cumulative progress against the baseline, a trend and a completion forecast. It also gives a ledger of **merits** (days that beat the plan, recovered backlog, early finishes) and **demerits** (shortfalls, late starts, idle equipment, missing reports). Each entry has evidence and an attribution of who caused it.

Both levels can propose correspondence, such as a delay notice or an additional-cost notice. The site manager reviews every proposal and makes the final decision. The system does not send anything or give legal advice.

## 2. Design rules (carried over from the existing code)

| Rule | Why | Where it already lives |
|---|---|---|
| Numbers are computed in code. The LLM never calculates a variance, a percentage or a date. | The figures must be reproducible and auditable, because they end up in notices. | `workflow.site_day`, `main.progress` |
| Every LLM statement cites a passage (`source_id:locator`). Uncited items are dropped on the server. | It keeps the human in control and the output traceable. | `documents/summaries.py`, `ai-agent/app/orchestrator.py` |
| Every read is filtered by `as_of`, and every write is stamped with it. | Replay and the demo clock must keep working. | `deps.check_cutoff`, `workflow.stamp` |
| Results are versioned. A recompute adds a version and never overwrites the previous one. | The evidence trail for claims stays intact. | `alert_revisions`, `draft_versions` |
| Record text is untrusted data, so instructions inside it are never followed. | Prompt injection through emails and transcripts. | `ai-agent/app/prompts.py` header |
| A signed quantity beats an estimate. An estimate is never used as the actual value in a metric. | Business rule `quantity.required`. | `backend/rules/business_rules.json` |
| Thresholds and weights live in data, not in code. | The plan document defines them, for example section 5 of RR-B-PLN-002. | `projects.threshold`, `business_rules` |

## 3. Current state and gaps

What exists today:
- The plan is the CSV `schedule.csv` register. Seeding or parsing loads it into `activities`, `activity_dependencies` and `plan_targets`, which holds the quantity per activity per day.
- `observations` holds the signed and estimated quantities taken from reports and notes.
- `GET /site-day` lists, for one day, the plan, the actual quantity and the **shortfall** only, with severity `none`, `medium` or `high`. `alerts` and `alert_revisions` record shortfall alerts. `POST /drafts` builds a delay notice from an alert.
- The capture pipeline (`ai-agent/app/capture`) turns voice notes and text into typed `events`, such as equipment failure, production, delivery delay or weather. The incident agent finds causes with confidence scores.

The gaps this plan closes:
1. The plan cannot be uploaded as a PDF. The mock PDFs in `mock_data/` (RR-B-PLN-001 programme, RR-B-PLN-002 resource, cost and contract plan) cannot be ingested. The system also does not keep the planned start and finish dates, total quantity, weight, critical flag, milestones, notice periods or idle rates.
2. The daily view measures only shortfall. It ignores over-performance, unplanned work, late or early starts, equipment idle time and missing reports. It produces no written summary of the day.
3. Nothing is cumulative: there is no S-curve, schedule performance index (SPI), forecast or float consumption.
4. There is no merit or demerit ledger and no attribution of who caused a deviation.

## 4. Architecture overview

```
 Upload plan (CSV / PDF) ──► Plan extraction (LLM for PDF) ──► Review & activate baseline
                                                                   │
                         plan_baselines, activity_plan, plan_targets, milestones, performance_settings
                                                                   │
 Events, notes, reports, diary ──► DAILY EVALUATION (per project, per work_date, as_of)
                                    1 gather day bundle             (code)
                                    2 activity metrics + status     (code)
                                    3 day summary                   (LLM, cited)
                                    4 deviation attribution         (LLM, cited, reuses incident analyses)
                                    5 ledger entries + alerts        (code)
                                    6 correspondence suggestions     (code rules + LLM wording)
                                                                   │
                         daily_evaluations, daily_activity_results, performance_ledger, alerts
                                                                   │
                                   OVERALL EVALUATION (as of date D)
                                    1 cumulative metrics, SPI, forecast, critical path (code)
                                    2 merit/demerit roll-up and score                    (code)
                                    3 narrative: trend, merits, demerits, risks, actions (LLM, cited)
                                                                   │
                                   performance_snapshots ──► /performance page, PDF/Word export
```

New Python module: `backend/performance/`, laid out like `backend/documents/`.

| File | Job |
|---|---|
| `baseline.py` | Ingest the plan (CSV is deterministic, PDF goes through the LLM), compare against the active baseline, activate, expand targets per day |
| `metrics.py` | Pure functions with no DB and no LLM: daily activity metrics, statuses, cumulative metrics, forecast, critical path, ledger rules, score |
| `daily.py` | Daily evaluation orchestration: gather, metrics, LLM, persist |
| `overall.py` | Overall evaluation orchestration |
| `prompts.py` | Prompts P1–P4 from section 8 |
| `schema.py` | Idempotent DDL, mirrored by migration `0009_performance` |
| `routes.py` | HTTP routes (section 9) |

LLM access goes through the existing `ai-agent/app/llm.py` (`get_llm().generate_json`) or `documents/llm.py`. Use whichever one `documents` uses for structured output, and do not add a third client.

## 5. Phase 0: upload and activate the plan

### 5.1 Inputs
- **CSV registers** (today's path): `schedule.csv` and optionally `equipment.csv` and `contractors.csv`. The existing parser maps these deterministically.
- **PDF plans** (new): programme documents and resource, cost and contract plans, such as the two in `mock_data/`.

### 5.2 Flow
1. `POST /projects/{id}/baselines` (manager only) takes one or more files. Each file goes through the existing `documents.ingest`, which gives a source, passages and a hash.
2. For a PDF, prompt **P1 Plan extraction** returns structured rows. Each row carries a citation (`source_id`, `locator`, page):
   - activities: code, name, trade or contractor, unit, planned start and finish, duration in working days, planned total quantity, target per day, weight %, predecessors, critical flag
   - milestones: code, name, planned date, contractual yes or no
   - calendar: working days, holidays, shift hours
   - thresholds (amber and red bands per indicator), notice rules (type, deadline in working days, addressee role), equipment idle and standby rates, liquidated damages rate
3. The extraction is validated in code: each code is unique, finish ≥ start, the weights add up to 100 ± 0.5, every predecessor exists, and the target per day × duration ≈ total, within 2%. Each failure becomes a `review_reason`. Nothing is activated automatically.
4. The baseline is stored as `plan_baselines.status = 'draft'`. The UI shows the extracted rows next to the original page, which reuses `evidence-viewer`. The manager edits the rows and activates the baseline.
5. Activation runs in one transaction. It upserts `activities` and `activity_dependencies`, writes `activity_plan`, expands `plan_targets` per working day (target per day on each working day from start to finish, using the calendar) and writes `milestones` and `performance_settings`. Every `plan_targets` row keeps its `source_id` and `locator`, as it does today. The baseline it replaces gets `status = 'superseded'`. It is not deleted.

### 5.3 Rules
- A changed plan creates a new baseline revision. Daily evaluations always record the `baseline_id` they used, so old results stay explainable.
- Quantities come from the document or from the manager, never from the LLM's own guesses. A field the document does not contain is left empty and marked `missing`.

## 6. Section 1: daily evaluation

Key: `(project_id, work_date, as_of)`. Each run produces a new version of `daily_evaluations`.

### 6.1 Triggers
- A signed daily report is accepted (an `observations` row with `basis='signed'`). This is the primary trigger.
- A capture event is confirmed for that day (production, equipment failure, weather, delivery delay and so on). This recomputes a provisional evaluation.
- An end-of-day sweep in the worker at 18:00 project time, which also flags a **missing report**.
- A manual `POST .../daily-evaluations/{date}/recompute`.

All triggers go through `agent_jobs` with `kind = 'daily_eval'`. `ai-agent/app/worker.py` gets a `run_daily_eval` handler. A 2-minute debounce per project and date applies, so that a burst of events causes only one run.

### 6.2 Step 1: gather the day bundle (code)
For the work date, filtered by `available_at <= as_of`:
- the plan: `plan_targets` for the date, `activity_plan` rows active on the date, and milestones due within ±5 working days
- the actuals: the latest signed observation per activity, and the latest estimate as context only
- the events: confirmed `events` whose `occurred_at` falls on the date, with incident links and any existing `incident_analyses`
- the documents: passages from diary entries, minutes, emails, voice transcripts and report pages dated that day, using the existing `search.py` filters by project and `as_of`
- the resources: `equipment_assignments` for the date, and headcount if a report gives it

The bundle is hashed, giving `input_digest`. If the digest matches the latest version, no new version is written. The orchestrator already does this.

### 6.3 Step 2: activity metrics and status (code, `metrics.daily_activity`)
For each activity planned on the date, or with any actual on the date:

| Field | Formula |
|---|---|
| `planned` | the `plan_targets.quantity` for the date (0 if none) |
| `actual` | the signed quantity, or `null` if none has been reported yet |
| `variance` | `actual − planned` (positive means ahead) |
| `variance_pct` | `100 × variance / planned` when planned > 0 |
| `status` | see the table below |
| `severity` | `none`, `amber` or `red`, from the project thresholds |

| Status | Condition |
|---|---|
| `exceeded` | variance_pct ≥ +`over_threshold` (default +10%) |
| `on_track` | −amber < variance_pct < +over_threshold |
| `behind` | variance_pct ≤ −amber (amber: 10–20% short, red: > 20% short, or amber two days in a row) |
| `not_reported` | planned > 0 and no signed actual by `as_of` (red after the sweep) |
| `unplanned_work` | planned = 0 and actual > 0. This can be catch-up, which links to the backlog in section 7 |
| `late_start` | the first planned day has passed, with no actual since `planned_start` (amber at 1–2 working days, red at ≥ 3 or on a critical activity) |
| `not_started_ok` | the activity is not yet due |

Day-level indicators: equipment idle hours, summed from `equipment_failure` and `repair_release` event pairs per machine (amber above 2 h, red for a full shift); labour attendance against plan where it was reported; failed hold points from `quality_observation` events (always red).

The thresholds come from `performance_settings`. The current `projects.threshold` and `high_threshold` columns seed the defaults so that `/site-day` keeps returning the same results.

### 6.4 Step 3: day summary (LLM, prompt P2)
The input is the bundle passages, numbered, plus the computed metrics table, which the model may read but not change. The output is a structured, cited summary:
- `headline`: one sentence on how the day went against the plan
- `work_done[]`, `disruptions[]`, `resources[]` (crews and equipment), `weather`, `deliveries[]`, `instructions_received[]`, `safety_quality[]`, `open_items[]` (with owner and due date only if a passage states them)
- every item has `refs[]`. The server drops any item without a valid ref, using the same validator as `documents/summaries.py`.

### 6.5 Step 4: deviation attribution (LLM, prompt P3)
This runs only for activities with severity amber or red, or with status `exceeded` or `unplanned_work`.
- The input is the deviation rows, the related events and passages (reusing `related_records`), and any incident analysis that already exists for a linked incident.
- The output per activity is `explanation` (one or two sentences), `cause_category` (`contractor_internal`, `subcontractor`, `client`, `designer`, `supplier`, `weather`, `third_party`, `unknown`), `responsible_party_ref`, `confidence` (0–1), `refs[]`, and `is_excusable_candidate` (true only for client, designer or weather beyond the allowance: something the manager *may* want to notify).
- If an incident analysis exists, its status and confidence take precedence and the model must not contradict it. When no cited cause exists, the result is `unknown` with low confidence. Causes are never invented.

### 6.6 Step 5: ledger entries and alerts (code)
- Ledger rules (section 7.3) turn each activity result into `performance_ledger` rows with `status = 'proposed'`.
- Alerts: the existing `alerts` table gets new kinds `late_start`, `equipment_idle`, `missing_report` and `quality_hold`. The existing `shortfall` kind stays. Each change adds a new `alert_revisions` row whose `calculation` holds the metric row and whose `evidence_refs` holds the citations.

### 6.7 Step 6: correspondence suggestions (code first, LLM for wording)
Rules from `performance_settings.notice_rules`, which the plan document seeds:

| Trigger | Suggested notice | Deadline |
|---|---|---|
| red deviation on a critical activity with `cause_category` in client, designer, supplier (client-supplied) or third_party | delay notice | `event_date + notice_days.delay`, in working days |
| equipment idle ≥ 1 shift caused by others | additional cost notice (idle rate × hours, using the plan's rates) | `notice_days.additional_cost` |
| a `quality_observation` naming a defect in others' work or client material | defect notice | `notice_days.defect` |
| an instruction or design problem flagged in the summary's `instructions_received` | notice of concern | immediately |

A suggestion is stored on the alert revision as `suggested_notice = {type, deadline, reason, refs}`. The manager clicks **Draft**, and the existing `POST /drafts` flow, extended to accept these notice types, builds the draft. Deadlines appear as a countdown. Nothing is drafted or sent automatically.

### 6.8 Daily output (API shape, abridged)
```json
{
  "work_date": "2026-11-10", "version": 3, "as_of": "...", "baseline_id": "...",
  "day_status": "behind",                       // worst activity severity, rolled up
  "day_score": -4,                               // sum of the day's ledger points
  "summary": { "headline": "...", "work_done": [{"text": "...", "refs": ["R10:EXC-B"]}], ... },
  "activities": [{ "code": "EXC-B", "planned": 100, "actual": 92, "variance": -8, "variance_pct": -8.0,
                   "status": "on_track", "severity": "none", "attribution": {...}, "refs": [...] }],
  "indicators": { "equipment_idle_hours": {"EX-02": 3.5}, "missing_reports": [], "quality_holds": [] },
  "suggestions": [{ "type": "delay_notice", "deadline": "2026-11-17", "alert_id": "...", "refs": [...] }]
}
```

## 7. Section 2: overall performance and merits and demerits

Key: `(project_id, as_of_date D, as_of)`. Stored in `performance_snapshots`, versioned.

### 7.1 Cumulative metrics (code, `metrics.cumulative`)
Per activity, to date D:
- `planned_cum`: the sum of `plan_targets` up to D. `actual_cum`: the sum of signed actuals up to D. `backlog = planned_cum − actual_cum`
- `pct_complete_planned = planned_cum / planned_total`, and `pct_complete_actual` likewise
- `days_behind = backlog / target_per_day`, which is negative when ahead
- `recent_rate`: the mean of signed actuals over the last 5 working days with output
- `forecast_finish`: D plus the working days needed to finish `(planned_total − actual_cum) / recent_rate`, using the calendar. It is `null` when the rate is 0, which is flagged.
- `finish_variance_days = forecast_finish − planned_finish`, in working days

At project level:
- Weighted progress: `Σ weight × pct_complete` for both planned and actual. This gives the **S-curve** points per day, planned against actual.
- `SPI = actual_weighted / planned_weighted`. Bands: ≥ 1.0 green, 0.95–1.0 amber, < 0.95 red. The bands come from settings.
- Critical path: a forward pass over `activity_dependencies` using each activity's forecast duration. It gives the forecast date of each milestone, its variance against plan, float consumed and the forecast completion date. Liquidated-damages exposure = days late × LD rate, labelled "indicative".
- Recovery: activities whose backlog fell over the last N days (catch-up), with the days recovered.

### 7.2 Attribution roll-up
The `days_behind` per activity is split by the `cause_category` of the daily demerits that built it up. It is weighted by the shortfall quantity of each day. The result is an "excusable against non-excusable" split. This is what a manager needs before deciding on a claim, and it is labelled "for review, not legal advice".

### 7.3 Merit and demerit ledger (code rules, versioned config)
These rules are stored in `performance_settings.ledger_rules`, so a project can tune them. The defaults:

| rule_key | Kind | Condition | Points |
|---|---|---|---|
| `day.exceeded` | merit | status `exceeded` | +1 (+2 if ≥ +25%) |
| `backlog.recovered` | merit | `unplanned_work` or `exceeded` that reduces existing backlog | +1 per day recovered |
| `activity.early_finish` | merit | actual_cum ≥ planned_total before planned_finish | +3 |
| `milestone.met` | merit | milestone reached on or before its planned date | +3 |
| `quality.first_time_pass` | merit | hold point passed with no failure | +1 |
| `day.shortfall_amber` | demerit | severity amber | −1 |
| `day.shortfall_red` | demerit | severity red | −3 |
| `activity.late_start` | demerit | late start (amber −1, red −3) | −1 / −3 |
| `equipment.idle` | demerit | idle ≥ 2 h | −1 (−2 for a full shift) |
| `report.missing` | demerit | no signed report after the sweep | −2 |
| `quality.hold_failed` | demerit | failed inspection | −3 |
| `milestone.missed` | demerit | milestone passed and not reached | −5 |

Each entry stores `{work_date, activity_code, rule_key, kind, points, attribution (cause_category, party), evidence_refs, daily_eval_version, status: proposed | accepted | disputed, reviewer, note}`.

- **Attribution matters.** A demerit caused by the client, designer or weather is kept but marked `excusable`. It does not count against the contractor's own score. Instead it adds to the "claim exposure" list.
- The manager can accept or dispute each entry (`PATCH /performance/ledger/{id}`), with a note. A disputed entry is left out of the score until it is resolved.
- `score_to_date = Σ points of accepted and proposed, non-excusable entries`. The snapshot also gives a per-week breakdown and the five best and five worst days.

### 7.4 Overall narrative (LLM, prompt P4)
The input is the cumulative metrics, the ledger (with refs), the attribution split and the five worst and best days with their summaries. The output, all cited:
- `overall_status` (`ahead`, `on_plan`, `at_risk` or `delayed`, taken from the SPI band and the critical path in code; the model may only explain it)
- `trend` (the last two weeks against before)
- `merits[]` and `demerits[]` (the most significant ones, grouped by theme, for example "excavation catch-up 12 Nov recovered 1.5 days")
- `risks[]` (forward-looking, for example "facade lead time against forecast topping-out")
- `recommended_actions[]` (operational, for example add a shift or chase the supplier) and `correspondence_to_consider[]` (taken from open, unsent suggestions, with their deadlines)
- the disclaimer string, always present

### 7.5 Export
`GET /performance/report.pdf|docx?date=` renders the snapshot with the S-curve, activity table, ledger and narrative. It uses the existing export component (`exports` table), and the reviewer's name and decision are printed on the report.

## 8. LLM prompts (contracts)

All prompts follow the existing `prompts.py` conventions: the SECURITY paragraph about untrusted data, JSON-only output enforced with a JSON schema, times in the project's time zone, and a cited `refs` field on every item. The server validates every ref against the passages it supplied.

| ID | Name | Effort | Input | Output schema |
|---|---|---|---|---|
| P1 | Plan extraction | medium | the plan PDF passages, page by page, plus the target schema | activities, milestones, calendar, thresholds, notice_rules, rates, `missing[]`, each with refs |
| P2 | Day summary | medium | the day bundle passages plus a read-only metrics table | section 6.4 |
| P3 | Deviation attribution | high | deviation rows, related passages, incident analyses | section 6.5 |
| P4 | Overall narrative | medium | the snapshot metrics, ledger and best and worst days | section 7.4 |

Model: Sonnet 5.5 (the documents module default) for P1, P2 and P4, and the agent's configured model for P3. Both are set through env vars that already exist.

## 9. Data model: migration `0009_performance` (down_revision `0008_auth_sessions`)

```
plan_baselines        (project_id, id uuid, revision int, status draft|active|superseded, source_ids text[],
                       extracted jsonb, review_reasons jsonb, activated_by, activated_at)
activity_plan         (project_id, baseline_id, activity_code, planned_start, planned_finish, duration_wd,
                       planned_total numeric, target_per_day numeric, weight numeric, is_critical bool,
                       source_id, locator)                               PK (project_id, baseline_id, activity_code)
milestones            (project_id, baseline_id, code, name, planned_date, contractual bool, achieved_date,
                       source_id, locator)
performance_settings  (project_id, baseline_id, settings jsonb)  -- thresholds, calendar, notice_rules, rates, ledger_rules
daily_evaluations     (project_id, work_date, version, as_of, baseline_id, input_digest, day_status, day_score,
                       summary jsonb, indicators jsonb, suggestions jsonb, model, status ok|needs_review|failed)
daily_activity_results(project_id, work_date, version, activity_code, planned, actual, basis, variance,
                       variance_pct, status, severity, attribution jsonb, refs jsonb)
performance_ledger    (project_id, id uuid, work_date, activity_code, rule_key, kind merit|demerit, points,
                       cause_category, excusable bool, refs jsonb, daily_version, status, reviewer_id, note,
                       created_at, reviewed_at)       UNIQUE (project_id, work_date, activity_code, rule_key)
performance_snapshots (project_id, as_of_date, version, as_of, metrics jsonb, s_curve jsonb, narrative jsonb,
                       score numeric, model, status)
```
- Every table lives in the `sitemate` schema, with reader grants in `provision_reader.py`.
- `alerts.kind` accepts the new kinds, and `alert_revisions` gains `suggested_notice jsonb`.
- `drafts.notice_type` accepts `additional_cost_notice`, `defect_notice` and `notice_of_concern`.
- A ledger row is updated in place only for review status. When its source evaluation changes, the old row is closed with `status='superseded'` and a new one is inserted.

## 10. API (all under `/projects/{project_id}`, bearer token, `as_of` supported)

| Method and path | Role | Purpose |
|---|---|---|
| `POST /baselines` | manager | upload plan files, start extraction |
| `GET /baselines`, `GET /baselines/{id}` | member | extracted rows, review reasons, refs |
| `PATCH /baselines/{id}` | manager | edit extracted rows |
| `POST /baselines/{id}/activate` | manager | activate the baseline (transaction in section 5.2) |
| `GET /daily-evaluations/{date}` | member | latest version (or `?version=`) |
| `POST /daily-evaluations/{date}/recompute` | manager | enqueue a run |
| `GET /performance?date=` | member | latest snapshot to date (computed on demand if missing or stale) |
| `GET /performance/s-curve?from=&to=` | member | planned against actual points |
| `GET /performance/ledger?from=&to=&kind=&status=` | member | merit and demerit entries |
| `PATCH /performance/ledger/{id}` | manager | accept or dispute, with a note |
| `GET /performance/report.{pdf,docx}?date=` | member | export |

`/site-day` stays backward-compatible. It adds `daily_evaluation` (headline, status, score) when one exists.

## 11. Frontend (Next.js, existing Hi-Vis design tokens)

- **Today** (`app/(app)/today`): a "Day performance" card with the headline, status chip and day score. Below it, activity rows showing planned, actual, a variance bar (green for ahead, red for behind) and the cause chip. Then suggestion cards with the deadline countdown and a **Draft notice** button, and a "Recompute" action.
- **Performance** (new `app/(app)/performance`): KPI tiles (weighted progress planned against actual, SPI, forecast completion with variance, score), the S-curve chart, the activity table (backlog, days behind, forecast finish), a milestone forecast strip, and the merit and demerit ledger with accept and dispute controls and citation chips. The narrative panel always carries the disclaimer banner (`disclaimer-banner.tsx`).
- **Schedule**: overlays actual bars and forecast finish on the planned bars.
- **Baseline upload** (in Settings or Schedule): an upload form, then the extracted-rows grid next to the PDF page viewer, the review reasons, and Activate.
- Reuse `citation-chip`, `evidence-panel`, `as-of-control` and `day-nav`.

## 12. Delivery order and acceptance criteria

| Step | Scope | Done when |
|---|---|---|
| 1 | Migration 0009, `schema.py`, reader grants | `alembic upgrade head` and downgrade both run. Existing tests pass. |
| 2 | `metrics.py` (pure) with unit tests | Tests cover every status, the threshold edges, the forecast, the critical-path pass, the ledger rules and the attribution split. No DB is needed. |
| 3 | Baseline CSV path plus activation, and backfill of the Riverside demo as baseline rev 1 | `/site-day` output is unchanged for the 50 Riverside activity/day cases (`verify_riverside.py` passes). |
| 4 | Daily evaluation: steps 1, 2 and 5 (code only) plus the worker job and routes | Riverside 10 Nov: EXC-B planned 100, actual 92, variance −8%. The status follows the project thresholds and matches the existing shortfall severity. The six planted shortfall alerts reproduce. A day with no report gives `not_reported`. |
| 5 | Daily LLM steps P2 and P3 plus ref validation | Every summary item has valid refs. The planted prompt injection in E04 is quoted, not obeyed. EX-02 idle time is attributed using the existing incident analysis. |
| 6 | Overall snapshot (metrics, ledger, P4) | Riverside 12 Nov: the off-plan EXC-B output is `unplanned_work` and produces a `backlog.recovered` merit. The S-curve and SPI agree with a hand calculation in the test. |
| 7 | Correspondence suggestions plus the extended draft types | A red critical client-caused deviation yields a delay-notice suggestion with a deadline from settings. Draft creation reuses `POST /drafts`. |
| 8 | PDF plan extraction (P1) and review UI | Uploading `mock_data/Plan_1_…pdf` and `Plan_2_…pdf` extracts 21 activities, 8 milestones, thresholds, notice rules and idle rates. Validation passes (weights add up to 100). Nothing activates without a manager. |
| 9 | Frontend: Today card, Performance page, ledger review, export | Demo script (section 13) runs end to end in replay mode. |

## 13. Demo script: "a day in the life"

1. 07:30. The manager opens **Performance**. It shows SPI 0.97 (amber) and a forecast finish 1.5 working days late, with the critical path through excavation.
2. 09:40. A voice note: "Excavator EX-02 hydraulic hose burst, three workers idle." The event is confirmed, and the provisional daily evaluation shows `equipment_idle` amber.
3. 17:30. The signed report is uploaded. The daily evaluation recomputes: EXC-B 92 of 100, the headline and a cited summary. The attribution reads "contractor_internal (equipment), confidence 0.8" and cites the mechanic's note and the service email.
4. A suggestion card offers no delay notice, because the cause is internal. The manager can still draft one manually.
5. The next day, catch-up output is recorded off-plan. The merit `backlog.recovered` appears, SPI goes up, and the overall narrative reports the recovery.
6. The manager disputes one demerit and adds a note, then exports the weekly performance report as PDF.

## 14. Risks and open questions

- **PDF extraction quality.** Gantt bars are graphics, so extraction must rely on the activity tables. Mitigation: validation rules and a manager review before activation.
- **Calendar.** Riverside includes weekend work. The calendar must come from the plan, not be hard-coded as Monday to Friday.
- **Point values.** The defaults in 7.3 are placeholders. They need to be confirmed with a site manager before the demo.
- **Over-performance offset.** Daily alerts never offset, but cumulative metrics do. This needs to be confirmed with the team.
- **Attribution is advisory.** It must always show its confidence and citations, and it never becomes a statement of liability.
