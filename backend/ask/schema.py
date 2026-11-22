"""Idempotent DDL for Ask SiteMate conversations (migration 0015_ask).

ask_threads belong to one member; ask_messages are immutable (the question, the cited answer, the clock it used and
which read tools ran). Tool results are not stored, only their names, arguments and result counts.

Run directly with `python -m ask.schema` (or `--downgrade`).
"""

from schema_util import grant, keep_revision, main

UPGRADE = [
    """CREATE TABLE IF NOT EXISTS sitemate.ask_threads (
         project_id text NOT NULL REFERENCES sitemate.projects,
         id uuid NOT NULL DEFAULT gen_random_uuid(),
         member_id text NOT NULL, title text,
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (project_id, id),
         FOREIGN KEY (project_id, member_id) REFERENCES sitemate.project_members)""",
    "CREATE INDEX IF NOT EXISTS ask_threads_member ON sitemate.ask_threads (project_id, member_id, created_at)",
    """CREATE TABLE IF NOT EXISTS sitemate.ask_messages (
         project_id text NOT NULL, thread_id uuid NOT NULL, seq integer NOT NULL CHECK (seq > 0),
         role text NOT NULL CHECK (role IN ('user','assistant')),
         content text NOT NULL, answer jsonb,
         citations jsonb NOT NULL DEFAULT '[]', tool_calls jsonb NOT NULL DEFAULT '[]',
         as_of timestamptz NOT NULL,
         status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','no_evidence','refused','failed')),
         model text, latency_ms integer,
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (project_id, thread_id, seq),
         FOREIGN KEY (project_id, thread_id) REFERENCES sitemate.ask_threads)""",
    keep_revision("ask_messages"),
    grant("sitemate_reader", "SELECT", ("ask_threads", "ask_messages")),
]

DOWNGRADE = [
    "DROP TABLE IF EXISTS sitemate.ask_messages",
    "DROP TABLE IF EXISTS sitemate.ask_threads",
]

if __name__ == "__main__":
    main(UPGRADE, DOWNGRADE, "ask")
