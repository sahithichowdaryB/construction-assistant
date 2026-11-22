# SiteMate — AI site manager assistant (Challenge B)

Voice/text capture, daily report analysis against the plan, cited summaries of diaries, minutes and emails, notices
drafted from keywords or automatically on deviations, daily report drafts, Ask SiteMate (cited chat), and
human-in-the-loop review with PDF/Word export.

- `backend/` FastAPI + Postgres (`sitemate` schema, Alembic migrations), worker (`worker.py`)
- `ai-agent/` capture pipeline, incident root-cause agent, action planner, job worker
- `frontend/` Next.js web app (mobile-first)
- `data/`, `mock_data/` demo records and plans

Start here: [DEMO.md](DEMO.md) (setup, run, demo script, verification) and [backend/README.md](backend/README.md).
Status and plan: [PROJECT_STATUS_GAP_ANALYSIS_AND_IMPLEMENTATION_PLAN.md](PROJECT_STATUS_GAP_ANALYSIS_AND_IMPLEMENTATION_PLAN.md).

Drafting support only — not legal advice. Final review lies with the site manager/company.
