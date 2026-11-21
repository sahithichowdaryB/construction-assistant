import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { structured } from "../llm.js";
import { ExtractionResult } from "../schemas.js";

const extractor = structured(ExtractionResult, "site_events");

const SYSTEM = `You turn a construction site manager's voice note into structured site events.
Rules:
- Create one event per distinct thing that happened. A note may contain several events.
- Fill only what the transcript says. Leave a field null when it was not said; do not guess.
- activity_code and equipment_id_spoken must come from the allowed lists below, or be null.
  Set equipment_id_spoken only when the speaker actually named the machine ("E X zero two" -> "EX-02").
- Resolve relative times ("at ten", "tomorrow at noon") against the recording time in the project time zone,
  and write them as ISO 8601 with the correct UTC offset.
- quantity_basis: "estimated" for rough tallies or unchecked counts, "reported" for stated facts.
- evidence_quote must be copied verbatim from the transcript.`;

export const factExtractionTool = tool(
  async ({ transcript, recordedAt, context }) => {
    const { project, activities, equipment } = context;
    const result = await extractor.invoke([
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          `Project: ${project.name} (${project.id}), time zone ${project.timezone}`,
          `Recorded at: ${recordedAt}`,
          `Allowed activities:\n${activities.map((a) => `${a.code} | ${a.name} | zone ${a.zone} | ${a.unit}`).join("\n")}`,
          `Allowed equipment:\n${equipment.map((e) => `${e.id} | ${e.description}`).join("\n")}`,
          `<transcript>\n${transcript}\n</transcript>`,
        ].join("\n\n"),
      },
    ]);
    return result.events;
  },
  {
    name: "fact_extraction",
    description: "Extract structured site events (the capture JSON) from a voice-note transcript.",
    schema: z.object({
      transcript: z.string(),
      recordedAt: z.string().describe("ISO 8601 recording time"),
      context: z.any().describe("Project context from loadProjectContext"),
    }),
  },
);
