"""Notice templates: the required format of each letter type, as data.

A template fixes what a notice of a given type must show (title, header fields, closing) and which [MISSING: ...]
fields a manager may omit with a reason (G12). Every composer (workflow.compose_notice, performance.notices,
correspondence._write, daily_report.draft) takes its title and closing from here, so a project can adapt the format
without code: projects.settings.notice_templates.<type> overrides any key.

Draft text carries DRAFT_MARKER in its title line, and may carry internal notes for the reviewer. render_final turns
the approved wording into the letter that is exported: the draft marker and internal notes are removed, nothing else.
"""

from __future__ import annotations

import copy
import re

from performance.metrics import DISCLAIMER  # noqa: F401  (re-exported: one wording everywhere)

DRAFT_MARKER = "(DRAFT FOR REVIEW)"
INTERNAL_NOTE = "Internal note, remove before sending:"

_FORMAL_HEADER = ["date", "from", "to", "contract_reference", "contract_clause", "subject"]
_CONTRACT = ["contract reference", "contract clause", "supporting records"]

DEFAULTS: dict[str, dict] = {
    "delay_notice": {
        "title": "DELAY NOTICE", "label": "Delay notice", "formal": True, "header": _FORMAL_HEADER,
        "closing": "Yours faithfully,", "omittable": _CONTRACT + ["expected impact"],
        "purpose": "The event, the effect on progress and on follow-on work, and that an updated programme will follow.",
    },
    "additional_cost_notice": {
        "title": "ADDITIONAL COST NOTICE", "label": "Additional cost notice", "formal": True, "header": _FORMAL_HEADER,
        "closing": "Yours faithfully,",
        # An unknown rate or duration may be left out (no amount is stated then); it is never estimated.
        "omittable": _CONTRACT + ["idle rate", "chargeable hours", "confirmed rates (example rates used)"],
        "purpose": "The event, the standing time and resources affected, the cost breakdown, and the reservation of rights.",
    },
    "defect_notice": {
        "title": "DEFECT NOTICE", "label": "Defect notice", "formal": True, "header": _FORMAL_HEADER,
        "closing": "Yours faithfully,", "omittable": _CONTRACT + ["photo references", "crack width"],
        "purpose": "What was found, where and when, its effect, and the remedy requested.",
    },
    "notice_of_concern": {
        "title": "NOTICE OF CONCERN", "label": "Notice of concern", "formal": True, "header": _FORMAL_HEADER,
        "closing": "Yours faithfully,", "omittable": _CONTRACT + ["proposed remedy"],
        "purpose": "What was agreed or instructed, what is wrong or outstanding, the consequences, and what is required.",
    },
    "incident_notice": {
        "title": "SITE INCIDENT NOTICE", "label": "Site incident notice", "formal": True, "header": _FORMAL_HEADER,
        "closing": "Yours faithfully,", "omittable": _CONTRACT,
        "purpose": "The reported incident, its time, the people and equipment affected, and the records.",
    },
    "email": {
        "title": "EMAIL", "label": "Email", "formal": False, "header": ["to", "subject"], "closing": "Kind regards,",
        "omittable": ["supporting records"], "purpose": "A short, direct email: the facts, a clear request, a polite close.",
    },
    "daily_report": {
        "title": "DAILY SITE REPORT", "label": "Daily site report", "formal": True,
        "header": ["date", "project", "prepared_by", "weather", "shift"], "closing": "Prepared by",
        "omittable": ["weather", "shift hours", "site manager signature", "remarks"],
        "sections": ["Weather and shift", "Workforce and equipment", "Work performed against plan", "Deliveries",
                     "Disruptions and incidents", "Inspections and meetings", "Instructions received",
                     "Safety and quality", "Open items", "Photos"],
        "purpose": "The day's site record: resources, work done against plan, events, appointments and open items.",
    },
}
MISSING = re.compile(r"\[MISSING: ([^\]]+)\]")


def template(notice_type: str, project_settings: dict | None = None) -> dict:
    """The template for a notice type, with the project's overrides applied (shallow, per key)."""
    base = copy.deepcopy(DEFAULTS.get(notice_type) or DEFAULTS["delay_notice"])
    override = ((project_settings or {}).get("notice_templates") or {}).get(notice_type) or {}
    for key, value in override.items():
        if key in base and type(value) is type(base[key]):
            base[key] = value
    base["type"] = notice_type
    return base


def title_line(notice_type: str, project_settings: dict | None = None) -> str:
    return f"{template(notice_type, project_settings)['title']} {DRAFT_MARKER}"


def omittable(notice_type: str, project_settings: dict | None = None) -> list[str]:
    return list(template(notice_type, project_settings)["omittable"])


def missing_fields(body: str) -> list[str]:
    return sorted(set(MISSING.findall(body or "")))


def fill_gap(body: str, field: str, value: str) -> str:
    """Replace every [MISSING: field] with the manager's value."""
    return body.replace(f"[MISSING: {field}]", value.strip())


def omit_gap(body: str, field: str) -> str:
    """Leave a field out: a line that only states the field ("Applicable clause: [MISSING: ...]") is removed; inside a
    sentence the placeholder becomes "not stated", so no fact around it is lost."""
    marker = f"[MISSING: {field}]"
    lines = []
    for line in body.split("\n"):
        if marker in line and re.fullmatch(rf"\s*[^:\n]{{1,60}}:\s*{re.escape(marker)}\s*\.?\s*", line):
            continue
        lines.append(line.replace(marker, "not stated"))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines))


def render_final(body: str) -> str:
    """The exported letter: the approved wording without the draft marker and without internal reviewer notes."""
    out = []
    for block in body.split("\n\n"):
        if block.strip().startswith(INTERNAL_NOTE):
            continue
        out.append("\n".join(line.replace(f" {DRAFT_MARKER}", "").replace(DRAFT_MARKER, "").rstrip()
                             for line in block.split("\n")))
    return "\n\n".join(b for b in out if b.strip())
