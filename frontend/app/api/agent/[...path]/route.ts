/**
 * Retired. The capture pipeline is now part of the FastAPI service and is reached through /api/sm/*
 * (see lib/agent.ts). This stub only explains that to anything still calling the old path; it can be deleted.
 */
export const runtime = "nodejs";

const gone = () =>
  Response.json({ detail: "The capture agent moved into the FastAPI service. Use /api/sm/projects/{pid}/captures." }, { status: 410 });

export const GET = gone;
export const POST = gone;
