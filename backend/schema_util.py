"""Helpers that build idempotent DDL statements for the *_schema.py modules (migrations 0010 onward).

Each helper returns one SQL string that can run any number of times, so a schema module can be applied directly
(`python -m <module>`) and its Alembic migration then only records the version.
"""


def keep_revision(table: str) -> str:
    """Rows of `table` can never be updated or deleted (sitemate.keep_revision raises): history is append-only."""
    return f"""DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'keep_revision'
                     AND tgrelid = 'sitemate.{table}'::regclass) THEN
        CREATE TRIGGER keep_revision BEFORE UPDATE OR DELETE ON sitemate.{table}
          FOR EACH ROW EXECUTE FUNCTION sitemate.keep_revision();
      END IF;
    END $$"""


def add_constraint(table: str, name: str, definition: str) -> str:
    """ALTER TABLE ... ADD CONSTRAINT, only when no constraint of that name exists yet."""
    return f"""DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '{name}'
                     AND conrelid = 'sitemate.{table}'::regclass) THEN
        ALTER TABLE sitemate.{table} ADD CONSTRAINT {name} {definition};
      END IF;
    END $$"""


def replace_check(table: str, name: str, values: tuple[str, ...], column: str, *, valid: bool = False) -> list[str]:
    """Drop and re-add an IN-list CHECK. NOT VALID by default, so old rows are never rejected; new rows are checked."""
    listed = ",".join(f"'{v}'" for v in values)
    return [f"ALTER TABLE sitemate.{table} DROP CONSTRAINT IF EXISTS {name}",
            f"ALTER TABLE sitemate.{table} ADD CONSTRAINT {name} CHECK ({column} IN ({listed}))"
            + ("" if valid else " NOT VALID")]


def grant(role: str, privileges: str, tables: tuple[str, ...]) -> str:
    """GRANT when the role exists (provisioned logins); a no-op on databases without it."""
    names = ", ".join(f"sitemate.{t}" for t in tables)
    return f"""DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
        GRANT {privileges} ON {names} TO {role};
      END IF;
    END $$"""


def apply(statements: list[str], setting: str = "MIGRATION_DATABASE_URL") -> int:
    """Run the statements in one transaction (used by each module's command line)."""
    from database import engine_for

    with engine_for(setting).begin() as conn:
        for statement in statements:
            conn.exec_driver_sql(statement)
    return len(statements)


def main(upgrade: list[str], downgrade: list[str], label: str) -> None:
    import sys

    statements = downgrade if "--downgrade" in sys.argv else upgrade
    print(f"Applied {apply(statements)} {label} schema statements.")
