import { Router } from "express";
import { loadTaxonomy } from "../agent/taxonomy.js";
import { requireMember } from "../middleware/auth.js";

export const categories = Router({ mergeParams: true });

/** GET /projects/:projectId/event-categories — categories with their event types, for the category picker. */
categories.get("/", requireMember(), async (req, res) => {
  const taxonomy = await loadTaxonomy(req.params.projectId);
  res.json(taxonomy.categories.map((c) => ({
    key: c.key, label: c.label, description: c.description, icon: c.icon, creates_incident: c.creates_incident,
    default_severity: c.default_severity, sort_order: c.sort_order,
    types: taxonomy.typesOf(c.key).map((t) => ({ key: t.key, label: t.label, severity_hint: t.severity_hint })),
  })));
});
