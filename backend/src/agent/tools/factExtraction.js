import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { structured } from "../llm.js";
import { ExtractionResult } from "../schemas.js";

const extractor = structured(ExtractionResult, "site_events");

const SYSTEM = `You turn a construction site report (a voice transcript, typed note, and/or descriptions of site photos)
into structured site events, and SUGGEST a category for each one. A person confirms the final category.
Rules:
- Create one event per distinct thing that happened. A note may contain several events.
- Fill only what the report says. Leave a field null when it was not said; do not guess.
- Classification: pick suggested_category and suggested_event_type from the category list below. The type must
  belong to the category. Give a confidence from 0 to 1, a one-sentence rationale, and the two next-best
  alternatives. Updates about an existing problem ("the lift is working again", "mechanic arrives at 14:00")
  are status_update; routine production, deliveries, headcount and instructions are non-incident categories.
- asset_key: when the report concerns a machine or fixed asset, set it to the equipment register ID if you can match
  it ("the hoist", "lift 2" and "the goods lift" are the same register entry when the register lists one).
  Otherwise use a short lowercase slug such as "lift:goods" or "crane:tower". Leave it out for non-asset events.
- activity_code and equipment_id_spoken must come from the allowed lists below, or be null.
  Set equipment_id_spoken only when the speaker actually named the machine ("E X zero two" -> "EX-02").
- severity_flags: only when explicitly supported (injured person taken to hospital, a fatality, structural
  collapse, an occupied zone, a spill reaching a drain, the only lift/hoist on site).
- Resolve relative times ("at ten", "tomorrow at noon") against the recording time in the project time zone,
  and write them as ISO 8601 with the correct UTC offset.
- quantity_basis: "estimated" for rough tallies or unchecked counts, "reported" for stated facts.
- evidence_quote must be copied verbatim from the report text (a photo description counts as report text).`;

export const factExtractionTool = tool(
  async ({ text, recordedAt, context, taxonomy }) => {
    const { project, activities, equipment } = context;
    const categoryList = taxonomy.categories.map((c) =>
      `${c.key} (${c.creates_incident ? "raises an incident" : "diary only"}): ${c.description}\n  types: `
      + taxonomy.typesOf(c.key).map((t) => t.key).join(", ")).join("\n");
    const result = await extractor.invoke([
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          `Project: ${project.name} (${project.id}), time zone ${project.timezone}`,
          `Recorded at: ${recordedAt}`,
          `Categories:\n${categoryList}`,
          `Allowed activities:\n${activities.map((a) => `${a.code} | ${a.name} | zone ${a.zone} | ${a.unit}`).join("\n")}`,
          `Equipment register:\n${equipment.map((e) => `${e.id} | ${e.description}`).join("\n")}`,
          `<report>\n${text}\n</report>`,
        ].join("\n\n"),
      },
    ]);
    return result.events;
  },
  {
    name: "fact_extraction",
    description: "Extract structured site events with a suggested category from a capture's text.",
    schema: z.object({
      text: z.string(),
      recordedAt: z.string().describe("ISO 8601 recording time"),
      context: z.any().describe("Project context from loadProjectContext"),
      taxonomy: z.any().describe("Taxonomy helpers from loadTaxonomy"),
    }),
  },
);
