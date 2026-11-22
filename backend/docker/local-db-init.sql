-- Local development database only (docker compose --profile localdb). Supabase provides these in the hosted setup:
-- the `extensions` schema (pgcrypto, pg_trgm) and the `auth.users` table that sign-in links project members to.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, encrypted_password text,
  email_confirmed_at timestamptz, deleted_at timestamptz, banned_until timestamptz, raw_user_meta_data jsonb,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
