import assert from "node:assert/strict";
import { test } from "node:test";
import { clusterKey, normalizeAssetKey, textSimilarity } from "../src/agent/assets.js";

const register = [{ id: "LIFT-2", description: "Goods hoist, core A" }, { id: "EX-02", description: "Excavator" }];

test("spoken names that the model mapped to a register id share one key", () => {
  for (const spoken of ["LIFT-2", "lift-2", "eq:LIFT-2"]) {
    assert.equal(normalizeAssetKey({ asset_key: spoken }, register), "eq:LIFT-2");
  }
  assert.equal(normalizeAssetKey({ equipment_id_spoken: "ex-02", asset_key: "digger" }, register), "eq:EX-02");
});

test("unregistered assets fall back to a kind:qualifier slug with synonyms folded", () => {
  assert.equal(normalizeAssetKey({ asset_key: "goods lift" }), "lift:goods");
  assert.equal(normalizeAssetKey({ asset_key: "the Goods Hoist" }), "lift:goods");
  assert.equal(normalizeAssetKey({ asset_key: "lift 2" }), "lift:2");
  assert.equal(normalizeAssetKey({ asset_key: "Hoist L2" }), "lift:2");
  assert.equal(normalizeAssetKey({ asset_key: "hoist" }), "lift");
  assert.equal(normalizeAssetKey({}), null);
});

test("cluster keys use the category's grouping fields and fall back safely", () => {
  assert.equal(clusterKey("equipment", { asset_key: "eq:LIFT-2" }, ["asset_key"]), "equipment:eq:LIFT-2");
  assert.equal(clusterKey("safety", { zone: "Zone B", event_type: "near_miss" }, ["zone", "event_type"]), "safety:b:near_miss");
  // missing grouping field -> zone + type
  assert.equal(clusterKey("equipment", { zone: "B", event_type: "equipment_failure" }, ["asset_key"]), "equipment:b:equipment_failure");
  assert.equal(clusterKey("weather", {}, ["site"]), "weather:site");
  assert.equal(clusterKey("delivery", { material: "Rebar 12mm" }, ["material"]), "delivery:rebar-12mm");
});

test("text similarity", () => {
  assert.ok(textSimilarity("The lift is not working", "lift not working again") > 0.3);
  assert.equal(textSimilarity("crane fault", "poured concrete slab"), 0);
});
