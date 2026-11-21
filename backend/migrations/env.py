from alembic import context

from database import engine_for

with engine_for("MIGRATION_DATABASE_URL").begin() as connection:
    connection.exec_driver_sql("CREATE SCHEMA IF NOT EXISTS sitemate")
    context.configure(connection=connection, version_table_schema="sitemate")
    with context.begin_transaction():
        context.run_migrations()
