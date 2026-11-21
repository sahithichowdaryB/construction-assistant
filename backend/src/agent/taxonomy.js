import fs from "node:fs";
import path from "node:path";
import { BACKEND_ROOT } from "../config.js";
import { query } from "../database/pool.js";

const FILE = path.join(BACKEND_ROOT, "rules/event_taxonomy.json");
export const SEED = JSON.parse(fs.readFileSync(FILE, "utf8"));

export const SEVERITIES = ["low", "medium", "high", "critical"];
export const severityRank = (s) => SEVERITIES.indexOf(s);

/** Build lookup helpers from category and type rows (DB rows or the JSON seed). */
export function buildTaxonomy(categories, types) {
  const cats = new Map(categories.filter((c) => c.active !== false).map((c) => [c.key, c]));
  const typeRows = types.filter((t) => t.active !== false).map((t) => ({ ...t, category: t.category ?? t.category_key }));
  const typeMap = new Map(typeRows.map((t) => [t.key, t]));
  return {
    categories: [...cats.values()].sort((a, b) => a.sort_order - b.sort_order),
    types: typeRows,
    category: (key) => cats.get(key) ?? null,
    type: (key) => typeMap.get(key) ?? null,
    typesOf: (categoryKey) => typeRows.filter((t) => t.category === categoryKey),
    /** A valid (category, type) pair: unknown category -> general; type outside the category -> its first type. */
    normalise(categoryKey, typeKey) {
      const category = cats.has(categoryKey) ? categoryKey : typeMap.get(typeKey)?.category ?? "general";
      const inCategory = typeRows.filter((t) => t.category === category);
      const type = inCategory.some((t) => t.key === typeKey) ? typeKey : inCategory[0]?.key ?? "other";
      return { category, event_type: type };
    },
    createsIncident: (categoryKey) => Boolean(cats.get(categoryKey)?.creates_incident),
  };
}

export const seedTaxonomy = () => buildTaxonomy(SEED.categories, SEED.types);

let cache = { at: 0, value: null };

/** Global rows plus the project's overrides (same key wins); falls back to the JSON seed before migration 0005. */
export async function loadTaxonomy(projectId) {
  if (cache.value && cache.projectId === projectId && Date.now() - cache.at < 60_000) return cache.value;
  let value;
  try {
    const merge = (rows) => [...new Map(rows.sort((a, b) => (a.project_id ? 1 : 0) - (b.project_id ? 1 : 0))
      .map((r) => [r.key, r])).values()];
    const cats = merge(await query(
      "SELECT * FROM sitemate.event_categories WHERE project_id IS NULL OR project_id=$1", [projectId]));
    const types = merge(await query(
      "SELECT * FROM sitemate.event_types WHERE project_id IS NULL OR project_id=$1", [projectId]));
    value = buildTaxonomy(cats, types);
  } catch (err) {
    if (err.code !== "42P01") throw err;
    value = seedTaxonomy();
  }
  cache = { at: Date.now(), value, projectId };
  return value;
}
