import { config } from "../../config.js";
import { clusterKey, normZone, textSimilarity } from "../assets.js";
import { applyLlmAdjustment, ruleSeverity } from "../severity.js";
import { severityRank } from "../taxonomy.js";

/** Categories whose incidents may describe the same real-world problem ("lift down" can be utilities or equipment). */
const COMPATIBLE = { utilities: ["equipment"], equipment: ["utilities"] };
const RESOLVING = new Set(["repair_release", "issue_resolved"]);

export const linkTypeFor = (eventType) => (RESOLVING.has(eventType) ? "resolution" : "update");
export const isStatusUpdate = (category) => category === "status_update";

const hoursBetween = (a, b) => Math.abs(new Date(a) - new Date(b)) / 36e5;
const round3 = (n) => Math.round(n * 1000) / 1000;

/** Weighted similarity between a new event and an open incident (all signals 0..1). */
export function scoreCandidate(event, incident, windowHours, cfg = config.correlation) {
  const same = (a, b) => (a && b && a === b ? 1 : 0);
  const signals = {
    asset: same(event.asset_key, incident.asset_key),
    type: same(event.event_type, incident.event_type),
    zone: same(normZone(event.zone), normZone(incident.zone)),
    activity: same(event.activity_code, incident.activity_code),
    time: windowHours > 0 ? Math.max(0, 1 - hoursBetween(event.occurred_at, incident.last_reported_at) / windowHours) : 0,
    text: textSimilarity(event.summary, incident.summary),
  };
  const score = Object.entries(cfg.weights).reduce((sum, [k, w]) => sum + w * signals[k], 0);
  return { score: round3(score), signals };
}

/** Candidates must share an asset, zone or activity, or read alike; best five by score. */
export function rankCandidates(event, incidents, windowHours, cfg = config.correlation) {
  return incidents
    .map((incident) => ({ incident, ...scoreCandidate(event, incident, windowHours, cfg),
      clusterMatch: Boolean(event.cluster_key && incident.cluster_key?.split("#")[0] === event.cluster_key) }))
    .filter((c) => c.signals.asset || c.signals.zone || c.signals.activity || c.signals.text >= cfg.textMin)
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.maxCandidates);
}

/** auto-link when clearly the same problem, adjudicate when plausible, otherwise a new incident. */
export function decide(ranked, cfg = config.correlation) {
  const top = ranked[0];
  if (!top) return { action: "new" };
  if (top.score >= cfg.autoLink && (top.signals.asset || top.clusterMatch)) {
    return { action: "link", candidate: top, reason: `auto-linked (score ${top.score})` };
  }
  const viable = ranked.filter((c) => c.score >= cfg.adjudicate);
  return viable.length ? { action: "adjudicate", candidates: viable } : { action: "new" };
}

const OPEN = "i.status IN ('open','monitoring') AND i.merged_into_id IS NULL";

async function fetchCandidates(db, projectId, event, categories, windowHours) {
  const { rows } = await db.query(
    `SELECT i.id, i.category, i.event_type, i.summary, i.zone, i.asset_key, i.activity_code, i.cluster_key,
            i.status, i.severity, i.last_reported_at, i.report_count
     FROM sitemate.incidents i
     WHERE i.project_id=$1 AND ${OPEN} AND ($2::text[] IS NULL OR i.category = ANY($2))
       AND i.last_reported_at >= $3::timestamptz - make_interval(hours => $4::int)
     ORDER BY i.last_reported_at DESC LIMIT 50`,
    [projectId, categories, event.occurred_at, windowHours]);
  return rows;
}

async function recentEvents(db, projectId, incidentIds) {
  const { rows } = await db.query(
    `SELECT ie.incident_id, ie.link_type, ie.unlinked_at, e.summary, e.recorded_at
     FROM sitemate.incident_events ie JOIN sitemate.events e ON (e.project_id, e.id) = (ie.project_id, ie.event_id)
     WHERE ie.project_id=$1 AND ie.incident_id = ANY($2) ORDER BY e.recorded_at DESC`, [projectId, incidentIds]);
  const by = new Map();
  for (const r of rows) {
    const entry = by.get(r.incident_id) ?? { linked: [], unlinked: [] };
    (r.unlinked_at ? entry.unlinked : entry.linked).push({ summary: r.summary, link_type: r.link_type, at: r.recorded_at });
    by.set(r.incident_id, entry);
  }
  return by;
}

