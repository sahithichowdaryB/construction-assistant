import { Annotation, END, MemorySaver, START, StateGraph, interrupt } from "@langchain/langgraph";
import { config } from "../config.js";
import { loadBusinessRules, loadProjectContext } from "./context.js";
import { updateProjectMemory } from "./memory.js";
import { databaseSearchTool } from "./tools/databaseSearch.js";
import { factExtractionTool } from "./tools/factExtraction.js";
import { relationshipMatchingTool } from "./tools/relationshipMatching.js";
import { enforceRequiredFields, questionGenerationTool } from "./tools/questionGeneration.js";

const value = () => Annotation({ reducer: (_, next) => next, default: () => null });

const CaptureState = Annotation.Root({
  projectId: value(),
  sourceId: value(),
  author: value(),
  authorRole: value(),
  storagePath: value(),
  transcript: value(),
  recordedAt: value(),
  context: value(),
  events: value(),
  matches: value(),
  relationships: value(),
  rules: value(),
  validation: value(),
  answers: Annotation({ reducer: (prev, next) => prev.concat(next), default: () => [] }),
  round: Annotation({ reducer: (_, next) => next, default: () => 0 }),
  reviewNotes: Annotation({ reducer: (_, next) => next, default: () => [] }),
  discarded: value(),
  result: value(),
});

// voice -> (Whisper, done in the route) -> text -> Claude fills JSON -> SQL search -> relationships
// -> rules + questions -> [ask manager -> back to Claude]* -> speaker reviews/edits the facts -> update project memory
const graph = new StateGraph(CaptureState)
  .addNode("loadContext", async (s) => ({ context: await loadProjectContext(s.projectId) }))

  .addNode("extractFacts", async (s) => ({
    events: await factExtractionTool.invoke({ transcript: s.transcript, recordedAt: s.recordedAt, context: s.context }),
  }))

  .addNode("searchDatabase", async (s) => ({
    matches: await databaseSearchTool.invoke({
      projectId: s.projectId, events: s.events, timezone: s.context.project.timezone, recordedAt: s.recordedAt,
    }),
    rules: await loadBusinessRules(s.events.map((e) => e.event_type)),
  }))

  .addNode("matchRelationships", async (s) => ({
    relationships: await relationshipMatchingTool.invoke({ projectId: s.projectId, matches: s.matches }),
  }))

  .addNode("validateAndAsk", async (s) => {
    const result = await questionGenerationTool.invoke({
      transcript: s.transcript, events: s.events, matches: s.matches, relationships: s.relationships,
      rules: s.rules, answers: s.answers, recordedAt: s.recordedAt,
    });
    return { validation: enforceRequiredFields(result, s.events, s.rules, s.answers) };
  })

  // Pauses the run; the HTTP layer returns the questions and resumes with Command({ resume: { answers } }).
  .addNode("askManager", (s) => {
    const { answers = [] } = interrupt({ kind: "questions", questions: s.validation.questions, round: s.round + 1 });
    const byId = new Map(answers.map((a) => [a.id, String(a.answer ?? "").trim()]));
    return {
      round: s.round + 1,
      answers: s.validation.questions.map((q) => ({
        id: q.id, event_index: q.event_index, field_name: q.field_name, question: q.question,
        answer: byId.get(q.id) || "unknown",
      })),
    };
  })

  // Last chance for the person who spoke to correct or drop what was extracted, before anything is written.
  // Resume value: { edits: [{ index, value }], removed: [index], additions: [{ event_index, field_name, value }], discard: boolean }.
  // Additions may only fill a gap the rules reported as missing.
  .addNode("reviewFacts", (s) => {
    const facts = s.validation.validated_facts;
    const decision = interrupt({
      kind: "review",
      facts: facts.map((f, index) => ({ index, event_index: f.event_index, field_name: f.field_name, value: f.value, basis: f.basis })),
      gaps: s.validation.missing,
    });
    if (decision?.discard) return { discarded: true };

    const valid = (i) => Number.isInteger(i) && i >= 0 && i < facts.length;
    const removed = new Set((decision?.removed ?? []).filter(valid));
    const edits = new Map((decision?.edits ?? []).filter((e) => valid(e?.index) && typeof e.value === "string" && e.value.trim()).map((e) => [e.index, e.value.trim()]));
    const reviewNotes = [];
    const reviewed = [];
    facts.forEach((f, index) => {
      if (removed.has(index)) return;
      const next = edits.get(index);
      if (next === undefined || next === String(f.value)) return reviewed.push(f);
      reviewNotes.push({ id: String(index), text: `Corrected ${f.field_name.replaceAll("_", " ")}: "${f.value}" -> "${next}"` });
      reviewed.push({ ...f, value: next, basis: "reported", source: `review:${index}`, evidence_refs: [], reasoning: "Corrected by the speaker before saving" });
    });

    const gapKey = (g) => `${g?.event_index}:${g?.field_name}`;
    const open = new Map(s.validation.missing.map((g) => [gapKey(g), g]));
    (decision?.additions ?? []).forEach((a, n) => {
      const value = typeof a?.value === "string" ? a.value.trim() : "";
      if (!value || !open.has(gapKey(a))) return;
      open.delete(gapKey(a));
      reviewNotes.push({ id: `add${n}`, text: `Added ${a.field_name.replaceAll("_", " ")}: "${value}"` });
      reviewed.push({
        event_index: a.event_index, field_name: a.field_name, value, basis: "reported", source: `review:add${n}`,
        evidence_refs: [], reasoning: "Supplied by the speaker before saving",
      });
    });
    return {
      validation: { ...s.validation, validated_facts: reviewed, missing: [...open.values()] },
      reviewNotes,
      discarded: false,
    };
  })

  .addNode("updateMemory", async (s) => ({ result: await updateProjectMemory(s) }))

  .addEdge(START, "loadContext")
  .addEdge("loadContext", "extractFacts")
  .addConditionalEdges("extractFacts", (s) => (s.events.length ? "searchDatabase" : END))
  .addEdge("searchDatabase", "matchRelationships")
  .addEdge("matchRelationships", "validateAndAsk")
  .addConditionalEdges("validateAndAsk", (s) =>
    s.validation.questions.length && s.round < config.maxQuestionRounds ? "askManager" : "reviewFacts")
  .addEdge("askManager", "validateAndAsk")
  .addConditionalEdges("reviewFacts", (s) => (s.discarded ? END : "updateMemory"))
  .addEdge("updateMemory", END);

// In-memory checkpoints: a paused capture is lost on restart. Use @langchain/langgraph-checkpoint-postgres in production.
export const captureAgent = graph.compile({ checkpointer: new MemorySaver() });
