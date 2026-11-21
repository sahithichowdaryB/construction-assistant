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
  result: value(),
});

// voice -> (Whisper, done in the route) -> text -> Claude fills JSON -> SQL search -> relationships
// -> rules + questions -> [ask manager -> back to Claude]* -> update project memory
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
    const { answers = [] } = interrupt({ questions: s.validation.questions, round: s.round + 1 });
    const byId = new Map(answers.map((a) => [a.id, String(a.answer ?? "").trim()]));
    return {
      round: s.round + 1,
      answers: s.validation.questions.map((q) => ({
        id: q.id, event_index: q.event_index, field_name: q.field_name, question: q.question,
        answer: byId.get(q.id) || "unknown",
      })),
    };
  })

  .addNode("updateMemory", async (s) => ({ result: await updateProjectMemory(s) }))

  .addEdge(START, "loadContext")
  .addEdge("loadContext", "extractFacts")
  .addConditionalEdges("extractFacts", (s) => (s.events.length ? "searchDatabase" : END))
  .addEdge("searchDatabase", "matchRelationships")
  .addEdge("matchRelationships", "validateAndAsk")
  .addConditionalEdges("validateAndAsk", (s) =>
    s.validation.questions.length && s.round < config.maxQuestionRounds ? "askManager" : "updateMemory")
  .addEdge("askManager", "validateAndAsk")
  .addEdge("updateMemory", END);

// In-memory checkpoints: a paused capture is lost on restart. Use @langchain/langgraph-checkpoint-postgres in production.
export const captureAgent = graph.compile({ checkpointer: new MemorySaver() });
