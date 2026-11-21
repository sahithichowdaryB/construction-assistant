"""Idempotent DDL for sign-in (used by migration 0007_auth_sessions).

Accounts live in Supabase Auth (`auth.users`). A project member is linked to an account through
`project_members.auth_user_id`; the static `token_hash` stays for scripts and the demo proxy.
Passwords are checked inside the database by `sitemate.verify_password`, so no API login ever
reads `auth.users`. Sessions store only the SHA-256 of the bearer token.

Run directly with `python auth_schema.py` (or `--downgrade`).
"""

UPGRADE = [
    "ALTER TABLE sitemate.project_members ADD COLUMN IF NOT EXISTS auth_user_id uuid "
    "REFERENCES auth.users(id) ON DELETE CASCADE",
    "ALTER TABLE sitemate.project_members ADD COLUMN IF NOT EXISTS display_name text",
    # Members who sign in with an account need no static token.
    "ALTER TABLE sitemate.project_members ALTER COLUMN token_hash DROP NOT NULL",
    """DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_members_identity_check') THEN
           ALTER TABLE sitemate.project_members ADD CONSTRAINT project_members_identity_check
             CHECK (token_hash IS NOT NULL OR auth_user_id IS NOT NULL);
         END IF;
       END $$""",
    """CREATE UNIQUE INDEX IF NOT EXISTS project_members_auth_user
         ON sitemate.project_members (project_id, auth_user_id) WHERE auth_user_id IS NOT NULL""",
    """CREATE TABLE IF NOT EXISTS sitemate.sessions (
         token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
         auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
         email text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         expires_at timestamptz NOT NULL,
         revoked_at timestamptz,
         user_agent text,
         CHECK (expires_at > created_at))""",
    "CREATE INDEX IF NOT EXISTS sessions_auth_user ON sitemate.sessions (auth_user_id)",
    # Single-use, short-lived password reset links (only the SHA-256 of the token is stored).
    """CREATE TABLE IF NOT EXISTS sitemate.password_resets (
         token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
         auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
         created_at timestamptz NOT NULL DEFAULT now(),
         expires_at timestamptz NOT NULL,
         used_at timestamptz,
         CHECK (expires_at > created_at))""",
    "CREATE INDEX IF NOT EXISTS password_resets_auth_user ON sitemate.password_resets (auth_user_id)",
    # Returns the account id when the email and password match an active, confirmed account.
    """CREATE OR REPLACE FUNCTION sitemate.verify_password(p_email text, p_password text)
         RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
           SELECT u.id FROM auth.users u
           WHERE lower(u.email) = lower(p_email)
             AND u.encrypted_password IS NOT NULL
             AND u.encrypted_password = extensions.crypt(p_password, u.encrypted_password)
             AND u.email_confirmed_at IS NOT NULL
             AND u.deleted_at IS NULL
             AND (u.banned_until IS NULL OR u.banned_until < now())
           LIMIT 1
         $$""",
    "REVOKE ALL ON FUNCTION sitemate.verify_password(text, text) FROM PUBLIC",
    # Supabase's API roles must never reach sessions or the password check.
    """DO $$ DECLARE r text; BEGIN
         FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
           IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
             EXECUTE 'REVOKE ALL ON sitemate.sessions FROM ' || quote_ident(r);
             EXECUTE 'REVOKE ALL ON sitemate.password_resets FROM ' || quote_ident(r);
             EXECUTE 'REVOKE ALL ON FUNCTION sitemate.verify_password(text, text) FROM ' || quote_ident(r);
           END IF;
         END LOOP;
       END $$""",
    # The read-only API login resolves sessions and reads the approval workflow.
    """DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitemate_reader') THEN
           GRANT SELECT ON sitemate.sessions, sitemate.drafts, sitemate.draft_versions, sitemate.reviews
             TO sitemate_reader;
         END IF;
       END $$""",
]

DOWNGRADE = [
    "DROP TABLE IF EXISTS sitemate.password_resets",
    "DROP FUNCTION IF EXISTS sitemate.verify_password(text, text)",
    "DROP TABLE IF EXISTS sitemate.sessions",
    "DROP INDEX IF EXISTS sitemate.project_members_auth_user",
    "ALTER TABLE sitemate.project_members DROP CONSTRAINT IF EXISTS project_members_identity_check",
    "DELETE FROM sitemate.project_members WHERE token_hash IS NULL",
    "ALTER TABLE sitemate.project_members ALTER COLUMN token_hash SET NOT NULL",
    "ALTER TABLE sitemate.project_members DROP COLUMN IF EXISTS display_name, DROP COLUMN IF EXISTS auth_user_id",
]


def main():
    import sys

    from dotenv import load_dotenv

    load_dotenv()
    from database import engine_for

    statements = DOWNGRADE if "--downgrade" in sys.argv else UPGRADE
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        for statement in statements:
            conn.exec_driver_sql(statement)
    print(f"Applied {len(statements)} auth schema statements.")


if __name__ == "__main__":
    main()
