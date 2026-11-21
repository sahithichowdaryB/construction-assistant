import fs from "node:fs";
import path from "node:path";
import { BACKEND_ROOT } from "../config.js";
import { query } from "../database/pool.js";

/** Project facts Claude may reference by ID ("allowed IDs"), loaded once per capture. */
export async function loadProjectContext(projectId) {
  const [project] = await query(
    "SELECT id, name, timezone, threshold, high_threshold FROM sitemate.projects WHERE id=$1", [projectId]);
  if (!project) throw new Error(`Unknown project ${projectId}`);
  const activities = await query(
    "SELECT code, name, zone, unit, contractor_id FROM sitemate.activities WHERE project_id=$1 ORDER BY code",
    [projectId]);
  const equipment = await query(
    "SELECT id, description, owner_id FROM sitemate.equipment WHERE project_id=$1 ORDER BY id", [projectId]);
  return { project, activities, equipment };
}

const FILE_RULES = path.join(BACKEND_ROOT, "rules/business_rules.json");

/** Business rules live in sitemate.business_rules (migration 0003); the JSON seed is a fallback. */
export async function loadBusinessRules(eventTypes) {
  try {
    return await query(
      `SELECT rule_key, event_type, required_fields, ask_if_missing, description
       FROM sitemate.business_rules WHERE active AND (event_type = ANY($1) OR event_type='*') ORDER BY rule_key`,
      [eventTypes]);
  } catch (err) {
    if (err.code !== "42P01") throw err; // undefined_table: migration not applied yet
    console.warn("sitemate.business_rules missing; using rules/business_rules.json");
    return JSON.parse(fs.readFileSync(FILE_RULES, "utf8"))
      .filter((r) => r.event_type === "*" || eventTypes.includes(r.event_type));
  }
}
