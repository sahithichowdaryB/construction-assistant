// Needs a migrated scratch database: TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/sm?sslmode=disable
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MemorySaver, Command } from "@langchain/langgraph";

const URL_ = process.env.AGENT_TEST_URL ?? process.env.TEST_DATABASE_URL; // the role the agent runs as
const ADMIN_URL = process.env.TEST_DATABASE_URL; // seeds and cleans up (may be the same login)
const skip = !ADMIN_URL && "set TEST_DATABASE_URL to run integration tests";
const PID = "ITEST";

describe("capture -> event -> incident -> alert pipeline", { skip }, () => {
  let db, graph, seed, admin;

  before(async () => {
    process.env.AGENT_DATABASE_URL = URL_;
    process.env.AGENT_CHECKPOINTER = "memory";
    const pool = await import("../src/database/pool.js");
    const { buildCaptureGraph } = await import("../src/agent/graph.js");
    const { updateProjectMemory } = await import("../src/agent/memory.js");
    const { seedTaxonomy } = await import("../src/agent/taxonomy.js");
    db = pool;
    admin = (await import("pg")).default.Pool ? new (await import("pg")).default.Pool({ connectionString: ADMIN_URL }) : pool.pool;
    await cleanup();
    await seedProject();

    const taxonomy = seedTaxonomy();
    // Fake LLM: adjudicator links when asset matches; severity judge stays neutral.
    const correlation = {
      adjudicate: async ({ event, candidates }) => {
        const hit = candidates.find((c) => c.incident.asset_key === event.asset_key);
        return hit ? { decision: "link", incident_id: hit.incident.id, link_type: "corroborating", confidence: 0.9, reason: "same asset" }
          : { decision: "new", incident_id: null, link_type: null, confidence: 0.8, reason: "different asset" };
      },
      adjustSeverity: async () => ({ adjustment: 0, reason: null }),
    };
    seed = { taxonomy, correlation };
    graph = buildCaptureGraph({
      describePhoto: async () => ({ description: "A burst hose on the ground", visible_assets: [], hazards: ["oil"], text_in_image: [] }),
      photoPassage: (d) => d.description,
      extractFacts: async ({ text }) => [extract(text)],
      searchDatabase: async ({ events }) => events.map((_, i) => ({ event_index: i, activities: [], equipment: [], incidents: [], passages: [], progress: [], work_date: "2026-11-10" })),
      matchRelationships: async ({ matches }) => matches.map((m) => ({ event_index: m.event_index })),
      validate: async () => ({ validated_facts: [], missing: [], questions: [] }),
      enforceRequiredFields: (r) => r,
      persist: (s) => updateProjectMemory(s, seed),
    }, new MemorySaver());
  });

  after(async () => { await cleanup(); await admin.end(); await db.pool.end(); });

  const q = (text, params) => admin.query(text, params);
  const extract = (text) => {
    const lift = /lift|hoist/i.test(text);
    const crane = /crane/i.test(text);
    const fixed = /working again|fixed/i.test(text);
    const spill = /oil|spill/i.test(text);
    return {
      suggested_category: fixed ? "status_update" : spill ? "environmental" : "equipment",
      suggested_event_type: fixed ? "repair_release" : spill ? "spill" : "equipment_failure",
      confidence: 0.82, rationale: "test", alternatives: [], summary: text.slice(0, 80), evidence_quote: text,
      asset_key: lift ? "LIFT-2" : crane ? "crane:tower" : undefined, zone: "A", occurred_at: null, activity_code: null,
      equipment_id_spoken: null, equipment_description: null, material: null, quantity: null, unit: null,
      quantity_basis: null, outstanding_quantity: null, workers_affected: null, expected_restart_at: null,
      location: null, description: null,
      severity_flags: spill ? ["spill_to_drain"] : undefined,
    };
  };
  const report = async (member, text, { photos = [] } = {}) => {
    const sourceId = `T-${Math.random().toString(36).slice(2, 10)}`;
    const threadId = crypto.randomUUID();
    await q(`INSERT INTO sitemate.sources (project_id,id,kind,path,available_at) VALUES ($1,$2,'text','inline',now())`, [PID, sourceId]);
    const { rows: [cap] } = await q(
      `INSERT INTO sitemate.captures (project_id,source_id,thread_id,captured_by,channel,recorded_at) VALUES ($1,$2,$3,$4,'text',now()) RETURNING id`,
      [PID, sourceId, threadId, member]);
    const cfg = { configurable: { thread_id: threadId } };
    const first = await graph.invoke({ projectId: PID, captureId: cap.id, sourceId, capturedBy: member, transcript: text,
      recordedAt: new Date().toISOString(), attachments: photos }, cfg);
    assert.equal(first.__interrupt__[0].value.kind, "categories");
    return { first, finish: (resume) => graph.invoke(new Command({ resume }), cfg), cap };
  };
  const accept = async (member, text) => { const r = await report(member, text); return r.finish({ events: [] }); };

  async function seedProject() {
    await q(`INSERT INTO sitemate.projects (id,name,timezone,threshold,high_threshold) VALUES ($1,'Integration test','UTC',10,30)`, [PID]);
    for (const [m, role] of [["m1", "contributor"], ["m2", "contributor"], ["m3", "contributor"], ["m4", "contributor"], ["m5", "contributor"], ["boss", "manager"]]) {
      await q(`INSERT INTO sitemate.project_members (project_id,member_id,token_hash,role) VALUES ($1,$2,$3,$4)`, [PID, m, `hash-${m}`, role]);
    }
    await q(`INSERT INTO sitemate.contractors (project_id,id,name,trade,contact_role) VALUES ($1,'C1','Lift Co','lifts','owner')`, [PID]);
    await q(`INSERT INTO sitemate.equipment (project_id,id,description,owner_id) VALUES ($1,'LIFT-2','Goods hoist','C1')`, [PID]);
  }
  async function cleanup() {
    for (const t of ["agent_runs", "agent_jobs", "action_items", "alert_activity", "incident_events"]) {
      await q(`DELETE FROM sitemate.${t} WHERE project_id=$1`, [PID]);
    }
    await q(`ALTER TABLE sitemate.alert_revisions DISABLE TRIGGER keep_revision`);
    await q(`DELETE FROM sitemate.alert_revisions WHERE project_id=$1`, [PID]);
    await q(`ALTER TABLE sitemate.alert_revisions ENABLE TRIGGER keep_revision`);
    await q(`ALTER TABLE sitemate.incident_severity_history DISABLE TRIGGER keep_revision`);
    await q(`DELETE FROM sitemate.incident_severity_history WHERE project_id=$1`, [PID]);
    await q(`ALTER TABLE sitemate.incident_severity_history ENABLE TRIGGER keep_revision`);
    for (const t of ["alerts", "fact_evidence", "capture_facts", "events", "capture_attachments", "captures", "incidents",
      "source_passages", "sources", "equipment", "contractors", "project_members"]) {
      await q(`DELETE FROM sitemate.${t} WHERE project_id=$1`, [PID]);
    }
    await q(`DELETE FROM sitemate.projects WHERE id=$1`, [PID]);
  }

  test("the user's confirmed category is final and the suggestion is audited", async () => {
    const r = await report("m1", "Crane fault at the tower");
    assert.equal(r.first.__interrupt__[0].value.events[0].suggested_category, "equipment");
    const out = await r.finish({ events: [{ index: 0, category: "weather", event_type: "weather_stop" }] });
    const { rows: [e] } = await q("SELECT * FROM sitemate.events WHERE project_id=$1 AND capture_id=$2", [PID, r.cap.id]);
    assert.equal(e.category, "weather");
    assert.equal(e.suggested_category, "equipment");
    assert.equal(e.confirmed_by, "m1");
    assert.equal(out.result.incident_links[0].created, true);
  });

  test("'not an event' drops it, and nothing is persisted", async () => {
    const r = await report("m1", "Poured nothing today", {});
    const out = await r.finish({ events: [{ index: 0, keep: false }] });
    assert.equal(out.result ?? null, null);
  });

  test("five parallel reports of the same lift become one incident with five sources", async () => {
    const results = await Promise.all(["m1", "m2", "m3", "m4", "m5"].map((m, i) =>
      accept(m, `The lift is not working (report ${i})`)));
    assert.ok(results.every((r) => r.result?.incident_links?.length === 1));
    const { rows: incidents } = await q(
      "SELECT * FROM sitemate.incidents WHERE project_id=$1 AND asset_key='eq:LIFT-2'", [PID]);
    assert.equal(incidents.length, 1);
    const inc = incidents[0];
    assert.equal(inc.report_count, 5);
    assert.equal(inc.reporter_count, 5);
    assert.equal(inc.severity, "high"); // medium base + reporter_count>=3
    const { rows: links } = await q(
      "SELECT link_type, count(*)::int AS n FROM sitemate.incident_events WHERE project_id=$1 AND incident_id=$2 GROUP BY 1", [PID, inc.id]);
    assert.deepEqual(Object.fromEntries(links.map((l) => [l.link_type, l.n])), { origin: 1, corroborating: 4 });
    const { rows: alerts } = await q("SELECT id FROM sitemate.alerts WHERE project_id=$1 AND incident_id=$2", [PID, inc.id]);
    assert.equal(alerts.length, 1);
    const { rows: [{ n }] } = await q("SELECT count(*)::int AS n FROM sitemate.alert_revisions WHERE project_id=$1 AND alert_id=$2", [PID, alerts[0].id]);
    assert.ok(n >= 5);
    const { rows: jobs } = await q("SELECT * FROM sitemate.agent_jobs WHERE project_id=$1 AND incident_id=$2 AND kind='reasoning'", [PID, inc.id]);
    assert.equal(jobs.length, 1); // debounced
    const { rows: hist } = await q("SELECT severity FROM sitemate.incident_severity_history WHERE project_id=$1 AND incident_id=$2 ORDER BY version", [PID, inc.id]);
    assert.equal(hist.at(-1).severity, "high");
  });

  test("a different asset in the same zone is a separate incident", async () => {
    await accept("m1", "The tower crane is down");
    const { rows } = await q("SELECT asset_key FROM sitemate.incidents WHERE project_id=$1 AND category='equipment' ORDER BY asset_key", [PID]);
    assert.deepEqual(rows.map((r) => r.asset_key), ["crane:tower", "eq:LIFT-2"]);
  });

  test("a repair update links as a resolution and moves the incident to monitoring", async () => {
    const out = await accept("boss", "The lift is working again, fixed");
    assert.equal(out.result.incident_links[0].link_type, "resolution");
    const { rows: [inc] } = await q("SELECT status, report_count FROM sitemate.incidents WHERE project_id=$1 AND asset_key='eq:LIFT-2'", [PID]);
    assert.equal(inc.status, "monitoring");
    assert.equal(inc.report_count, 5); // an update is not another report of the fault
  });

  test("a new report after 'monitoring' re-opens the incident and alert", async () => {
    await accept("m2", "The lift is broken again");
    const { rows: [inc] } = await q("SELECT status, report_count FROM sitemate.incidents WHERE project_id=$1 AND asset_key='eq:LIFT-2'", [PID]);
    assert.equal(inc.status, "open");
    assert.equal(inc.report_count, 6);
  });

  test("a spill is an environmental incident with severity high", async () => {
    const out = await accept("m3", "Oil spill by the tank, running to the drain");
    assert.equal(out.result.incident_links[0].severity, "high");
    const { rows: [inc] } = await q("SELECT category FROM sitemate.incidents WHERE project_id=$1 AND id=$2", [PID, out.result.incident_links[0].incident_id]);
    assert.equal(inc.category, "environmental");
  });

  test("photos become citable image passages", async () => {
    const r = await report("m1", "Hose burst", { photos: [{ n: 1, kind: "image", key: "x", mime: "image/jpeg" }] });
    await r.finish({ events: [] });
    const { rows } = await q("SELECT locator FROM sitemate.source_passages WHERE project_id=$1 AND source_id=(SELECT source_id FROM sitemate.captures WHERE id=$2) ORDER BY locator", [PID, r.cap.id]);
    assert.deepEqual(rows.map((x) => x.locator), ["image:1", "transcript"]);
  });

  test("a capture paused at category confirmation survives a restart (Postgres checkpointer)", async () => {
    const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
    const { buildCaptureGraph } = await import("../src/agent/graph.js");
    const { updateProjectMemory } = await import("../src/agent/memory.js");
    const schema = "sitemate_checkpoints";
    const deps = (over = {}) => ({
      describePhoto: async () => ({}), photoPassage: () => "", extractFacts: async ({ text }) => [extract(text)],
      searchDatabase: async ({ events }) => events.map((_, i) => ({ event_index: i, activities: [], equipment: [], incidents: [], passages: [], progress: [], work_date: "2026-11-10" })),
      matchRelationships: async ({ matches }) => matches.map((m) => ({ event_index: m.event_index })),
      validate: async () => ({ validated_facts: [], missing: [], questions: [] }), enforceRequiredFields: (r) => r,
      persist: (s) => updateProjectMemory(s, seed), ...over });
    const pool1 = db.makePool(2);
    const before = buildCaptureGraph(deps(), new PostgresSaver(pool1, undefined, { schema }));
    const sourceId = `T-${Math.random().toString(36).slice(2, 10)}`;
    const threadId = crypto.randomUUID();
    await q(`INSERT INTO sitemate.sources (project_id,id,kind,path,available_at) VALUES ($1,$2,'text','inline',now())`, [PID, sourceId]);
    const { rows: [cap] } = await q(`INSERT INTO sitemate.captures (project_id,source_id,thread_id,captured_by,channel,recorded_at) VALUES ($1,$2,$3,'m1','text',now()) RETURNING id`, [PID, sourceId, threadId]);
    const cfg = { configurable: { thread_id: threadId } };
    await before.invoke({ projectId: PID, captureId: cap.id, sourceId, capturedBy: "m1", transcript: "Generator fault in zone A", recordedAt: new Date().toISOString(), attachments: [] }, cfg);
    await pool1.end(); // "restart": the original process and its graph are gone
    const pool2 = db.makePool(2);
    const after = buildCaptureGraph(deps(), new PostgresSaver(pool2, undefined, { schema }));
    const snap = await after.getState(cfg);
    assert.ok(snap.next.includes("confirmCategories"));
    const out = await after.invoke(new Command({ resume: { events: [] } }), cfg);
    assert.equal(out.result.incident_links.length, 1);
    await pool2.end();
    await q("DELETE FROM sitemate_checkpoints.checkpoint_writes WHERE thread_id=$1", [threadId]);
    await q("DELETE FROM sitemate_checkpoints.checkpoints WHERE thread_id=$1", [threadId]);
  });
});
