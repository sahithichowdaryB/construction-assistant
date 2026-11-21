import fs from "node:fs";
import pg from "pg";
import { config } from "../config.js";

if (!config.databaseUrl) throw new Error("AGENT_DATABASE_URL is not set (see backend/.env.example)");

// pg lets URL ssl params override the `ssl` option, so strip them and configure TLS here.
const url = new URL(config.databaseUrl);
const sslDisabled = url.searchParams.get("sslmode") === "disable";
url.searchParams.delete("sslmode");
const caPath = process.env.AGENT_DATABASE_CA_CERT; // Supabase: Settings → Database → SSL certificate

export const pool = new pg.Pool({
  connectionString: url.toString(),
  max: 5,
  connectionTimeoutMillis: 10_000,
  ssl: sslDisabled ? false
    : caPath ? { ca: fs.readFileSync(caPath, "utf8"), rejectUnauthorized: true }
    : { rejectUnauthorized: false }, // encrypted but unverified; set AGENT_DATABASE_CA_CERT to verify
});

export const query = (text, params) => pool.query(text, params).then((r) => r.rows);

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
