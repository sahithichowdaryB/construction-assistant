import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "@langchain/langgraph";
import { Router } from "express";
import multer from "multer";
import { captureAgent } from "../agent/graph.js";
import { config } from "../config.js";
import { query } from "../database/pool.js";
import { requireMember } from "../middleware/auth.js";
import { transcribe, transcriptionEnabled } from "../services/transcription.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const canCapture = requireMember("contributor", "manager", "approver");
const anyMember = requireMember();

// sitemate.sources.author_role only allows a fixed set of values.
const AUTHOR_ROLE = { contributor: "foreman", manager: "site_supervisor", approver: "site_supervisor" };
// Date or date-time like 2026-11-21 or 2026-11-21T09:15:00+01:00 (Date.parse alone accepts junk such as "0").
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const AUDIO_TYPES = { ".webm": "audio/webm", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aiff": "audio/aiff", ".ogg": "audio/ogg" };

/** A member sees their own notes, plus older notes saved before authorship was recorded (author is null). */
const VISIBLE = "kind = 'voice_note' AND (author = $2 OR author IS NULL)";
export const captures = Router({ mergeParams: true });

async function respond(res, threadId, output) {
  const pending = output.__interrupt__?.[0];
  if (pending?.value?.kind === "review") {
    return res.status(202).json({
      status: "needs_review", thread_id: threadId, transcript: output.transcript, events: output.events,
      facts: pending.value.facts, gaps: pending.value.gaps,
    });
  }
  if (output.discarded) {
    // Nothing was saved to the database; remove the uploaded recording too.
    if (output.storagePath && output.storagePath !== "inline:transcript") {
      await fs.rm(path.join(config.uploadDir, output.storagePath), { force: true });
    }
    return res.status(200).json({ status: "discarded" });
  }
  if (pending) {
    return res.status(202).json({
      status: "needs_input", thread_id: threadId, transcript: output.transcript, events: output.events,
      questions: pending.value.questions, round: pending.value.round,
    });
  }
  if (!output.result) {
    console.log(`[capture ${output.sourceId}] no events extracted. Transcript: ${JSON.stringify(output.transcript)}`);
    return res.status(200).json({ status: "no_events", transcript: output.transcript });
  }
  return res.status(201).json({ status: "saved", thread_id: threadId, events: output.events, ...output.result });
}

/** POST /projects/:projectId/captures  — multipart `audio` file, or `transcript` text; optional `recorded_at`. */
captures.post("/", canCapture, upload.single("audio"), async (req, res) => {
  const recordedAt = req.body?.recorded_at ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(recordedAt)) || !/(Z|[+-]\d\d:\d\d)$/.test(recordedAt)) {
    return res.status(422).json({ detail: "recorded_at must be ISO 8601 with a time zone" });
  }
  const { projectId } = req.params;
  const sourceId = `VN-${randomUUID().slice(0, 8).toUpperCase()}`;
  let transcript = req.body?.transcript?.trim();
  let storagePath = "inline:transcript";

  if (req.file && !transcriptionEnabled()) {
    return res.status(422).json({ detail: "Audio transcription is not configured; send a `transcript` text field instead" });
  }
  if (req.file) {
    const ext = path.extname(req.file.originalname).replace(/[^.\w]/g, "") || ".webm";
    storagePath = path.posix.join(projectId, `${sourceId}${ext}`);
    await fs.mkdir(path.join(config.uploadDir, projectId), { recursive: true });
    await fs.writeFile(path.join(config.uploadDir, storagePath), req.file.buffer);
    transcript = await transcribe(req.file.buffer, req.file.originalname, req.file.mimetype);
  }
  if (!transcript) return res.status(422).json({ detail: "Send an `audio` file or a `transcript`" });

  const threadId = randomUUID();
  const output = await captureAgent.invoke(
    { projectId, sourceId, storagePath, transcript, recordedAt, author: req.member.member_id, authorRole: AUTHOR_ROLE[req.member.role] ?? "unknown" },
    { configurable: { thread_id: threadId } });
  return respond(res, threadId, output);
});

/** POST /projects/:projectId/captures/:threadId/answers  — body { answers: [{ id, answer }] } */
captures.post("/:threadId/answers", canCapture, async (req, res) => {
  const runConfig = { configurable: { thread_id: req.params.threadId } };
  const snapshot = await captureAgent.getState(runConfig);
  if (snapshot.values?.projectId !== req.params.projectId || !snapshot.next?.includes("askManager")) {
    return res.status(404).json({ detail: "No capture is waiting for answers" });
  }
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  const output = await captureAgent.invoke(new Command({ resume: { answers } }), runConfig);
  return respond(res, req.params.threadId, output);
});

/**
 * POST /projects/:projectId/captures/:threadId/review
 * Body { edits: [{ index, value }], removed: [index], additions: [{ event_index, field_name, value }], discard: boolean }. The speaker's last look at the extracted
 * facts: corrected values replace the agent's, removed facts are dropped, "discard" saves nothing. Then the capture is saved.
 */