async function linkedStats(db, projectId, incidentId) {
  const { rows: [r] } = await db.query(
    `SELECT count(*) FILTER (WHERE ie.link_type IN ('origin','corroborating'))::int AS reports,
            count(DISTINCT e.recorded_by) FILTER (WHERE ie.link_type IN ('origin','corroborating'))::int AS reporters,
            max(e.injured_count) AS injured, max(e.workers_affected) AS workers,
            coalesce(array_agg(DISTINCT f) FILTER (WHERE f IS NOT NULL), '{}') AS flags
     FROM sitemate.incident_events ie
     JOIN sitemate.events e ON (e.project_id, e.id) = (ie.project_id, ie.event_id)
     LEFT JOIN LATERAL jsonb_array_elements_text(e.attributes->'severity_flags') f ON true
     WHERE ie.project_id=$1 AND ie.incident_id=$2 AND ie.unlinked_at IS NULL`, [projectId, incidentId]);
  return r;
}

/** Recompute severity; writes incident_severity_history (and updates the incident) when the level changes. */
export async function recomputeSeverity(db, { projectId, incidentId, triggerEventId, taxonomy, deps, escalateAfterHours = config.escalateAfterHours }) {
  const { rows: [incident] } = await db.query(
    "SELECT * FROM sitemate.incidents WHERE project_id=$1 AND id=$2", [projectId, incidentId]);
  const stats = await linkedStats(db, projectId, incidentId);
  const { rows: [{ n: successors }] } = await db.query(
    `SELECT count(*)::int AS n FROM sitemate.activity_dependencies d
     JOIN sitemate.plan_targets t ON (t.project_id, t.activity_code) = (d.project_id, d.successor)
     WHERE d.project_id=$1 AND d.predecessor=$2
       AND t.work_date BETWEEN current_date AND current_date + 2`, [projectId, incident.activity_code]);
  const typeHint = taxonomy.type(incident.event_type)?.severity_hint;
  const rule = ruleSeverity({
    base: typeHint ?? taxonomy.category(incident.category)?.default_severity,
    category: incident.category, injuredCount: stats.injured ?? 0, flags: stats.flags,
    reporterCount: stats.reporters, successorsAtRisk: successors, workersAffected: stats.workers ?? 0,
    openHours: hoursBetween(new Date(), incident.first_reported_at ?? incident.occurred_at), escalateAfterHours,
  });
  let verdict = { adjustment: 0, reason: null };
  if (deps?.adjustSeverity) {
    try { verdict = await deps.adjustSeverity({ incident, rule, stats }); } catch { /* rules stand on their own */ }
  }
  const final = applyLlmAdjustment(rule, verdict.adjustment);
  const changed = final.level !== incident.severity;
  const version = incident.severity_version + 1;
  if (changed || incident.severity_version === 0) {
    await db.query(
      `INSERT INTO sitemate.incident_severity_history
         (project_id, incident_id, version, severity, rule_basis, llm_adjustment, reason, trigger_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [projectId, incidentId, version, final.level, JSON.stringify(rule), final.adjustment,
        verdict.reason ?? rule.hard.concat(rule.escalators).join("; ") ?? null, triggerEventId ?? null]);
    await db.query("UPDATE sitemate.incidents SET severity=$3, severity_version=$4 WHERE project_id=$1 AND id=$2",
      [projectId, incidentId, final.level, version]);
  }
  return { severity: final.level, previous: incident.severity, changed, rule };
}

const alertTitle = (incident) => incident.summary ?? incident.title;

/** One alert per incident; every source or severity change adds a revision. Escalation re-opens attention. */
export async function syncAlert(db, { projectId, incidentId, severity, previousSeverity, reason, newReport }) {
  const { rows: [incident] } = await db.query(
    "SELECT * FROM sitemate.incidents WHERE project_id=$1 AND id=$2", [projectId, incidentId]);
  let { rows: [alert] } = await db.query(
    "SELECT id, status FROM sitemate.alerts WHERE project_id=$1 AND incident_id=$2 AND kind='incident'",
    [projectId, incidentId]);
  if (!alert) {
    ({ rows: [alert] } = await db.query(
      `INSERT INTO sitemate.alerts (project_id, activity_code, checkpoint_at, kind, status, incident_id, title)
       VALUES ($1,$2,$3,'incident','open',$4,$5) RETURNING id, status`,
      [projectId, incident.activity_code, incident.first_reported_at ?? incident.occurred_at, incidentId, alertTitle(incident)]));
  }
  const { rows: refs } = await db.query(
    `SELECT DISTINCT e.source_id, e.locator FROM sitemate.incident_events ie
     JOIN sitemate.events e ON (e.project_id, e.id) = (ie.project_id, ie.event_id)
     WHERE ie.project_id=$1 AND ie.incident_id=$2 AND ie.unlinked_at IS NULL`, [projectId, incidentId]);
  const { rows: [{ v }] } = await db.query(
    "SELECT coalesce(max(version),0)+1 AS v FROM sitemate.alert_revisions WHERE project_id=$1 AND alert_id=$2",
    [projectId, alert.id]);
  await db.query(
    `INSERT INTO sitemate.alert_revisions (project_id, alert_id, version, as_of, severity, calculation, evidence_refs, reason)
     VALUES ($1,$2,$3,now(),$4,$5,$6,$7)`,
    [projectId, alert.id, v, severity,
      JSON.stringify({ kind: "incident", report_count: incident.report_count, reporter_count: incident.reporter_count,
        category: incident.category, status: incident.status }),
      JSON.stringify(refs.map((r) => ({ source_id: r.source_id, locator: r.locator, passage_id: `${r.source_id}:${r.locator}` }))),
      reason ?? null]);

  const escalated = previousSeverity && severityRank(severity) > severityRank(previousSeverity);
  const reopen = (escalated && ["acknowledged", "in_progress"].includes(alert.status))
    || (newReport && ["resolved", "dismissed"].includes(alert.status) && ["open", "monitoring"].includes(incident.status));
  if (reopen) {
    await db.query("UPDATE sitemate.alerts SET status='open' WHERE project_id=$1 AND id=$2", [projectId, alert.id]);
    await db.query(
      `INSERT INTO sitemate.alert_activity (project_id, alert_id, actor, action, from_status, to_status, note)
       VALUES ($1,$2,'agent',$3,$4,'open',$5)`,
      [projectId, alert.id, escalated ? "escalated" : "reopen", alert.status,
        escalated ? `Severity ${previousSeverity} -> ${severity}` : "New report on an open incident"]);
  }
  return { alertId: alert.id, revision: v };
}

/** Debounced: one queued job per incident; a newer source pushes run_after out. */
export async function enqueueJob(db, projectId, kind, incidentId, delaySeconds = config.reasoningDelaySeconds) {
  await db.query(
    `INSERT INTO sitemate.agent_jobs (project_id, kind, incident_id, run_after)
     VALUES ($1,$2,$3, now() + make_interval(secs => $4::int))
     ON CONFLICT (project_id, kind, incident_id) WHERE status='queued'
     DO UPDATE SET run_after = EXCLUDED.run_after, updated_at = now()`,
    [projectId, kind, incidentId, delaySeconds]);
}

async function refreshCounts(db, projectId, incidentId, { recordedAt, status }) {
  const stats = await linkedStats(db, projectId, incidentId);
  await db.query(
    `UPDATE sitemate.incidents SET report_count=GREATEST($3,1), reporter_count=GREATEST($4,1),
        last_reported_at=GREATEST(last_reported_at,$5::timestamptz), status=coalesce($6::text,status),
        resolved_at=CASE WHEN coalesce($6::text,status) IN ('open','monitoring') THEN NULL ELSE resolved_at END
     WHERE project_id=$1 AND id=$2`,
    [projectId, incidentId, stats.reports, stats.reporters, recordedAt, status ?? null]);
  return stats;
}

async function attach(db, ctx, event, incidentId, linkType, score, reason, linkedBy = "agent") {
  await db.query(
    `INSERT INTO sitemate.incident_events (project_id, incident_id, event_id, link_type, match_score, match_reason, linked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [ctx.projectId, incidentId, event.id, linkType, score ?? null, reason ?? null, linkedBy]);
  await db.query("UPDATE sitemate.events SET incident_id=$3 WHERE project_id=$1 AND id=$2", [ctx.projectId, event.id, incidentId]);
}

async function linkExisting(db, ctx, event, candidate, linkType, score, reason) {
  const { incident } = candidate;
  await attach(db, ctx, event, incident.id, linkType, score, reason);
  const status = linkType === "resolution" ? "monitoring"
    : linkType === "corroborating" && incident.status === "monitoring" ? "open" : null;
  const stats = await refreshCounts(db, ctx.projectId, incident.id, { recordedAt: event.recorded_at, status });
  const sev = await recomputeSeverity(db, { ...ctx, incidentId: incident.id, triggerEventId: event.id });
  const alert = await syncAlert(db, { projectId: ctx.projectId, incidentId: incident.id, severity: sev.severity,
    previousSeverity: sev.previous, newReport: linkType === "corroborating",
    reason: `${linkType}: ${event.summary}` });
  if (linkType !== "resolution") await enqueueJob(db, ctx.projectId, "reasoning", incident.id);
  return { incident_id: incident.id, link_type: linkType, created: false, severity: sev.severity,
    severity_changed: sev.changed, report_count: stats.reports, reporter_count: stats.reporters,
    title: incident.summary, alert_id: alert.alertId };
}

async function createIncident(db, ctx, event, key) {
  const { rows: [taken] } = await db.query(
    `SELECT 1 FROM sitemate.incidents i WHERE i.project_id=$1 AND i.cluster_key=$2 AND ${OPEN}`, [ctx.projectId, key]);
  const { rows: [recurrence] } = await db.query(
    `SELECT id FROM sitemate.incidents WHERE project_id=$1 AND starts_with(cluster_key, $2)
       AND status IN ('resolved','closed') AND resolved_at >= $3::timestamptz - make_interval(hours => $4::int)
     ORDER BY resolved_at DESC LIMIT 1`,
    [ctx.projectId, key, event.occurred_at, config.correlation.recurrenceHours]);
  const clusterKeyValue = taken ? `${key}#${Math.random().toString(36).slice(2, 10)}` : key;
  await db.query("SAVEPOINT new_incident");
  try {
    const { rows: [row] } = await db.query(
      `INSERT INTO sitemate.incidents
         (project_id, activity_code, kind, title, occurred_at, category, event_type, summary, zone, asset_key, status,
          first_reported_at, last_reported_at, report_count, reporter_count, cluster_key, recurrence_of_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$4,$8,$9,'open',$10,$10,1,1,$11,$12) RETURNING id`,
      [ctx.projectId, event.activity_code, event.event_type, event.summary, event.occurred_at, event.category,
        event.event_type, event.zone, event.asset_key, event.recorded_at, clusterKeyValue, recurrence?.id ?? null]);
    await db.query("RELEASE SAVEPOINT new_incident");
    return row.id;
  } catch (err) {
    await db.query("ROLLBACK TO SAVEPOINT new_incident");
    if (err.code !== "23505") throw err;
    return null; // another transaction created the same open cluster; the caller re-reads and links
  }
}

async function newIncident(db, ctx, event, key) {
  const id = await createIncident(db, ctx, event, key);
  if (!id) {
    const { rows: [existing] } = await db.query(
      `SELECT i.* FROM sitemate.incidents i WHERE i.project_id=$1 AND i.cluster_key=$2 AND ${OPEN}`, [ctx.projectId, key]);
    return linkExisting(db, ctx, event, { incident: existing }, "corroborating", null, "unique-cluster backstop");
  }
  await attach(db, ctx, event, id, "origin", null, "origin event");
  const sev = await recomputeSeverity(db, { ...ctx, incidentId: id, triggerEventId: event.id });
  const alert = await syncAlert(db, { projectId: ctx.projectId, incidentId: id, severity: sev.severity,
    previousSeverity: null, newReport: false, reason: `Opened: ${event.summary}` });
  await enqueueJob(db, ctx.projectId, "reasoning", id);
  return { incident_id: id, link_type: "origin", created: true, severity: sev.severity, severity_changed: true,
    report_count: 1, reporter_count: 1, title: event.summary, alert_id: alert.alertId };
}

/** Which advisory-lock key serialises concurrent reports about this event. */
export const lockKeyFor = (event) => event.asset_key ?? event.cluster_key ?? normZone(event.zone) ?? "site";

/**
 * Group confirmed events into incidents inside the caller's transaction.
 * `events` carry { id, category, event_type, summary, zone, activity_code, asset_key, occurred_at, recorded_at }.
 * deps: { adjudicate({event, candidates}) -> Adjudication, adjustSeverity }. Returns one result per linked event.
 */
export async function correlateEvents(db, ctx, events) {
  const taxonomy = ctx.taxonomy;
  const eligible = events.filter((e) => taxonomy.createsIncident(e.category) || isStatusUpdate(e.category));
  for (const e of eligible) {
    const cat = taxonomy.category(e.category);
    e.cluster_key = clusterKey(e.category, e, cat?.grouping_fields);
  }
  // Lock in a stable order so two captures touching the same assets can't deadlock.
  for (const key of [...new Set(eligible.map(lockKeyFor))].sort()) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${ctx.projectId}|${key}`]);
  }
  const results = [];
  for (const event of eligible) {
    const category = taxonomy.category(event.category);
    const status = isStatusUpdate(event.category);
    const windowHours = category?.group_window_hours || 72;
    const categories = status ? null : [event.category, ...(COMPATIBLE[event.category] ?? [])];
    const ranked = rankCandidates(event, await fetchCandidates(db, ctx.projectId, event, categories, windowHours), windowHours);
    let decision = decide(ranked);
    let linkType = status ? linkTypeFor(event.event_type) : "corroborating";
    let reason = decision.reason;

    if (decision.action === "adjudicate") {
      const history = await recentEvents(db, ctx.projectId, decision.candidates.map((c) => c.incident.id));
      let verdict = null;
      try {
        verdict = await ctx.deps?.adjudicate?.({
          event, candidates: decision.candidates.map((c) => ({ ...c, history: history.get(c.incident.id) ?? { linked: [], unlinked: [] } })),
        });
      } catch { /* an unavailable adjudicator must not lose the report: fall back to the best deterministic match */ }
      const chosen = verdict?.decision === "link"
        ? decision.candidates.find((c) => c.incident.id === verdict.incident_id) : null;
      if (chosen) {
        decision = { action: "link", candidate: chosen };
        reason = `LLM: ${verdict.reason}`;
        if (verdict.link_type && !status) linkType = verdict.link_type;
      } else if (verdict) {
        decision = { action: "new" };
      } else {
        // No verdict: link only when the top candidate is strong, otherwise keep the report separate.
        decision = decision.candidates[0].score >= 0.6
          ? { action: "link", candidate: decision.candidates[0] } : { action: "new" };
        reason = "fallback (adjudicator unavailable)";
      }
    }

    if (decision.action === "link") {
      results.push({ event_id: event.id, event_index: event.event_index,
        ...(await linkExisting(db, ctx, event, decision.candidate, linkType, decision.candidate.score, reason)) });
    } else if (!status) {
      results.push({ event_id: event.id, event_index: event.event_index,
        ...(await newIncident(db, ctx, event, event.cluster_key)) });
    }
    // A status update with no open incident to attach to stays a plain event.
  }
  return results;
}
