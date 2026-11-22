"""Read-only tools for Ask SiteMate.

Each tool is a plain function over one project's records as of the replay clock. The project, the clock and the
caller's role are bound on the server (ToolContext); the model only supplies the arguments in each tool's schema.
Every tool returns compact JSON for the model and registers the passages it shows (source_id:locator -> text), so the
answer can only cite passages a tool actually returned in this turn. Passages are always re-read with the as_of filter,
so a tool can never leak a record that was not available yet.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime

from sqlalchemy import text

MAX_PASSAGES = 40
CUTOFF = "coalesce(CAST(:cutoff AS timestamptz), 'infinity')"


@dataclass
class ToolContext:
    conn: object
    project_id: str
    as_of: datetime
    role: str
    passages: dict[str, dict] = field(default_factory=dict)   # "S:L" -> {text, kind, title, untrusted, available_at}
    calls: list[dict] = field(default_factory=list)            # name, arguments, result counts (audit)
    outputs: list[str] = field(default_factory=list)           # every JSON result (number check)

    def register(self, refs) -> list[str]:
        """Load the text of these refs (as of the clock) into the passage registry; returns the refs that exist."""
        wanted = []
        for r in refs or []:
            key = r if isinstance(r, str) else (f"{r.get('source_id')}:{r.get('locator')}" if isinstance(r, dict) else None)
            if key and ":" in key and key not in wanted:
                wanted.append(key)
        new = [k for k in wanted if k not in self.passages][: max(0, MAX_PASSAGES - len(self.passages))]
        if new:
            pairs = [k.split(":", 1) for k in new]
            rows = self.conn.execute(text(f"""
                SELECT sp.source_id, sp.locator, sp.excerpt, sp.untrusted, s.kind, s.title, s.available_at
                FROM sitemate.source_passages sp JOIN sitemate.sources s ON (s.project_id, s.id) = (sp.project_id, sp.source_id)
                WHERE sp.project_id = :p AND s.available_at <= {CUTOFF}
                  AND (sp.source_id, sp.locator) IN (SELECT * FROM unnest(CAST(:s AS text[]), CAST(:l AS text[])))"""),
                {"p": self.project_id, "cutoff": self.as_of, "s": [a for a, _ in pairs], "l": [b for _, b in pairs]})
            for r in rows.mappings():
                self.passages[f"{r['source_id']}:{r['locator']}"] = {
                    "text": r["excerpt"], "kind": r["kind"], "title": r["title"], "untrusted": bool(r["untrusted"]),
                    "available_at": r["available_at"].isoformat()}
        return [k for k in wanted if k in self.passages]


def _j(value):
    return json.loads(json.dumps(value, default=lambda o: o.isoformat() if isinstance(o, (date, datetime)) else str(o)))


def _day(value, ctx):
    try:
        return date.fromisoformat(value) if value else None
    except ValueError:
        raise ToolError("Dates are YYYY-MM-DD") from None


class ToolError(ValueError):
    pass


def _passages_view(ctx, refs):
    return [{"ref": k, "text": ctx.passages[k]["text"][:600], "kind": ctx.passages[k]["kind"],
             "untrusted": ctx.passages[k]["untrusted"]} for k in refs if k in ctx.passages]


# ------------------------------------------------------------------ tools

def search_records(ctx: ToolContext, query: str, limit: int = 8) -> dict:
    from documents.search import search
    found = search(ctx.conn, ctx.project_id, query, as_of=ctx.as_of, limit=max(1, min(int(limit or 8), 10)),
                   use_rerank=False)["results"]
    refs = ctx.register([{"source_id": r["source_id"], "locator": r["locator"]} for r in found])
    return {"results": [{**p, "title": ctx.passages[p["ref"]]["title"],
                         "available_at": ctx.passages[p["ref"]]["available_at"]} for p in _passages_view(ctx, refs)]}


def get_site_day(ctx: ToolContext, date_: str | None = None) -> dict:
    import workflow
    day = workflow.site_day(ctx.project_id, date_, ctx.as_of, ctx.conn)
    refs, rows = [], []
    for a in day["activities"]:
        cited = [x for x in (a.get("plan_ref"), a.get("actual_ref"), (a.get("estimate") or {}).get("ref")) if x]
        keys = ctx.register(cited)
        refs += keys
        rows.append({"code": a["code"], "name": a["name"], "unit": a["unit"], "planned": a["planned"],
                     "actual_signed": a["actual"], "estimate": (a.get("estimate") or {}).get("value"),
                     "shortfall_pct": a["shortfall_pct"], "severity": a["severity"], "status": a["status"],
                     "equipment": [e["id"] for e in a.get("equipment") or []], "refs": keys})
    return {"date": day["date"], "threshold_pct": day["threshold"], "high_threshold_pct": day["high_threshold"],
            "activities": rows, "passages": _passages_view(ctx, refs)}


def get_daily_evaluation(ctx: ToolContext, date_: str) -> dict:
    from performance.daily import daily_view
    view = daily_view(ctx.conn, ctx.project_id, _day(date_, ctx), as_of=ctx.as_of)
    if view is None:
        return {"date": date_, "found": False, "note": "No daily evaluation is stored for this day at this time."}
    summary = view.get("summary") or {}
    refs = []
    items = []
    for key in ("headline",):
        h = summary.get(key) or {}
        if h.get("text"):
            items.append({"section": "headline", "text": h["text"], "refs": ctx.register(h.get("refs"))})
    for section, values in summary.items():
        if isinstance(values, list):
            for v in values[:6]:
                if isinstance(v, dict) and v.get("text"):
                    items.append({"section": section, "text": v["text"], "refs": ctx.register(v.get("refs"))})
    acts = []
    for a in view["activities"]:
        keys = ctx.register(a.get("refs"))
        attr = a.get("attribution") or {}
        keys += ctx.register(attr.get("refs"))
        refs += keys
        acts.append({"code": a["code"], "planned": a["planned"], "actual": a["actual"], "variance_pct": a["variance_pct"],
                     "status": a["status"], "severity": a["severity"],
                     "cause": attr.get("cause_category"), "cause_explanation": attr.get("explanation"), "refs": keys})
    for i in items:
        refs += i["refs"]
    return {"date": view["work_date"], "found": True, "day_status": view["day_status"], "day_score": view["day_score"],
            "provisional": view["provisional"], "summary": items, "activities": acts,
            "suggestions": [{"type": s["type"], "deadline": s["deadline"], "reason": s["reason"],
                             "refs": ctx.register(s.get("refs"))} for s in view["suggestions"]],
            "passages": _passages_view(ctx, dict.fromkeys(refs))}


def get_performance(ctx: ToolContext, date_: str) -> dict:
    from performance.overall import snapshot_view
    view = snapshot_view(ctx.conn, ctx.project_id, _day(date_, ctx), ctx.as_of)
    if view is None:
        return {"date": date_, "found": False, "note": "No overall performance snapshot is stored for this date."}
    m = view.get("metrics") or {}
    keep = {k: m.get(k) for k in ("weighted_planned_pct", "weighted_actual_pct", "spi", "spi_band", "overall_status",
                                  "forecast_completion", "completion_variance_wd", "score")}
    return {"date": str(date_), "found": True, "metrics": keep,
            "activities": [{k: a.get(k) for k in ("code", "planned_cum", "actual_cum", "backlog", "days_behind",
                                                   "forecast_finish", "finish_variance_wd")}
                           for a in (m.get("activities") or [])[:20]],
            "milestones": [{k: x.get(k) for k in ("code", "name", "planned_date", "forecast_date", "variance_wd")}
                           for x in (m.get("milestones") or [])[:12]]}


def list_alerts(ctx: ToolContext, kind: str = "all", status: str | None = None) -> dict:
    import main
    rows = main.alerts(ctx.project_id, ctx.as_of, status, kind or "all", ctx.conn)[:25]
    refs, out = [], []
    for a in rows:
        keys = ctx.register(a.get("evidence_refs"))
        refs += keys
        calc = a.get("calculation") or {}
        out.append({"id": str(a["id"]), "kind": a["kind"], "activity_code": a["activity_code"], "status": a["status"],
                    "severity": a["severity"], "checkpoint_at": a["checkpoint_at"], "title": a.get("title"),
                    "calculation": {k: calc.get(k) for k in ("planned", "actual", "shortfall_pct", "unit", "hours",
                                                              "equipment_id", "text") if calc.get(k) is not None},
                    "refs": keys})
    return _j({"alerts": out, "passages": _passages_view(ctx, dict.fromkeys(refs))})


def list_incidents(ctx: ToolContext, open_only: bool = True) -> dict:
    import main
    rows = main.incident_rows(ctx.conn, ctx.project_id, ctx.as_of)
    out, refs = [], []
    for i in rows:
        if open_only and i.get("status") in ("resolved", "closed"):
            continue
        keys = ctx.register(i.get("refs"))
        refs += keys
        out.append({k: i.get(k) for k in ("id", "title", "status", "severity", "occurred_at", "resolved_at",
                                          "activity_code", "zone", "summary", "affected_workers", "equipment_id",
                                          "report_count")} | {"refs": keys})
    return _j({"incidents": out[:20], "passages": _passages_view(ctx, dict.fromkeys(refs))})


def list_action_items(ctx: ToolContext, include_completed: bool = False) -> dict:
    from documents import routes as droutes
    rows = droutes.action_items(ctx.project_id, ctx.as_of, bool(include_completed), ctx.conn)[:25]
    refs = ctx.register([r["ref"] for r in rows])
    return _j({"action_items": [{"description": r["description"], "owner": r["owner_name"], "due_at": r["due_at"],
                                 "completed_at": r["completed_at"], "overdue": r["overdue"],
                                 "ref": f"{r['source_id']}:{r['locator']}"} for r in rows],
               "passages": _passages_view(ctx, refs)})


def list_drafts(ctx: ToolContext) -> dict:
    if ctx.role not in ("manager", "approver"):
        raise ToolError("Notices are visible to managers and approvers only")
    import workflow
    views = workflow.list_drafts(ctx.project_id, ctx.as_of, {"role": ctx.role}, ctx.conn)
    return _j({"drafts": [{"id": v["id"], "type": v["kind_label"], "title": v["title"], "status": v["status"],
                           "version": v["latest"]["version"], "missing": v["latest"]["missing_fields"]}
                          for v in views[:20]]})


def _schema(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}


DATE = {"type": "string", "description": "YYYY-MM-DD (project local date)"}
TOOLS = {
    "search_records": (search_records, "Full-text search over the project's records (reports, diary, minutes, emails, "
                       "voice notes, photos). Returns cited passages.",
                       _schema({"query": {"type": "string"}, "limit": {"type": "integer"}}, ["query", "limit"])),
    "get_site_day": (get_site_day, "Plan against signed and estimated quantities for every activity planned on a day, "
                     "with shortfall and severity computed by the system.",
                     _schema({"date": DATE}, ["date"])),
    "get_daily_evaluation": (get_daily_evaluation, "The stored daily performance evaluation of a day: cited summary, "
                             "per-activity status, cause attribution and suggested notices.",
                             _schema({"date": DATE}, ["date"])),
    "get_performance": (get_performance, "The stored overall performance snapshot to a date: weighted progress, SPI, "
                        "forecast completion, per-activity backlog and milestone forecasts.",
                        _schema({"date": DATE}, ["date"])),
    "list_alerts": (list_alerts, "Alerts (shortfall, incident, late start, idle equipment, missing report, quality, "
                    "concern) with their calculation and evidence.",
                    _schema({"kind": {"type": "string", "enum": ["all", "shortfall", "incident", "performance"]},
                             "status": {"anyOf": [{"type": "string", "enum": ["open", "acknowledged", "in_progress",
                                                                               "resolved", "dismissed"]},
                                                  {"type": "null"}]}},
                            ["kind", "status"])),
    "list_incidents": (list_incidents, "Site incidents (equipment, delivery, quality, safety...) and their status.",
                       _schema({"open_only": {"type": "boolean"}}, ["open_only"])),
    "list_action_items": (list_action_items, "Agreed actions from minutes, emails and diaries, with owner and due time "
                          "only where the record states them.",
                          _schema({"include_completed": {"type": "boolean"}}, ["include_completed"])),
    "list_drafts": (list_drafts, "Notices and letters being drafted or approved (managers and approvers only).",
                    _schema({}, [])),
}


def definitions(role: str) -> list[dict]:
    return [{"name": name, "description": desc, "strict": True, "input_schema": schema}
            for name, (_, desc, schema) in TOOLS.items() if name != "list_drafts" or role in ("manager", "approver")]


def run(ctx: ToolContext, name: str, arguments: dict) -> tuple[str, bool]:
    """Run one tool. Returns (JSON result, is_error)."""
    entry = TOOLS.get(name)
    if entry is None:
        return json.dumps({"error": f"Unknown tool {name}"}), True
    fn, _, schema = entry
    args = {k: v for k, v in (arguments or {}).items() if k in schema["properties"]}
    if "date" in args:
        args["date_"] = args.pop("date")
    try:
        result = _j(fn(ctx, **args))
    except ToolError as exc:
        ctx.calls.append({"name": name, "arguments": arguments, "error": str(exc)})
        return json.dumps({"error": str(exc)}), True
    except Exception as exc:  # noqa: BLE001 - a failing read is reported to the model, never raised to the user
        ctx.calls.append({"name": name, "arguments": arguments, "error": type(exc).__name__})
        return json.dumps({"error": f"The {name} read failed ({type(exc).__name__})"}), True
    out = json.dumps(result)
    ctx.outputs.append(out)
    ctx.calls.append({"name": name, "arguments": arguments, "passages": len(ctx.passages), "bytes": len(out)})
    return out, False
