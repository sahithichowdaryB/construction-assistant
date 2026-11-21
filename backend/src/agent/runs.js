import { createHash } from "node:crypto";
import { query } from "../database/pool.js";

export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

/** Audit row for one LLM step (agent_runs). Never throws: auditing must not break a capture. */
export async function recordRun({ projectId, agent, captureId, incidentId, model, input, output, status = "ok", latencyMs }) {
  try {
    await query(
      `INSERT INTO sitemate.agent_runs (project_id, agent, capture_id, incident_id, model, input_digest, output, status, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [projectId, agent, captureId ?? null, incidentId ?? null, model ?? null, digest(input ?? null),
        output === undefined ? null : JSON.stringify(output), status, latencyMs ?? null]);
  } catch (err) {
    console.warn(`agent_runs insert failed: ${err.message}`);
  }
}

/** Run `fn`, record the outcome with latency, and rethrow failures after recording them. */
export async function audited(meta, fn) {
  const started = Date.now();
  try {
    const output = await fn();
    void recordRun({ ...meta, output, latencyMs: Date.now() - started });
    return output;
  } catch (err) {
    // Not awaited: callers may hold a pooled connection in a transaction, and waiting for a second one could deadlock.
    void recordRun({ ...meta, output: { error: err.message }, status: "failed", latencyMs: Date.now() - started });
    throw err;
  }
}
