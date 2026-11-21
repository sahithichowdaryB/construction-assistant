import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.js";
import { decide, linkTypeFor, rankCandidates, scoreCandidate } from "../src/agent/tools/incidentCorrelation.js";

const T = "2026-11-10T10:00:00Z";
const incident = (o = {}) => ({ id: "i1", category: "equipment", event_type: "equipment_failure", summary: "Lift not working",
  zone: "A", asset_key: "eq:LIFT-2", activity_code: null, cluster_key: "equipment:eq:LIFT-2", status: "open",
  last_reported_at: T, ...o });
const event = (o = {}) => ({ category: "equipment", event_type: "equipment_failure", summary: "the lift is broken again",
  zone: "A", asset_key: "eq:LIFT-2", activity_code: null, cluster_key: "equipment:eq:LIFT-2", occurred_at: T, ...o });

test("weights sum to one", () => {
  assert.ok(Math.abs(Object.values(config.correlation.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("same asset, type, zone, time auto-links", () => {
  const ranked = rankCandidates(event(), [incident()], 24);
  assert.ok(ranked[0].score >= 0.8, `score ${ranked[0].score}`);
  assert.equal(decide(ranked).action, "link");
});

test("same asset but different zone and no recent time needs the adjudicator", () => {
  const ranked = rankCandidates(event({ zone: "C", occurred_at: "2026-11-10T22:00:00Z" }), [incident()], 24);
  const d = decide(ranked);
  assert.equal(d.action, "adjudicate");
});

test("a different asset in the same zone is not auto-linked", () => {
  const ranked = rankCandidates(event({ asset_key: "eq:CRANE-1", summary: "tower crane fault" }), [incident()], 24);
  assert.notEqual(decide(ranked).action, "link");
});

test("unrelated incidents are not candidates and yield a new incident", () => {
  const ranked = rankCandidates(event({ zone: "Z", asset_key: null, summary: "hose burst" }),
    [incident({ zone: "A", asset_key: null, summary: "late rebar" })], 24);
  assert.equal(ranked.length, 0);
  assert.equal(decide(ranked).action, "new");
});

test("time proximity decays across the window", () => {
  const near = scoreCandidate(event(), incident(), 24).signals.time;
  const far = scoreCandidate(event({ occurred_at: "2026-11-11T08:00:00Z" }), incident(), 24).signals.time;
  assert.ok(near > far && far > 0);
  assert.equal(scoreCandidate(event({ occurred_at: "2026-11-13T10:00:00Z" }), incident(), 24).signals.time, 0);
});

test("status updates map to resolution or update links", () => {
  assert.equal(linkTypeFor("repair_release"), "resolution");
  assert.equal(linkTypeFor("issue_resolved"), "resolution");
  assert.equal(linkTypeFor("repair_forecast"), "update");
});
