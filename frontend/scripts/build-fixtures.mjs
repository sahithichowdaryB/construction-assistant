// Regenerates the register-derived fixtures from the Riverside demo pack (read-only).
// Usage: node scripts/build-fixtures.mjs
//
// Shortfall figures are precomputed here with the backend's documented rule
// (100 * max(plan - actual, 0) / plan for positive targets; a zero target has no percentage)
// so the UI only ever displays numbers that came from a fixture or the API.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pack = join(here, "../../data/riverside-demo");
const out = join(here, "../fixtures");
mkdirSync(out, { recursive: true });

const index = JSON.parse(readFileSync(join(pack, "index.json"), "utf8"));
const projectRaw = JSON.parse(readFileSync(join(pack, "uploads/registers/project.json"), "utf8"));

function csv(name) {
  const [head, ...rows] = readFileSync(join(pack, "uploads/registers", name), "utf8").trim().split(/\r?\n/);
  const parse = (line) => [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const keys = parse(head);
  return rows.map((r) => Object.fromEntries(parse(r).map((v, i) => [keys[i], v])));
}

const write = (name, data) => writeFileSync(join(out, name), JSON.stringify(data, null, 2) + "\n");
const offset = "+01:00"; // Vienna is on CET for the whole demo window

// ---------- project ----------
const split = (s) => {
  const [name, ...rest] = s.split(", ");
  return { name: s, short: name, rest };
};
write("project.json", {
  id: projectRaw.id,
  name: projectRaw.name,
  timezone: projectRaw.timezone,
  thresholds: {
    deviation_pct: projectRaw.deviation_threshold_pct,
    high_above_pct: projectRaw.high_if_shortfall_pct_above,
  },
  sender: { name: split(projectRaw.sender).name, address: projectRaw.sender_address },
  recipient: { name: split(projectRaw.recipient).name, address: projectRaw.recipient_address },
  contract_reference: projectRaw.contract_reference,
  contract_clause: projectRaw.contract_clause,
  rate_table: projectRaw.rate_table,
  calendar_note: projectRaw.calendar,
});

// ---------- activities ----------
const schedule = csv("schedule.csv");
const activities = schedule.map((r) => ({
  code: r.activity_id,
  name: r.activity,
  zone: r.zone,
  unit: r.unit,
  planned_start: r.planned_start,
  planned_end: r.planned_end,
  planned_qty_per_day: Number(r.planned_qty_per_day),
  planned_total_qty: Number(r.planned_total_qty),
  crew_size: Number(r.crew_size),
  contractor_id: r.contractor_id,
  equipment_ids: r.equipment_ids ? r.equipment_ids.split("|") : [],
  predecessors: r.predecessors ? r.predecessors.split("|") : [],
}));
write("activities.json", activities);

// ---------- sources ----------
const titles = {
  SCH: "Programme schedule",
  CTR: "Contractor register",
  EQ: "Equipment register",
  PRJ: "Project record",
  E01: "Email: EX-02 service booking",
  M07: "Minutes M07: site coordination meeting, 7 Nov",
  M08: "Minutes M08: plant and access briefing, 8 Nov",
  R8: "Daily site report R8, 8 Nov",
  E02: "Email: Zone B handover date",
  R9: "Daily site report R9, 9 Nov",
  V01: "Voice note V01: excavator breakdown",
  V02: "Voice note V02: mechanic's forecast",
  P1: "Photo: leaking hose",
  V03: "Voice note V03: same machine at Zone B",
  V04: "Voice note V04: Zone B rough tally",
  D10: "Site diary, 10 Nov afternoon handover",
  R10: "Daily site report R10, 10 Nov",
  V05: "Voice note V05: EX-02 released",
  E03: "Email: west wing bar schedule",
  V06: "Voice note V06: west wing steel",
  R11: "Daily site report R11, 11 Nov",
  P3: "Photo: rainy access",
  V07: "Voice note V07: slab edge crack",
  P2: "Photo: slab edge",
  V08: "Voice note V08: concrete delivery late",
  V09: "Voice note V09: Zone B finished",
  E04: "Email: packing slip footer for review",
  V10: "Voice note V10: Foundations Zone B pour",
  R12: "Daily site report R12, 12 Nov",
  V11: "Voice note: west wing pump inspection hold",
  E05: "Email: pump inspection register checked",
  V12: "Voice note: Zone B spacers missing",
  E06: "Email: estimated arrival for Zone B spacers",
  G13: "Gate diary: spacer delivery docket",
  E07: "Email: gate docket confirmed",
  V13: "Voice note: survey tablet stopped saving",
};
const mimeOf = (p) =>
  ({
    csv: "text/csv",
    json: "application/json",
    eml: "message/rfc822",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pdf: "application/pdf",
    wav: "audio/wav",
    jpg: "image/jpeg",
    txt: "text/plain",
  })[p.split(".").pop()];
const pages = { R8: 1, R9: 1, R10: 2, R11: 1, R12: 1, G13: 1 };
const sources = index.records.map((r) => ({
  id: r.id,
  project_id: "RIV",
  type: r.type,
  title: titles[r.id] ?? r.id,
  filename: r.path.split("/").pop(),
  path: r.path,
  mime: mimeOf(r.path),
  available_at: r.available_at,
  status: "indexed",
  pages: pages[r.id] ?? null,
  note: r.id === "R11" ? "Scanned page, text from OCR" : r.transcript ? "Transcript available" : null,
}));
write("sources.json", sources);

// ---------- signed report readings ----------
const reports = {
  "2026-11-08": { source: "R8", page: 1, rows: { "EXC-B": 100, "FND-A": 20, "COL-L1": 4, "FORM-L1": 40 } },
  "2026-11-09": { source: "R9", page: 1, rows: { "EXC-B": 92, "FND-A": 30, "COL-L1": 4, "FORM-L1": 32 } },
  "2026-11-10": { source: "R10", page: 2, rows: { "EXC-B": 65, SLAB: 40, "COL-L1": 4, "FORM-L1": 48 } },
  "2026-11-11": { source: "R11", page: 1, rows: { "EXC-B": 80, "REBAR-L1": 4 } },
  "2026-11-12": { source: "R12", page: 1, rows: { "EXC-B": 63, "FND-B": 20, "REBAR-L1": 6 } },
};
const availableAt = Object.fromEntries(index.records.map((r) => [r.id, r.available_at]));
const schAt = availableAt.SCH;
const activityByCode = Object.fromEntries(activities.map((a) => [a.code, a]));

const passages = [];
const addPassage = (source_id, locator, text, page = null) => {
  const p = { id: `${source_id}:${locator}`, source_id, locator, text, page };
  passages.push(p);
  return p;
};

for (const a of activities) {
  const r = schedule.find((s) => s.activity_id === a.code);
  addPassage(
    "SCH",
    a.code,
    `${a.code} | ${a.name} | zone ${a.zone} | ${a.unit} | ${a.planned_start} to ${a.planned_end} | ${a.planned_qty_per_day}/day | total ${a.planned_total_qty} | crew ${a.crew_size} | ${a.contractor_id} | ${r.equipment_ids || "no equipment"} | predecessors: ${r.predecessors || "none"}`,
  );
}

const severityFor = (pct) => {
  if (pct > projectRaw.high_if_shortfall_pct_above) return "high";
  if (pct > projectRaw.deviation_threshold_pct) return "medium";
  return "none";
};
const round2 = (n) => Math.round(n * 100) / 100;

const progress = [];
const alerts = [];
for (const [date, rep] of Object.entries(reports)) {
  for (const a of activities) {
    const inRange = date >= a.planned_start && date <= a.planned_end;
    const planned = inRange ? a.planned_qty_per_day : 0;
    const listed = a.code in rep.rows;
    const actual = listed ? rep.rows[a.code] : 0;
    const locator = listed ? a.code : `zero-${a.code}`;
    const excerpt = listed
      ? `${a.code} | ${a.name} | ${a.unit} | ${planned} | ${actual}`
      : "Other scheduled activities recorded zero production this shift.";
    addPassage(rep.source, locator, excerpt, rep.page);

    const signedObs = {
      quantity: actual,
      basis: "signed",
      source_id: rep.source,
      locator,
      page: rep.page,
      excerpt,
      available_at: availableAt[rep.source],
    };
    const snapshots = [
      {
        available_at: schAt,
        actual: null,
        basis: null,
        shortfall_pct: null,
        severity: null,
        evidence: null,
        observations: [],
      },
    ];
    const pctOf = (q) => (planned > 0 ? round2((100 * Math.max(planned - q, 0)) / planned) : null);

    // The provisional diary estimate for EXC-B on 10 Nov arrives before the signed report.
    let earlier = [];
    if (a.code === "EXC-B" && date === "2026-11-10") {
      const diary = {
        quantity: 70,
        basis: "estimated",
        source_id: "D10",
        locator: "handover",
        page: null,
        excerpt:
          "15:55. Foreman estimates 70 m³ in Excavation Zone B. Last ticket still to reconcile. Use the signed shift return for the final figure.",
        available_at: availableAt.D10,
      };
      earlier = [diary];
      snapshots.push({
        available_at: availableAt.D10,
        actual: 70,
        basis: "estimated",
        shortfall_pct: pctOf(70),
        severity: null,
        evidence: { source_id: "D10", page: null, locator: "handover" },
        observations: [diary],
      });
    }
    const pct = pctOf(actual);
    snapshots.push({
      available_at: availableAt[rep.source],
      actual,
      basis: "signed",
      shortfall_pct: pct,
      severity: pct === null ? "none" : severityFor(pct),
      evidence: { source_id: rep.source, page: rep.page, locator },
      observations: [signedObs, ...earlier],
    });
    progress.push({
      activity_code: a.code,
      work_date: date,
      unit: a.unit,
      planned,
      plan_evidence: { source_id: "SCH", locator: a.code },
      snapshots,
    });

    if (planned > 0 && pct !== null && pct > projectRaw.deviation_threshold_pct) {
      alerts.push({
        id: `alr-${a.code.toLowerCase()}-${date}`,
        activity_code: a.code,
        kind: "shortfall",
        checkpoint_at: `${date}T17:30:00${offset}`,
        version: 1,
        as_of: availableAt[rep.source],
        severity: severityFor(pct),
        calculation: { planned, actual, shortfall_pct: pct, unit: activityByCode[a.code].unit },
        evidence_refs: [
          { source_id: "SCH", locator: a.code },
          { source_id: rep.source, locator, page: rep.page },
        ],
        available_at: availableAt[rep.source],
        retired_at: null,
      });
    }
  }
}

// R11 is a scan received the next morning. Before receipt the 11 Nov checkpoint has no report.
alerts.push({
  id: "alr-missing-report-2026-11-11",
  activity_code: "EXC-B",
  kind: "missing_report",
  checkpoint_at: `2026-11-11T17:30:00${offset}`,
  version: 1,
  as_of: `2026-11-11T17:30:00${offset}`,
  severity: "medium",
  calculation: null,
  evidence_refs: [{ source_id: "SCH", locator: "EXC-B" }],
  available_at: `2026-11-11T17:30:00${offset}`,
  retired_at: availableAt.R11,
});
alerts.sort((a, b) => b.checkpoint_at.localeCompare(a.checkpoint_at) || a.activity_code.localeCompare(b.activity_code));

write("progress.json", progress);
write("alerts.json", alerts);

// ---------- other passages ----------
const transcript = (id) => readFileSync(join(pack, "transcripts", `${id}.txt`), "utf8").trim();
for (const r of index.records.filter((x) => x.transcript)) addPassage(r.id, "transcript", transcript(r.id));
for (const e of csv("equipment.csv"))
  addPassage("EQ", e.equipment_id, `${e.equipment_id} | ${e.description} | owner ${e.owner_id} | 10 Nov assignment: ${e.assignment_on_2026_11_10}`);
for (const c of csv("contractors.csv"))
  addPassage("CTR", c.contractor_id, `${c.contractor_id} | ${c.name} | ${c.trade} | ${c.contact_role}`);
addPassage("PRJ", "contract", "contract_reference: null | contract_clause: null | rate_table: null");
addPassage("PRJ", "thresholds", "deviation_threshold_pct: 15 | high_if_shortfall_pct_above: 25");
const body = (file) => readFileSync(join(pack, "uploads/emails", file), "utf8").split(/\r?\n\r?\n/).slice(1).join("\n\n").trim();
addPassage("E01", "body", body("E01-service.eml"));
addPassage("E02", "body", body("E02-handover.eml"));
addPassage("E03", "body", body("E03-delivery.eml"));
addPassage("E04", "body", body("E04-footer.eml"));
// Match the locators returned by the live incidents API while evidence lookup uses fixtures.
for (const id of ["V11", "V12", "V13"]) {
  transcript(id).split(/(?<=[.!?])\s+/).forEach((sentence, i) => addPassage(id, `seg:${i + 1}`, sentence));
}
for (const id of ["E05", "E06", "E07"]) {
  addPassage(id, "para:1", body(`${id}.eml`).replace(/=\r?\n/g, ""));
}
addPassage("G13", "page:1", "Truck checked in at the site gate at 10:45. No reason supplied by the driver.", 1);
addPassage("D10", "handover", readFileSync(join(pack, "uploads/diary/2026-11-10.txt"), "utf8").trim().split(/\r?\n/).slice(2).join(" "));
addPassage("M07", "discussion", "The Zone B excavation shift starts tomorrow. Access to the north haul route is available from 07:00.");
addPassage("M07", "actions", "GroundWorks will provide Sam with a backup excavator plan by 10 November at 12:00. CraneCo will confirm the TC-01 inspection booking by 12 November at 12:00.");
addPassage("M07", "follow-up", "Sam will check these two actions at the next shift briefing. SolidBase will retain the 12 November start for Foundations Zone B in its baseline.");
addPassage("M08", "actions", "GroundWorks will keep DT-03 on the north haul route with EX-02. The backup excavator plan requested yesterday remains outstanding.");
addPassage("R10", "incidents", "At 10:00 the Zone B foreman reported a hydraulic hose failure on EX-02. Three workers could not continue digging there. Mechanic's initial forecast was noon tomorrow.", 1);
addPassage("R10", "reconciliation", "Signed survey tally for Excavation Zone B: 65 m³. The earlier 70 m³ diary estimate included an unconfirmed 5 m³ entry. Foundations Zone B remains dependent on excavation handover.", 2);
addPassage("R11", "incidents", "EX-02 released at 11:30. GroundWorks recorded 80 m³ for the shift. SteelFix installed 4 t in the west wing; the final tonne was due the next day.", 1);
addPassage("R9", "incidents", "Zone B load tally closed at 92 m³. Zone A caught up the prior day's 5 m³. West wing formwork crew stopped early to clear access for deliveries.", 1);
addPassage("R8", "reconciliation", "Foundations A placed 20 m³; supplier and foreman counted 5 m³ of today's booking for Monday.", 1);
addPassage("R12", "incidents", "GroundWorks excavated the remaining 63 m³ by 11:50. Foundations Zone B began after handover and placed 20 m³. West wing crew installed 6 t including yesterday's balance.", 1);
addPassage("R12", "reconciliation", "Hairline crack reported at the Zone A slab edge this morning. Width and engineering assessment remain open.", 1);
addPassage("P1", "image", "Photo of a leaking hydraulic hose (generated site illustration).");
write("passages.json", passages);

console.log(`activities ${activities.length}, sources ${sources.length}, passages ${passages.length}, progress ${progress.length}, alerts ${alerts.length}`);
