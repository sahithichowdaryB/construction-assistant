# SiteMate: run it and the "day in the life" demo

## 1. Set up (once)

```bash
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env                      # fill in the database URLs and ANTHROPIC_API_KEY
.venv/bin/alembic upgrade head            # migrations 0001 … 0016
.venv/bin/python provision_reader.py && .venv/bin/python provision_agent.py && .venv/bin/python provision_ops.py
.venv/bin/python seed_riverside.py        # Riverside demo project (RIV), baseline rev 1
.venv/bin/python -m documents.ingest      # parse and summarise the 29 Riverside records
.venv/bin/python seed_demo_users.py       # foreman, site manager and approver accounts
```

Optional speech-to-text: `cd backend/whisper-server && python -m venv .venv && .venv/bin/pip install -r requirements.txt &&
.venv/bin/python server.py`, then `WHISPER_BASE_URL=http://127.0.0.1:8001` in `backend/.env`.

Or everything in containers: `docker compose up --build` (add `--profile voice` for local Whisper).

## 2. Run

```bash
cd backend && .venv/bin/python -m uvicorn main:app --port 8000     # API
cd backend && .venv/bin/python worker.py                           # background jobs (evaluations, auto-drafts, reports)
cd frontend && NEXT_PUBLIC_USE_FIXTURES=false npm run dev           # web app on :3000
```

`GET /health/capabilities` shows whether the model, speech-to-text and the worker are available; managers see a banner
when the worker is offline. Reset the demo with `backend/.venv/bin/python reset_demo_workflow.py`.

## 3. A day in the life (Riverside, 10 November 2026, replay clock in the header)

| Clock | Who | What to do | What SiteMate does |
|---|---|---|---|
| 07:30 | Site manager | Open **Shortfalls & notices** and **Performance** | Yesterday 92/100 m³; SPI, forecast, ledger, milestones |
| 07:35 | Site manager | **Ask SiteMate**: "What does GroundWorks owe us?" | Cited answer: backup excavator plan due 12:00 (M07) |
| 10:15 | Foreman | **Report a problem** → record V01 (or type it) | Asks for the category, fills EX-02 from the register (inferred), speaker reviews, saved |
| 11:00 | Site manager | **Write with SiteMate**: "excavator idle since 10 am, three workers stopped", additional cost notice | Cited draft; rates stay `[MISSING]`, no amount invented |
| 17:30 | Site manager | **Documents** → R10 → **Quantities** → Confirm signed rows | Observations written; the day is evaluated (EXC-B 65/100, −35 %, red, FND-B at risk) |
| 17:35 | (worker) | – | Private delay-notice draft created automatically for the shortfall |
| 17:45 | Site manager | Open the auto-drafted notice: leave out the contract clause with a reason, send for approval | New version; approver sees the reason |
| 18:00 | Approver | **Review queue** → approve → download PDF / Word | Stored export, identical bytes on every download (SHA-256 shown) |
| 18:15 | Site manager | Day view → **Daily site report** → add/confirm appointments → Draft the report | Cited report from figures, notes, photos and appointments; review and export like a notice |

## 4. Verify

```bash
cd backend
TEST_DATABASE_URL=postgresql+psycopg://postgres@127.0.0.1:54329/sm .venv/bin/pytest -q tests ../ai-agent/tests   # scratch DB only
.venv/bin/python verify_riverside.py && .venv/bin/python verify_documents.py
.venv/bin/python verify_performance.py --write && .venv/bin/python verify_workflows.py --write
cd ../frontend && npm run lint && npx tsc --noEmit
```

Everything here is drafting support only — not legal advice. Final review lies with the site manager/company.
