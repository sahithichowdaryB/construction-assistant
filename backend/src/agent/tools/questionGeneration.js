import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { structured } from "../llm.js";
import { ValidationResult } from "../schemas.js";

const validator = structured(ValidationResult, "validated_capture");

const SYSTEM = `You validate a construction site capture against the project's business rules.
You receive: the transcript, the events extracted from it, matching database records, relationships
between those records, the business rules, and any answers the site manager has already given.

For every event:
1. Produce validated_facts: one per field you can stand behind. Use the event's own fields, the manager's
   answers, and database records. Values taken from the database must be marked basis "inferred" and cite
   evidence_refs from the supplied passages when one supports them. Times stay ISO 8601 with offset.
   Always include the event's required fields when known, plus useful extras (e.g. impact, successor at risk).
2. Apply each rule. When a required field is still unknown, add it to "missing" and, if the rule says
   ask_if_missing, write one short question for the manager. Offer options drawn from the database when
   there are candidates (e.g. the machines assigned to the activity that day).
3. Do not ask about anything the transcript, an answer or an unambiguous database record already settles.
4. Flag duplicates of existing open incidents, and incidents this note resolves (e.g. a repair release).
Never invent values. An answer of "unknown" or "skip" means record the field as missing without asking again.`;

export const questionGenerationTool = tool(
  async ({ transcript, events, matches, relationships, rules, answers, recordedAt }) =>
    validator.invoke([
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          recorded_at: recordedAt, transcript, events, database_matches: matches, relationships,
          business_rules: rules, manager_answers: answers,
        }, null, 1),
      },
    ]),
  {
    name: "question_generation",
    description: "Apply business rules to extracted events plus DB context; return validated facts, missing "
      + "fields and the questions to ask the site manager.",
    schema: z.object({
      transcript: z.string(),
      events: z.array(z.any()),
      matches: z.array(z.any()),
      relationships: z.array(z.any()),
      rules: z.array(z.any()),
      answers: z.array(z.object({
        id: z.string(), event_index: z.number(), field_name: z.string(), question: z.string(), answer: z.string(),
      })),
      recordedAt: z.string(),
    }),
  },
);

/**
 * Deterministic guard: the LLM must not silently drop a required field. Any required field with no fact,
 * no question and no prior answer gets a generic question (or stays missing if the rule says not to ask).
 */
export function enforceRequiredFields(result, events, rules, answers) {
  const answered = new Set(answers.map((a) => `${a.event_index}:${a.field_name}`));
  const has = (list, i, f) => list.some((x) => x.event_index === i && x.field_name === f);
  events.forEach((event, i) => {
    for (const rule of rules.filter((r) => r.event_type === event.event_type)) {
      for (const field of rule.required_fields) {
        if (has(result.validated_facts, i, field) || answered.has(`${i}:${field}`)) continue;
        if (!has(result.missing, i, field)) {
          result.missing.push({ event_index: i, field_name: field, rule_key: rule.rule_key, why: "required by rule" });
        }
        if (rule.ask_if_missing && !has(result.questions, i, field)) {
          result.questions.push({
            id: `q${i}_${field}`, event_index: i, field_name: field, options: null,
            question: `For "${event.summary}": what is the ${field.replaceAll("_", " ")}?`,
          });
        }
      }
    }
  });
  return result;
}
