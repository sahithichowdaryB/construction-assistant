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

## Voice capture agent (Node.js + LangChain + Claude)

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

Setup (adds the `business_rules` table and a `sitemate_agent` role with SELECT + INSERT on capture tables):

```powershell
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe provision_agent.py     # needs AGENT_DATABASE_URL in .env
npm install
npm start                                       # http://127.0.0.1:4000
```

Endpoints (bearer token of a `contributor`, `manager` or `approver` member):

- `POST /projects/RIV/captures` — multipart `audio` file (or form/JSON field `transcript`), optional `recorded_at`
  (ISO 8601 with offset). Returns `201 saved`, or `202 needs_input` with `thread_id` and `questions`.
- `POST /projects/RIV/captures/{thread_id}/answers` — `{"answers":[{"id":"q1","answer":"EX-02"}]}`.
  Answer `unknown` to record a field as a gap.

```bash
curl -H "Authorization: Bearer $TOKEN" -F audio=@../data/riverside-demo/uploads/voice/V01.wav \
     -F recorded_at=2026-11-10T10:05:00+01:00 http://127.0.0.1:4000/projects/RIV/captures
```

Business rules are rows in `sitemate.business_rules` (seeded from `rules/business_rules.json`); edit rows to
change what the agent requires or asks. Paused captures are held in memory and lost on restart; swap in
`@langchain/langgraph-checkpoint-postgres` before production.
