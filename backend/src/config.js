import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(BACKEND_ROOT, ".env"), quiet: true });

// SQLAlchemy-style URLs ("postgresql+psycopg://") are shared with the Python service; pg wants "postgresql://".
const toPgUrl = (url) => url?.replace(/^postgresql\+\w+:\/\//, "postgresql://");

export const config = {
  port: Number(process.env.AGENT_PORT ?? 4000),
  databaseUrl: toPgUrl(process.env.AGENT_DATABASE_URL),
  claudeModel: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
  claudeEffort: process.env.CLAUDE_EFFORT ?? "medium",
  // "default" lets the API retry a refused request on a fallback model; set to "off" to disable.
  claudeFallbacks: process.env.CLAUDE_FALLBACKS ?? "default",
  whisperModel: process.env.WHISPER_MODEL ?? "whisper-1",
  // Point at a self-hosted OpenAI-compatible Whisper server to keep audio on your own infrastructure.
  whisperBaseUrl: process.env.WHISPER_BASE_URL || undefined,
  uploadDir: path.resolve(BACKEND_ROOT, process.env.AGENT_UPLOAD_DIR ?? "storage/voice"),
  imageDir: path.resolve(BACKEND_ROOT, process.env.AGENT_IMAGE_DIR ?? "storage/images"),
  maxImages: Number(process.env.AGENT_MAX_IMAGES ?? 5),
  // "postgres" (default) survives restarts; "memory" is for tests and quick local runs.
  checkpointer: process.env.AGENT_CHECKPOINTER ?? "postgres",
  checkpointSchema: process.env.AGENT_CHECKPOINT_SCHEMA ?? "sitemate_checkpoints",
  // Debounce before the async reasoning job runs after a new source attaches.
  reasoningDelaySeconds: Number(process.env.AGENT_REASONING_DELAY_SECONDS ?? 60),
  // Correlation weights (sum to 1) and decision thresholds.
  correlation: {
    weights: { asset: 0.45, type: 0.15, zone: 0.15, activity: 0.10, time: 0.10, text: 0.05 },
    autoLink: 0.80, adjudicate: 0.45, textMin: 0.3, maxCandidates: 5, recurrenceHours: 72,
  },
  escalateAfterHours: Number(process.env.AGENT_ESCALATE_AFTER_HOURS ?? 24),
  maxQuestionRounds: Number(process.env.AGENT_MAX_QUESTION_ROUNDS ?? 2),
  allowedOrigins: (process.env.AGENT_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000").split(","),
};
