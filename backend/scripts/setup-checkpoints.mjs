// Creates the LangGraph checkpoint tables and lets the capture agent use them.
// Run once (and after upgrading @langchain/langgraph-checkpoint-postgres) with admin rights:
//   MIGRATION_DATABASE_URL=... npm run setup:checkpoints
import pg from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const toPg = (u) => u?.replace(/^postgresql\+\w+:\/\//, "postgresql://");
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url).pathname, quiet: true });
const raw = toPg(process.env.MIGRATION_DATABASE_URL);
if (!raw) throw new Error("MIGRATION_DATABASE_URL is not set");
const schema = process.env.AGENT_CHECKPOINT_SCHEMA ?? "sitemate_checkpoints";
const url = new URL(raw);
const noSsl = url.searchParams.get("sslmode") === "disable";
url.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: url.toString(), ssl: noSsl ? false : { rejectUnauthorized: false } });

await new PostgresSaver(pool, undefined, { schema }).setup();
const role = "sitemate_agent";
const { rowCount } = await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
if (rowCount) {
  await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${role}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${role}`);
}
console.log(`Checkpoint tables ready in schema "${schema}".`);
await pool.end();
