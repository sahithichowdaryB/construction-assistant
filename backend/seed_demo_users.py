"""Create the three Riverside demo accounts in Supabase Auth and give each one project role.

    python seed_demo_users.py                    # create missing accounts, print new passwords
    python seed_demo_users.py --reset-passwords  # also issue new passwords for existing accounts

Accounts are rows in auth.users (+ auth.identities, so Supabase Auth also accepts them) with a
bcrypt password hash. Each is linked to sitemate.project_members through auth_user_id. Passwords
are random and printed once; they are never written to a file.
"""

import json
import secrets
import string
import sys
import uuid

from sqlalchemy import text

from database import engine_for

PROJECT = "RIV"
# (email, member_id, role, display name)
DEMO_USERS = [
    ("foreman@riverside.example", "riv-foreman", "contributor", "Zone B foreman"),
    ("manager@riverside.example", "riv-site-manager", "manager", "Sam Reed"),
    ("approver@riverside.example", "riv-approver", "approver", "Riverside approver"),
]
NIL_INSTANCE = "00000000-0000-0000-0000-000000000000"


def new_password():
    # 16 characters: letters and digits, at least one of each class, easy to type.
    alphabet = string.ascii_letters + string.digits
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(16))
        if any(c.islower() for c in pw) and any(c.isupper() for c in pw) and any(c.isdigit() for c in pw):
            return pw


def main():
    reset = "--reset-passwords" in sys.argv
    issued = []
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        for email, member_id, role, name in DEMO_USERS:
            user_id = conn.scalar(text("SELECT id FROM auth.users WHERE lower(email)=lower(:e)"), {"e": email})
            password = None
            if user_id is None:
                user_id = uuid.uuid4()
                password = new_password()
                conn.execute(text("""
                    INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change, email_change_token_new)
                    VALUES (:instance, :id, 'authenticated', 'authenticated', :email,
                        extensions.crypt(:pw, extensions.gen_salt('bf')), now(),
                        CAST(:app AS jsonb), CAST(:meta AS jsonb), now(), now(), '', '', '', '')
                """), {"instance": NIL_INSTANCE, "id": user_id, "email": email, "pw": password,
                       "app": json.dumps({"provider": "email", "providers": ["email"]}),
                       "meta": json.dumps({"full_name": name, "project": PROJECT, "role": role})})
                conn.execute(text("""
                    INSERT INTO auth.identities (provider_id, user_id, identity_data, provider,
                        last_sign_in_at, created_at, updated_at)
                    VALUES (:pid, :uid, CAST(:data AS jsonb), 'email', now(), now(), now())
                """), {"pid": str(user_id), "uid": user_id,
                       "data": json.dumps({"sub": str(user_id), "email": email, "email_verified": True})})
            elif reset:
                password = new_password()
                conn.execute(text("""UPDATE auth.users SET encrypted_password =
                        extensions.crypt(:pw, extensions.gen_salt('bf')), updated_at = now() WHERE id = :id"""),
                             {"pw": password, "id": user_id})
                conn.execute(text("UPDATE sitemate.sessions SET revoked_at = now() "
                                  "WHERE auth_user_id = :id AND revoked_at IS NULL"), {"id": user_id})
            conn.execute(text("""
                INSERT INTO sitemate.project_members (project_id, member_id, token_hash, role, auth_user_id, display_name)
                VALUES (:p, :m, NULL, :role, :uid, :name)
                ON CONFLICT (project_id, member_id) DO UPDATE
                   SET role = EXCLUDED.role, auth_user_id = EXCLUDED.auth_user_id, display_name = EXCLUDED.display_name
            """), {"p": PROJECT, "m": member_id, "role": role, "uid": user_id, "name": name})
            issued.append((email, role, name, password))

    print(f"Riverside ({PROJECT}) demo accounts:")
    for email, role, name, password in issued:
        shown = password if password else "(unchanged; use --reset-passwords for a new one)"
        print(f"  {role:12} {name:20} {email:30} {shown}")


if __name__ == "__main__":
    main()
