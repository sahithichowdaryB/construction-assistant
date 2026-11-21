import assert from "node:assert/strict";
import { test } from "node:test";
import { applyLlmAdjustment, ruleSeverity } from "../src/agent/severity.js";

const base = { base: "medium", category: "equipment" };

test("no escalators keeps the base level", () => {
  assert.equal(ruleSeverity(base).level, "medium");
});

test("hard rules set a floor", () => {
  assert.equal(ruleSeverity({ base: "low", category: "safety", injuredCount: 1 }).floor, "high");
  assert.equal(ruleSeverity({ base: "low", category: "safety", flags: ["hospitalisation"] }).level, "critical");
  assert.equal(ruleSeverity({ base: "low", category: "environmental", flags: ["spill_to_drain"] }).level, "high");
  assert.equal(ruleSeverity({ base: "low", category: "safety", flags: ["occupied_zone"] }).level, "medium");
});

test("each escalator adds one level, capped at high", () => {
  assert.equal(ruleSeverity({ ...base, reporterCount: 3 }).level, "high");
  assert.equal(ruleSeverity({ base: "low", category: "equipment", reporterCount: 3 }).level, "medium");
  const many = ruleSeverity({ base: "low", category: "equipment", reporterCount: 5, workersAffected: 12,
    successorsAtRisk: 2, flags: ["sole_access"], openHours: 99 });
  assert.equal(many.level, "high");
  assert.equal(many.escalators.length, 5);
});

test("escalators never push past a critical floor or lower it", () => {
  assert.equal(ruleSeverity({ ...base, flags: ["fatality"], reporterCount: 9 }).level, "critical");
});

test("LLM adjustment is clamped to +-1 and respects the floor and the high cap", () => {
  const rule = ruleSeverity({ ...base });
  assert.equal(applyLlmAdjustment(rule, 5).level, "high");
  assert.equal(applyLlmAdjustment(rule, -5).level, "low");
  const floored = ruleSeverity({ base: "low", category: "safety", injuredCount: 2 });
  assert.equal(applyLlmAdjustment(floored, -1).level, "high");
  assert.equal(applyLlmAdjustment(rule, 0).level, "medium");
  // no hard rule: the LLM cannot invent a critical
  assert.equal(applyLlmAdjustment(ruleSeverity({ ...base, reporterCount: 3 }), 1).level, "high");
  assert.equal(applyLlmAdjustment(ruleSeverity({ base: "low", category: "safety", flags: ["fatality"] }), 1).level, "critical");
});
