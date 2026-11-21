"""Notice drafts for the performance suggestions (plan section 6.7), used by workflow.compose_notice.

Like the delay notice in workflow.py, the text is composed from stored records only (no model), every factual
sentence carries its citation, and contract details the records lack stay visible as [MISSING: ...] so an approver
cannot approve the draft before a person fills them in. Amounts and deadlines come from metrics.py and the plan's
rates and notice periods; an unknown rate is never estimated.
"""

from __future__ import annotations

from datetime import date
from zoneinfo import ZoneInfo

from sqlalchemy import text

from . import metrics as m
from .baseline import active_baseline, load_settings

TITLES = {"delay_notice": "DELAY NOTICE", "additional_cost_notice": "ADDITIONAL COST NOTICE",
          "defect_notice": "DEFECT NOTICE", "notice_of_concern": "NOTICE OF CONCERN"}


def _refs(items):
    out = []
    for r in items or []:
        if isinstance(r, dict) and r.get("source_id"):
            key = (r["source_id"], r["locator"])
        elif isinstance(r, str) and ":" in r:
            key = tuple(r.split(":", 1))
        else:
            continue
        if key not in out:
            out.append(key)
    return [{"source_id": s, "locator": loc} for s, loc in out]


def _tag(refs):
    return ("[" + "; ".join(f"{r['source_id']} · {r['locator']}" for r in refs) + "]") if refs else ""


def compose_performance_notice(conn, project_id, alert, as_of, notice_type):
    project = dict(conn.execute(text("SELECT * FROM sitemate.projects WHERE id=:p"), {"p": project_id}).mappings().one())
    tz = ZoneInfo(project["timezone"])
    day: date = alert["checkpoint_at"].astimezone(tz).date()
    baseline = active_baseline(conn, project_id, as_of)
    settings = load_settings(conn, project_id, baseline["id"] if baseline else None)
    cal = m.Calendar.from_settings(settings)
    rule = m.notice_rule(settings, notice_type) or {}
    calc = dict(alert["calculation"] or {})
    suggestion = dict(alert.get("suggested_notice") or {})
    code = alert["activity_code"]
    activity = conn.execute(text("SELECT name, unit FROM sitemate.activities WHERE project_id=:p AND code=:c"),
                            {"p": project_id, "c": code}).mappings().one_or_none() if code else None
    name = activity["name"] if activity else (alert.get("title") or "the works")
    evidence = _refs(alert["evidence_refs"])
    refs = list(evidence)
    paragraphs = []

    if alert["kind"] in ("shortfall", "late_start") or notice_type == "delay_notice":
        if calc.get("status") == "late_start" or alert["kind"] == "late_start":
            paragraphs.append(f"{name} ({code}) has not started. By {day:%d %B %Y} no output had been signed since its "
                              f"planned start, {calc.get('days_late')} working days late. {_tag(evidence)}")
        else:
            paragraphs.append(f"The signed daily report records {calc.get('actual')} {calc.get('unit') or ''} of {name} "
                              f"({code}) against {calc.get('planned')} {calc.get('unit') or ''} scheduled for "
                              f"{day:%d %B %Y}, {calc.get('shortfall_pct')}% short. {_tag(evidence)}")
    if alert["kind"] == "equipment_idle":
        equipment = calc.get("equipment_id")
        meta = conn.execute(text("SELECT description, owner_id FROM sitemate.equipment WHERE project_id=:p AND id=:e"),
                            {"p": project_id, "e": equipment}).mappings().one_or_none()
        desc = f" ({meta['description'].lower()})" if meta else ""
        paragraphs.append(f"On {day:%d %B %Y}, {equipment}{desc} assigned to {name} was idle for {calc.get('hours')} hours "
                          f"of the shift. {_tag(evidence)}")
    if alert["kind"] == "quality_hold":
        paragraphs.append(f"On {day:%d %B %Y} the records note: “{calc.get('text') or alert.get('title')}” {_tag(evidence)}")

    attribution = suggestion.get("reason")
    if attribution:
        cause_refs = _refs(suggestion.get("refs"))
        refs += [r for r in cause_refs if r not in refs]
        paragraphs.append(f"Recorded reason: {attribution}. This attribution is advisory and is based on the cited "
                          f"records. {_tag(cause_refs)}")

    if notice_type == "additional_cost_notice":
        rate = calc.get("rate") or m.equipment_rate(settings, calc.get("equipment_id"), None)
        amount = suggestion.get("amount")
        if rate and rate.get("amount") is not None and amount is not None:
            rate_refs = _refs(rate.get("refs"))
            refs += [r for r in rate_refs if r not in refs]
            paragraphs.append(f"The agreed {rate.get('kind', 'idle').replace('_', ' ')} rate is {rate['amount']} "
                              f"{rate.get('currency') or ''} per {rate.get('per')}. {_tag(rate_refs)} "
                              f"The indicative additional cost for this event is {amount} {rate.get('currency') or ''} "
                              f"({suggestion.get('calculation')}). We reserve the right to update this figure.")
        else:
            paragraphs.append("Indicative cost: [MISSING: idle rate] x [MISSING: chargeable hours]. No cost figure is "
                              "stated until the rate is confirmed.")
    if notice_type == "defect_notice":
        paragraphs.append("Location: [MISSING: exact location]. Photos: [MISSING: photo references]. We ask you to "
                          "inspect and confirm the remedy before work in this area continues.")
    if notice_type == "notice_of_concern":
        paragraphs.append("Our concern: [MISSING: concern in one sentence]. Proposed remedy: [MISSING: proposed remedy]. "
                          "We ask for your instruction before proceeding.")
    if notice_type == "delay_notice":
        paragraphs.append("Expected effect on the programme: [MISSING: expected impact]. We will update you once the "
                          "effect can be assessed.")

    deadline = suggestion.get("deadline") or (m.notice_deadline(day, rule, cal).isoformat() if rule else None)
    rule_refs = _refs(rule.get("refs"))
    refs += [r for r in rule_refs if r not in refs]
    if deadline:
        period = (f"within {rule['deadline_wd']:g} working days of the event" if rule.get("deadline_wd") else
                  "immediately")
        paragraphs.append(f"Notice period: {period} (by {deadline} on the project calendar). {_tag(rule_refs)}".rstrip())
    paragraphs.append("Please confirm receipt of this notice.")

    sender = project["sender"] or "[MISSING: sender]"
    recipient = project["recipient"] or rule.get("addressee_name") or rule.get("addressee_role") or "[MISSING: recipient]"
    header = [f"{TITLES[notice_type]} (DRAFT FOR REVIEW)", f"{day:%d %B %Y} | {project['name']}", f"From: {sender}",
              f"To: {recipient}",
              f"Contract reference: {project['contract_reference'] or '[MISSING: contract reference]'}",
              f"Applicable clause: {project['contract_clause'] or '[MISSING: contract clause]'}", "",
              f"Subject: {TITLES[notice_type].title()} – {name}" + (f" ({code})" if code else ""), "",
              f"Dear {recipient.split(',')[0]},"]
    body = "\n".join(header) + "\n\n" + "\n\n".join(paragraphs) + f"\n\n{sender.split(',')[0]}" + \
        f"\n\nInternal note, remove before sending: {m.DISCLAIMER}"
    return body, refs
