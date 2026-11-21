/** Normalising "the hoist", "lift 2", "goods lift" so reports about the same asset share one key. */

const KINDS = new Map([
  ["lift", "lift"], ["hoist", "lift"], ["elevator", "lift"], ["crane", "crane"], ["excavator", "excavator"],
  ["digger", "excavator"], ["generator", "generator"], ["pump", "pump"], ["compressor", "compressor"],
  ["mixer", "mixer"], ["loader", "loader"], ["dumper", "dumper"], ["forklift", "forklift"],
  ["telehandler", "telehandler"], ["scaffold", "scaffold"], ["boiler", "boiler"],
]);
const FILLER = new Set(["the", "a", "an", "no", "not", "working", "broken", "down", "site", "main"]);

/**
 * Equipment-register id when known ("eq:EX-02"), else a slug "kind:qualifier" ("lift:goods").
 * Register matching is the reliable path; the slug is a best-effort fallback for unregistered assets.
 */
export function normalizeAssetKey({ asset_key, equipment_id_spoken } = {}, register = []) {
  const ids = new Map(register.map((e) => [e.id.toLowerCase(), e.id]));
  for (const candidate of [equipment_id_spoken, asset_key?.replace(/^eq:/i, "")]) {
    const hit = candidate && ids.get(candidate.trim().toLowerCase());
    if (hit) return `eq:${hit}`;
  }
  const raw = asset_key?.replace(/^eq:/i, "").trim();
  if (!raw) return null;
  const tokens = raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter((t) => t && !FILLER.has(t)).map((t) => t.replace(/^l(\d+)$/, "$1"));
  const kindToken = tokens.find((t) => KINDS.has(t));
  if (!kindToken) return tokens.join("-") || null;
  const qualifiers = tokens.filter((t) => t !== kindToken && !KINDS.has(t)).sort();
  return qualifiers.length ? `${KINDS.get(kindToken)}:${qualifiers.join("-")}` : KINDS.get(kindToken);
}

const normZone = (z) => z?.replace(/^zones?\s+/i, "").trim().toLowerCase() || null;
export { normZone };

/**
 * "category:part:part" built from the category's grouping_fields. Missing parts fall back to zone + event type,
 * then to the event type alone, so every event gets a stable key.
 */
export function clusterKey(category, event, groupingFields = []) {
  const value = (field) => {
    if (field === "site") return "site";
    if (field === "zone") return normZone(event.zone);
    if (field === "material") return event.material?.trim().toLowerCase().replace(/\s+/g, "-") ?? null;
    return event[field] ?? null;
  };
  let parts = groupingFields.map(value);
  if (!groupingFields.length || parts.some((p) => !p)) parts = [normZone(event.zone), event.event_type].filter(Boolean);
  if (!parts.length) parts = [event.event_type ?? "unknown"];
  return `${category}:${parts.join(":")}`;
}

const STOP = new Set(["the", "and", "for", "that", "this", "with", "are", "was", "but", "can", "still", "just", "from",
  "have", "has", "our", "not", "out", "all", "any", "some", "there", "they", "its", "been", "again"]);
const words = (t) => new Set((String(t ?? "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)));

/** Jaccard similarity of content words; stands in for pg_trgm so no extension is required. */
export function textSimilarity(a, b) {
  const x = words(a); const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}
