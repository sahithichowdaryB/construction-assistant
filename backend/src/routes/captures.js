import { randomUUID } from "node:crypto";
import path from "node:path";
import { Command } from "@langchain/langgraph";
import { Router } from "express";
import multer from "multer";
import { sourceKind, setCaptureStatus } from "../agent/memory.js";
import { getCaptureAgent } from "../agent/graph.js";
import { config } from "../config.js";
import { withTransaction } from "../database/pool.js";
import { requireMember } from "../middleware/auth.js";
import { audioStorage, imageStorage } from "../services/files.js";
import { transcribe, transcriptionEnabled } from "../services/transcription.js";

const IMAGE_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude's per-image limit
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 + config.maxImages } })
  .fields([{ name: "audio", maxCount: 1 }, { name: "images", maxCount: config.maxImages }]);
const canCapture = requireMember("contributor", "manager", "approver");
// How a member's role is weighted as evidence by the root-cause agent (sources.author_role).
const AUTHOR_ROLE = { contributor: "foreman", manager: "site_supervisor", approver: "site_supervisor" };
export const captures = Router({ mergeParams: true });

const fail = (status, detail) => Object.assign(new Error(detail), { status, expose: true });

/** Maps the graph output to the HTTP contract and keeps captures.status in step. */
export async function respond(res, { projectId, captureId, threadId }, output) {
  const pending = output.__interrupt__?.[0]?.value;
  if (pending?.kind === "categories") {
    await setCaptureStatus(projectId, captureId, "needs_category");
    return res.status(202).json({
      status: "needs_category", thread_id: threadId, capture_id: captureId, transcript: output.transcript,
      photo_descriptions: output.perception ?? [], events: pending.events,
    });
  }
  if (pending) {
    await setCaptureStatus(projectId, captureId, "needs_input");
    return res.status(202).json({
      status: "needs_input", thread_id: threadId, capture_id: captureId, transcript: output.transcript,
      events: output.events, questions: pending.questions, round: pending.round,
    });
  }
  if (!output.result) {
    await setCaptureStatus(projectId, captureId, "no_events");
    return res.status(200).json({ status: "no_events", capture_id: captureId, transcript: output.transcript });
  }
  return res.status(201).json({ status: "saved", thread_id: threadId, events: output.events, ...output.result });
}

/** Run or resume the graph; a failure marks the capture failed instead of leaving it 'processing'. */
async function run(res, ids, invoke) {
  try {
    return await respond(res, ids, await invoke());
  } catch (err) {
    await setCaptureStatus(ids.projectId, ids.captureId, "failed").catch(() => {});
    throw err;
  }
}

/**
 * POST /projects/:projectId/captures
 * multipart: `audio` (one file), `images` (up to 5), `transcript` (text), optional `recorded_at`, `zone_hint`.
 * Returns needs_category with the AI's suggestions; the person confirms via POST /:threadId/categories.
 */
