import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { query } from "../../database/pool.js";

async function relationships(projectId, codes, equipmentIds, workDate) {
  if (!codes.length && !equipmentIds.length) return null;
  const dependencies = await query(
    `SELECT d.predecessor, d.successor, s.name AS successor_name, p.name AS predecessor_name
     FROM sitemate.activity_dependencies d
     JOIN sitemate.activities s ON (s.project_id, s.code) = (d.project_id, d.successor)
     JOIN sitemate.activities p ON (p.project_id, p.code) = (d.project_id, d.predecessor)
     WHERE d.project_id=$1 AND (d.predecessor = ANY($2) OR d.successor = ANY($2))`,
    [projectId, codes]);
  const contractors = await query(
    `SELECT DISTINCT c.id, c.name, c.trade, c.contact_role,
            array_remove(array_agg(DISTINCT a.code), NULL) AS for_activities,
            array_remove(array_agg(DISTINCT e.id), NULL) AS owns_equipment
     FROM sitemate.contractors c
     LEFT JOIN sitemate.activities a ON (a.project_id, a.contractor_id) = (c.project_id, c.id) AND a.code = ANY($2)
     LEFT JOIN sitemate.equipment e ON (e.project_id, e.owner_id) = (c.project_id, c.id) AND e.id = ANY($3)
     WHERE c.project_id=$1 AND (a.code IS NOT NULL OR e.id IS NOT NULL)
     GROUP BY c.id, c.name, c.trade, c.contact_role`,
    [projectId, codes, equipmentIds]);
  // Other activities relying on the same machine that day are knock-on impacts.
  const sharedEquipment = await query(
    `SELECT equipment_id, activity_code FROM sitemate.equipment_assignments
     WHERE project_id=$1 AND work_date=$2 AND equipment_id = ANY($3) AND NOT activity_code = ANY($4)`,
    [projectId, workDate, equipmentIds, codes]);
  const openAlerts = await query(
    `SELECT a.id, a.activity_code, a.kind, a.checkpoint_at, r.severity
     FROM sitemate.alerts a
     JOIN LATERAL (SELECT severity FROM sitemate.alert_revisions r
                   WHERE (r.project_id, r.alert_id) = (a.project_id, a.id) ORDER BY version DESC LIMIT 1) r ON true
     WHERE a.project_id=$1 AND a.status='open' AND a.activity_code = ANY($2)`,
    [projectId, codes]);
  return { dependencies, contractors, shared_equipment: sharedEquipment, open_alerts: openAlerts };
}

export const relationshipMatchingTool = tool(
  async ({ projectId, matches }) =>
    Promise.all(matches.map(async (m) => ({
      event_index: m.event_index,
      ...(await relationships(projectId, m.activities.map((a) => a.code), m.equipment.map((e) => e.id), m.work_date)),
    }))),
  {
    name: "relationship_matching",
    description: "For matched activities and equipment, find schedule predecessors/successors, responsible "
      + "contractors, equipment shared with other activities and open progress alerts.",
    schema: z.object({ projectId: z.string(), matches: z.array(z.any()) }),
  },
);
