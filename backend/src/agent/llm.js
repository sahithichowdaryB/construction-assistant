import { ChatAnthropic } from "@langchain/anthropic";
import { config } from "../config.js";

const fallbacksOn = config.claudeFallbacks !== "off";

export const claude = new ChatAnthropic({
  model: config.claudeModel,
  maxTokens: 16000,
  // Adaptive thinking; effort controls depth ("medium" by default).
  thinking: { type: "adaptive" },
  outputConfig: { effort: config.claudeEffort },
  // Server-side fallback: if a safety classifier refuses, the API retries on a fallback model.
  ...(fallbacksOn && {
    betas: ["server-side-fallback-2026-07-01"],
    invocationKwargs: { fallbacks: config.claudeFallbacks },
  }),
});

/**
 * Structured output via output_config.format (JSON schema). Forced tool_choice is avoided,
 * so LangChain's default "functionCalling" method must not be used here.
 */
export const structured = (schema, name) => claude.withStructuredOutput(schema, { method: "jsonSchema", name });
