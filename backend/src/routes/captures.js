import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "@langchain/langgraph";
import { Router } from "express";
import multer from "multer";
import { captureAgent } from "../agent/graph.js";
import { config } from "../config.js";
import { requireMember } from "../middleware/auth.js";
import { transcribe, transcriptionEnabled } from "../services/transcription.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const canCapture = requireMember("contributor", "manager", "approver");
export const captures = Router({ mergeParams: true });

function respond(res, threadId, output) {
  const pending = output.__interrupt__?.[0];
  if (pending) {
    return res.status(202).json({
      status: "needs_input", thread_id: threadId, transcript: output.transcript, events: output.events,
      questions: pending.value.questions, round: pending.value.round,
    });
  }
  if (!output.result) return res.status(200).json({ status: "no_events", transcript: output.transcript });
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
    { projectId, sourceId, storagePath, transcript, recordedAt },
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
