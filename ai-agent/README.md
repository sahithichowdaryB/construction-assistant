# Incident evidence agent

Given an incident, finds the passages (voice transcripts, diaries, minutes, emails, reports) where someone states a
cause, weights them by who said it, and returns a cited finding with a confidence score. Supervisor-side sources
(foreman, site manager, signed reports) outrank external parties. If nobody states a reason the result is
`undetermined` with a low score and a list of gaps.

Flow (`app/orchestrator.py`): read-only gather (`tools.py`) -> LLM extracts claims + candidate causes -> code drops
claims whose quote is not in the passage -> deterministic score cards (`scoring.py`, advice only) -> LLM decides
status, confidence and reasoning -> code validates citations (one retry, else `needs_review`) -> `persist.py`.

## Configure
`backend/.env`: `LLM_PROVIDER=gemini`, `LLM_MODEL=gemini-2.5-flash`, `GEMINI_API_KEY=<your key>`.
New provider = one adapter class + one branch in `app/llm.py:get_llm()`.

## Run (from `backend/`, venv active)
- Tests (no DB, no key): `cd ../ai-agent && python -m pytest -q tests`
- API: `POST /projects/{id}/incidents/{incident_id}/reasoning[?as_of=ISO]` (manager/approver; runs the agent now: DB read +
  LLM calls, ~10 s, saves a new version unless the finding is identical) and
  `GET /projects/{id}/incidents/{incident_id}/reasoning[?as_of=ISO]` (latest saved)
- CLI: `cd ../ai-agent && python -m app RIV 4d1b3a3d-752e-5157-a01e-4447dcc06bd7 [--as-of ISO]`
- Dummy cases: `python seed_agent_demo.py` (project TST, needs `TST_DEMO_TOKEN`); `--clean` removes it.