captures.post("/:threadId/review", canCapture, async (req, res) => {
  const runConfig = { configurable: { thread_id: req.params.threadId } };
  const snapshot = await captureAgent.getState(runConfig);
  if (snapshot.values?.projectId !== req.params.projectId || !snapshot.next?.includes("reviewFacts")) {
    return res.status(404).json({ detail: "No capture is waiting for review" });
  }
  if (snapshot.values?.author !== req.member.member_id) {
    return res.status(403).json({ detail: "Only the person who recorded this note can review it" });
  }
  const { edits, removed, additions, discard } = req.body ?? {};

  // occurred_at becomes a timestamp in the database, so refuse anything that is not a date-time before resuming.
  const facts = snapshot.values?.validation?.validated_facts ?? [];
  const badTime = [
    ...(Array.isArray(edits) ? edits.map((e) => ({ field: facts[e?.index]?.field_name, value: e?.value })) : []),
    ...(Array.isArray(additions) ? additions.map((a) => ({ field: a?.field_name, value: a?.value })) : []),
  ].find((x) => x.field === "occurred_at" && typeof x.value === "string" && x.value.trim() && !ISO_DATE.test(x.value.trim()));
  if (badTime) {
    return res.status(422).json({ detail: `"occurred at" must be a date and time, for example 2026-11-21T09:15:00+01:00 (got "${badTime.value}")` });
  }
  const output = await captureAgent.invoke(
    new Command({ resume: { edits: Array.isArray(edits) ? edits : [], removed: Array.isArray(removed) ? removed : [],
      additions: Array.isArray(additions) ? additions : [], discard: discard === true } }),
    runConfig);
  return respond(res, req.params.threadId, output);
});

/** GET /projects/:projectId/captures  — this member's saved notes with transcript, answers, facts and incident. */
captures.get("/", anyMember, async (req, res) => {
  const { projectId } = req.params;
  const sources = await query(
    `SELECT id, path, available_at, author, author_role FROM sitemate.sources
     WHERE project_id = $1 AND ${VISIBLE} ORDER BY available_at DESC LIMIT 50`,
    [projectId, req.member.member_id]);
  if (!sources.length) return res.json({ recordings: [] });
  const ids = sources.map((x) => x.id);

  const [passages, allFacts] = await Promise.all([
    query(`SELECT source_id, locator, excerpt FROM sitemate.source_passages
           WHERE project_id = $1 AND source_id = ANY($2) AND (locator = 'transcript' OR locator LIKE 'answer:%')
           ORDER BY source_id, locator`, [projectId, ids]),
    query(`SELECT id, supersedes_id, source_id, incident_id, field_name, value, basis, review_status, reviewed_by, effective_at
           FROM sitemate.capture_facts WHERE project_id = $1 AND source_id = ANY($2) ORDER BY effective_at, field_name, id`, [projectId, ids]),
  ]);
  // A fact that a later row supersedes is history, not current.
  const superseded = new Set(allFacts.map((f) => f.supersedes_id).filter(Boolean));
  const facts = allFacts.filter((f) => !superseded.has(f.id));
  const incidentIds = [...new Set(facts.map((f) => f.incident_id).filter(Boolean))];
  const incidents = incidentIds.length
    ? await query(`SELECT id, kind, title, activity_code, occurred_at, resolved_at FROM sitemate.incidents
                   WHERE project_id = $1 AND id = ANY($2)`, [projectId, incidentIds])
    : [];
  const incidentById = new Map(incidents.map((i) => [i.id, i]));

  res.json({
    recordings: sources.map((src) => {
      const own = passages.filter((p) => p.source_id === src.id);
      const myFacts = facts.filter((f) => f.source_id === src.id);
      return {
        id: src.id,
        recorded_at: src.available_at,
        has_audio: src.path !== "inline:transcript",
        author: src.author,
        author_role: src.author_role,
        transcript: own.find((p) => p.locator === "transcript")?.excerpt ?? null,
        answers: own.filter((p) => p.locator.startsWith("answer:")).map((p) => p.excerpt),
        facts: myFacts.map((f) => ({
          field_name: f.field_name, value: f.value, basis: f.basis, review_status: f.review_status,
          reviewed_by: f.reviewed_by, incident_id: f.incident_id,
        })),
        incidents: [...new Set(myFacts.map((f) => f.incident_id).filter(Boolean))].map((id) => incidentById.get(id)).filter(Boolean),
      };
    }),
  });
});

/** GET /projects/:projectId/captures/:sourceId/audio  — the stored recording (supports Range requests for seeking). */
captures.get("/:sourceId/audio", anyMember, async (req, res) => {
  const [src] = await query(
    `SELECT path FROM sitemate.sources WHERE project_id = $1 AND id = $3 AND ${VISIBLE}`,
    [req.params.projectId, req.member.member_id, req.params.sourceId]);
  if (!src || src.path === "inline:transcript") return res.status(404).json({ detail: "No recording for this note" });
  const file = path.resolve(config.uploadDir, src.path);
  if (!file.startsWith(path.resolve(config.uploadDir) + path.sep)) return res.status(404).json({ detail: "No recording for this note" });
  res.sendFile(file, {
    headers: { "Content-Type": AUDIO_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "private, max-age=300" },
  }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ detail: "Recording file is missing" });
  });
});
