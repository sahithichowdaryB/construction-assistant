import { Annotation, END, MemorySaver, START, StateGraph, interrupt } from "@langchain/langgraph";
import { config } from "../config.js";
import { loadBusinessRules, loadProjectContext } from "./context.js";
import { loadTaxonomy } from "./taxonomy.js";

const value = () => Annotation({ reducer: (_, next) => next, default: () => null });

export const CaptureState = Annotation.Root({
  projectId: value(),
  captureId: value(),
  sourceId: value(),
  capturedBy: value(),
  attachments: value(),      // [{ n, kind: 'image', key, mime }] already stored on disk
  transcript: value(),       // spoken or typed text
  perception: value(),       // [{ n, passage }] photo descriptions
  inputText: value(),        // transcript + photo descriptions, what the classifier reads
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

const BLANK_EVENT = {
  occurred_at: null, zone: null, activity_code: null, equipment_id_spoken: null, equipment_description: null,
  material: null, quantity: null, unit: null, quantity_basis: null, outstanding_quantity: null,
  workers_affected: null, expected_restart_at: null, location: null, description: null,
};

/** Synthetic per-category rules for event types that have no business_rules row of their own. */
export function categoryRules(events, rules, taxonomy) {
  const covered = new Set(rules.filter((r) => r.required_fields?.length).map((r) => r.event_type));
  const out = []; const seen = new Set();
  for (const e of events) {
    const cat = taxonomy.category(e.category);
    if (!cat?.required_fields?.length || covered.has(e.event_type) || seen.has(e.event_type)) continue;
    seen.add(e.event_type);
    out.push({ rule_key: `category.${cat.key}.required`, event_type: e.event_type, required_fields: cat.required_fields,
      ask_if_missing: true, description: `A ${cat.label.toLowerCase()} report should record: ${cat.required_fields.join(", ")}.` });
  }
  return out;
}

/** Apply the user's decisions to the suggested events. Unmentioned events keep the AI suggestion. */
export function applyCategoryDecisions(events, resume, taxonomy) {
  const decisions = new Map((resume?.events ?? []).map((d) => [d.index, d]));
  const kept = [];
  events.forEach((event, i) => {
    const d = decisions.get(i);
    if (d && d.keep === false) return;
    const { category, event_type } = taxonomy.normalise(d?.category ?? event.suggested_category, d?.event_type ?? event.suggested_event_type);
    kept.push({ ...event, category, event_type, user_changed: category !== event.suggested_category || event_type !== event.suggested_event_type });
  });
  for (const a of resume?.added ?? []) {
    const summary = String(a.summary ?? "").trim();
    if (!summary) continue;
    const { category, event_type } = taxonomy.normalise(a.category, a.event_type);
    kept.push({ ...BLANK_EVENT, summary, evidence_quote: summary, category, event_type, suggested_category: null,
      suggested_event_type: null, confidence: null, rationale: "Added by the user", alternatives: [], user_changed: true });
  }
  return kept;
}

/** Wire the capture graph. Every external effect is a dependency so tests can supply fakes. */
export function buildCaptureGraph(deps, checkpointer) {
  const graph = new StateGraph(CaptureState)
    .addNode("loadContext", async (s) => ({ context: await loadProjectContext(s.projectId) }))

    // [1] Intake: describe photos so they become citable passages; text/transcript passes straight through.
    .addNode("perceive", async (s) => {
      const perception = [];
      for (const a of (s.attachments ?? []).filter((x) => x.kind === "image")) {
        const description = await deps.describePhoto(a, s.transcript);
        perception.push({ n: a.n, passage: deps.photoPassage(description) });
      }
      const parts = [s.transcript, ...perception.map((p) => `[Photo ${p.n}] ${p.passage}`)].filter(Boolean);
      return { perception, inputText: parts.join("\n\n") };
    })

    // [2] Classification: split into events and SUGGEST a category; the user decides next.
    .addNode("extractFacts", async (s) => {
      const taxonomy = await loadTaxonomy(s.projectId);
      const events = await deps.extractFacts({ text: s.inputText, recordedAt: s.recordedAt, context: s.context, taxonomy });
      return {
        events: events.map((e) => {
          const { category, event_type } = taxonomy.normalise(e.suggested_category, e.suggested_event_type);
          return { ...e, suggested_category: category, suggested_event_type: event_type, category, event_type,
            confidence: Math.min(1, Math.max(0, Number(e.confidence) || 0)) };
        }),
      };
    })

    // Pause: the user has the final say on category and type. Resume with { events:[{index,category,event_type,keep}], added }.
    .addNode("confirmCategories", async (s) => {
      const taxonomy = await loadTaxonomy(s.projectId);
      const resume = interrupt({
        kind: "categories",
        events: s.events.map((e, index) => ({
          index, summary: e.summary, suggested_category: e.suggested_category, suggested_event_type: e.suggested_event_type,
          confidence: e.confidence, rationale: e.rationale, alternatives: e.alternatives ?? [],
        })),
      });
      return { events: applyCategoryDecisions(s.events, resume, taxonomy) };
    })

    .addNode("searchDatabase", async (s) => {
      const taxonomy = await loadTaxonomy(s.projectId);
      const rules = (await loadBusinessRules(s.events.map((e) => e.event_type))).filter((r) => !r.rule_key.endsWith(".duplicate"));
      return {
        matches: await deps.searchDatabase({
          projectId: s.projectId, events: s.events, timezone: s.context.project.timezone, recordedAt: s.recordedAt,
        }),
        rules: [...rules, ...categoryRules(s.events, rules, taxonomy)],
      };
    })

    .addNode("matchRelationships", async (s) => ({
      relationships: await deps.matchRelationships({ projectId: s.projectId, matches: s.matches }),
    }))

    .addNode("validateAndAsk", async (s) => {
      const result = await deps.validate({
        transcript: s.inputText, events: s.events, matches: s.matches, relationships: s.relationships,
        rules: s.rules, answers: s.answers, recordedAt: s.recordedAt,
      });
      return { validation: deps.enforceRequiredFields(result, s.events, s.rules, s.answers) };
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

    // [3][4] correlation + severity + persistence happen in one transaction inside updateProjectMemory.
    .addNode("updateMemory", async (s) => ({ result: await deps.persist(s) }))

    .addEdge(START, "loadContext")
    .addEdge("loadContext", "perceive")
    .addEdge("perceive", "extractFacts")
    .addConditionalEdges("extractFacts", (s) => (s.events.length ? "confirmCategories" : END))
    .addConditionalEdges("confirmCategories", (s) => (s.events.length ? "searchDatabase" : END))
    .addEdge("searchDatabase", "matchRelationships")
    .addEdge("matchRelationships", "validateAndAsk")
    .addConditionalEdges("validateAndAsk", (s) =>
      s.validation.questions.length && s.round < config.maxQuestionRounds ? "askManager" : "updateMemory")
    .addEdge("askManager", "validateAndAsk")
    .addEdge("updateMemory", END);
  return graph.compile({ checkpointer });
}

async function defaultDeps() {
  const [{ describePhoto, photoPassage }, { factExtractionTool }, { databaseSearchTool }, { relationshipMatchingTool },
    { enforceRequiredFields, questionGenerationTool }, { updateProjectMemory }, { imageStorage }] = await Promise.all([
    import("./tools/perception.js"), import("./tools/factExtraction.js"), import("./tools/databaseSearch.js"),
    import("./tools/relationshipMatching.js"), import("./tools/questionGeneration.js"), import("./memory.js"),
    import("../services/files.js"),
  ]);
  return {
    describePhoto: async (a, hint) => describePhoto({ mime: a.mime, data: await imageStorage.get(a.key) }, hint),
    photoPassage,
    extractFacts: (input) => factExtractionTool.invoke(input),
    searchDatabase: (input) => databaseSearchTool.invoke(input),
    matchRelationships: (input) => relationshipMatchingTool.invoke(input),
    validate: (input) => questionGenerationTool.invoke(input),
    enforceRequiredFields,
    persist: (s) => updateProjectMemory(s),
  };
}

async function makeCheckpointer() {
  if (config.checkpointer === "memory") return new MemorySaver();
  const [{ PostgresSaver }, { makePool }] = await Promise.all([
    import("@langchain/langgraph-checkpoint-postgres"), import("../database/pool.js")]);
  const saver = new PostgresSaver(makePool(3), undefined, { schema: config.checkpointSchema });
  // Tables are created by `npm run setup:checkpoints` (needs DDL rights); set AGENT_CHECKPOINT_AUTOSETUP=1 for local dev.
  if (process.env.AGENT_CHECKPOINT_AUTOSETUP === "1") await saver.setup();
  return saver;
}

let agent;
/** The compiled capture agent, created once. Checkpoints live in Postgres so a paused capture survives restarts. */
export const getCaptureAgent = () => (agent ??= (async () => buildCaptureGraph(await defaultDeps(), await makeCheckpointer()))());
