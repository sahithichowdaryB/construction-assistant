import OpenAI, { toFile } from "openai";
import { config } from "../config.js";

let client;

/** Audio transcription needs an OpenAI key or a self-hosted Whisper server; otherwise clients send a text transcript. */
export const transcriptionEnabled = () => Boolean(process.env.OPENAI_API_KEY || config.whisperBaseUrl);

/** Speech-to-text with Whisper (OpenAI API, or any OpenAI-compatible Whisper server via WHISPER_BASE_URL). */
export async function transcribe(buffer, filename, mimetype) {
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "unused", baseURL: config.whisperBaseUrl });
  const result = await client.audio.transcriptions.create({
    file: await toFile(buffer, filename, { type: mimetype }),
    model: config.whisperModel,
    language: process.env.WHISPER_LANGUAGE || undefined,
  });
  return result.text.trim();
}
