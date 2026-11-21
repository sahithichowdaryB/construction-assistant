import { SEVERITIES, severityRank } from "./taxonomy.js";

const HARD_CRITICAL = ["hospitalisation", "fatality", "structural_collapse"];
const clampRank = (r) => Math.max(0, Math.min(SEVERITIES.length - 1, r));
const maxLevel = (...levels) => levels.filter(Boolean).reduce((a, b) => (severityRank(b) > severityRank(a) ? b : a), "low");

/**
 * Rule-based severity. Pure: every input is passed in so the matrix is unit-testable.
 *  base        severity hint of the event type, else the category default
 *  floor       hard rules; nothing (not even the LLM) may go below it
 *  escalators  +1 level each, capped at high unless a hard rule already put the floor higher
 */
export function ruleSeverity({
  base, category, injuredCount = 0, flags = [], reporterCount = 1, successorsAtRisk = 0,
  workersAffected = 0, openHours = 0, escalateAfterHours = 24,
}) {
  const hard = [];
  let floor = "low";
  const raise = (level, why) => { hard.push(why); floor = maxLevel(floor, level); };
  if (injuredCount > 0) raise("high", "injured_count > 0");
  if (flags.some((f) => HARD_CRITICAL.includes(f))) raise("critical", "hospitalisation, fatality or structural collapse");
  if (category === "safety" && flags.includes("occupied_zone")) raise("medium", "safety issue in an occupied zone");
  if (flags.includes("spill_to_drain")) raise("high", "spill reached a drain");

  const escalators = [];
  if (reporterCount >= 3) escalators.push("reporter_count >= 3");
  if (successorsAtRisk > 0) escalators.push("critical-path successors within 48h");
  if (workersAffected >= 10) escalators.push("workers_affected >= 10");
  if (flags.includes("sole_access")) escalators.push("sole means of access");
  if (openHours > escalateAfterHours) escalators.push(`open longer than ${escalateAfterHours}h`);

  const pre = maxLevel(base ?? "low", floor);
  const cap = maxLevel("high", floor);
  const level = severityRank(pre) >= severityRank(cap)
    ? pre
    : SEVERITIES[Math.min(severityRank(pre) + escalators.length, severityRank(cap))];
  return { level, floor, base: base ?? "low", hard, escalators };
}

/** LLM may move the rule result by at most one level, never below the floor, never above max(high, floor). */
export function applyLlmAdjustment(rule, adjustment = 0) {
  const step = Math.max(-1, Math.min(1, Math.trunc(Number(adjustment) || 0)));
  const ceiling = severityRank(maxLevel("high", rule.floor));
  const wanted = clampRank(severityRank(rule.level) + step);
  const rank = Math.max(severityRank(rule.floor), Math.min(wanted, Math.max(ceiling, severityRank(rule.level))));
  return { level: SEVERITIES[rank], adjustment: rank - severityRank(rule.level) };
}