captures.post("/", canCapture, upload, async (req, res) => {
  const recordedAt = req.body?.recorded_at ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(recordedAt)) || !/(Z|[+-]\d\d:\d\d)$/.test(recordedAt)) {
    throw fail(422, "recorded_at must be ISO 8601 with a time zone");
  }
  const { projectId } = req.params;
  const audio = req.files?.audio?.[0];
  const images = req.files?.images ?? [];
  let transcript = req.body?.transcript?.trim() || null;
  for (const img of images) {
    if (!IMAGE_TYPES[img.mimetype]) throw fail(422, "Photos must be JPEG, PNG, WebP or GIF");
    if (img.size > MAX_IMAGE_BYTES) throw fail(422, "Each photo must be 5 MB or smaller");
  }
  if (audio && !transcriptionEnabled()) {
    throw fail(422, "Audio transcription is not configured; send a `transcript` text field instead");
  }
  const spoken = audio ? await transcribe(audio.buffer, audio.originalname, audio.mimetype) : null;
  transcript = [spoken, transcript].filter(Boolean).join("\n\n") || null;
  if (!transcript && !images.length) throw fail(422, "Send an `audio` file, `images` or a `transcript`");

  const sourceId = `CAP-${randomUUID().slice(0, 8).toUpperCase()}`;
  const threadId = randomUUID();
  const attachments = [];
  if (audio) {
    const ext = path.extname(audio.originalname).replace(/[^.\w]/g, "") || ".webm";
    attachments.push({ kind: "audio", mime: audio.mimetype, ...(await audioStorage.put(projectId, `${sourceId}${ext}`, audio.buffer)) });
  }
  let n = 0;
  for (const img of images) {
    n += 1;
    attachments.push({ kind: "image", n, mime: img.mimetype, locator: `image:${n}`,
      ...(await imageStorage.put(projectId, `${sourceId}-${n}${IMAGE_TYPES[img.mimetype]}`, img.buffer)) });
  }
  const kinds = [audio && "voice", images.length && "photo", req.body?.transcript?.trim() && "text"].filter(Boolean);
  const channel = kinds.length > 1 ? "mixed" : kinds[0];
  const captureId = await withTransaction(async (db) => {
    await db.query(
      `INSERT INTO sitemate.sources (project_id, id, kind, path, available_at, author, author_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [projectId, sourceId, sourceKind({ audio: Boolean(audio), images: images.length > 0, text: Boolean(req.body?.transcript?.trim()) }),
        attachments[0]?.key ?? "inline:transcript", recordedAt, req.member.member_id, AUTHOR_ROLE[req.member.role] ?? "unknown"]);
    const { rows: [capture] } = await db.query(
      `INSERT INTO sitemate.captures (project_id, source_id, thread_id, captured_by, channel, raw_text, transcript, recorded_at, zone_hint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [projectId, sourceId, threadId, req.member.member_id, channel, req.body?.transcript?.trim() || null, spoken,
        recordedAt, req.body?.zone_hint || null]);
    for (const a of attachments) {
      await db.query(
        `INSERT INTO sitemate.capture_attachments (project_id, capture_id, source_id, kind, storage_key, mime, bytes, sha256, passage_locator)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [projectId, capture.id, sourceId, a.kind, a.key, a.mime, a.bytes, a.sha256, a.locator ?? null]);
    }
    return capture.id;
  });

  const agent = await getCaptureAgent();
  const ids = { projectId, captureId, threadId };
  return run(res, ids, () => agent.invoke(
    { projectId, captureId, sourceId, capturedBy: req.member.member_id, transcript, recordedAt,
      attachments: attachments.filter((a) => a.kind === "image").map((a) => ({ n: a.n, kind: "image", key: a.key, mime: a.mime })) },
    { configurable: { thread_id: threadId } }));
});

/** Load a paused capture that belongs to this project and is waiting at `node`. */
async function pausedCapture(req, node) {
  const agent = await getCaptureAgent();
  const runConfig = { configurable: { thread_id: req.params.threadId } };
  const snapshot = await agent.getState(runConfig);
  if (snapshot.values?.projectId !== req.params.projectId || !snapshot.next?.includes(node)) return null;
  return { agent, runConfig, ids: { projectId: req.params.projectId, captureId: snapshot.values.captureId, threadId: req.params.threadId } };
}

/**
 * POST /projects/:projectId/captures/:threadId/categories
 * body { events: [{ index, category, event_type, keep }], added?: [{ summary, category, event_type }] }
 */
captures.post("/:threadId/categories", canCapture, async (req, res) => {
  const paused = await pausedCapture(req, "confirmCategories");
  if (!paused) throw fail(404, "No capture is waiting for category confirmation");
  const body = {
    events: Array.isArray(req.body?.events) ? req.body.events : [],
    added: Array.isArray(req.body?.added) ? req.body.added : [],
  };
  return run(res, paused.ids, () => paused.agent.invoke(new Command({ resume: body }), paused.runConfig));
});

/** POST /projects/:projectId/captures/:threadId/answers  — body { answers: [{ id, answer }] } */
captures.post("/:threadId/answers", canCapture, async (req, res) => {
  const paused = await pausedCapture(req, "askManager");
  if (!paused) throw fail(404, "No capture is waiting for answers");
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  return run(res, paused.ids, () => paused.agent.invoke(new Command({ resume: { answers } }), paused.runConfig));
});
