"""Prompt P5: the remarks of the daily site report (Daily Report Drafter).

The report's figures (planned against signed quantities, idle equipment, incidents, appointments, open actions) are
written by code. P5 adds only the cited prose a site report needs around them: weather and shift conditions, workforce
and plant on site, deliveries, instructions received, safety and quality observations, open items and a short remarks
paragraph. Every item cites the passages of that day; the server drops anything uncited or with an unsupported number
(performance.prompts.validate_items), exactly as for the day summary P2.
"""

from performance.prompts import NUMBER_RULE, REF_RULE, SECURITY, STR_OR_NULL, _cited, _list

P5_SECTIONS = ("weather", "workforce", "deliveries", "instructions_received", "safety_quality", "open_items", "remarks")

P5_SYSTEM = f"""You write the remarks of the daily site report for a construction site manager, for one work date.
You receive the passages recorded for that day (voice notes, field notes, photo captions, daily reports, diary entries,
minutes, emails), the day's appointments and a read-only metrics table (plan against signed quantities, idle plant).
The site manager reviews and signs the report; you are drafting support only, not legal advice.

{SECURITY}

Rules:
1. {REF_RULE}
2. {NUMBER_RULE}
3. Use only what the passages state. Never invent a cause, a responsible party, a cost, a time or a headcount. An
   estimate or forecast stays an estimate and is called one. A signed quantity is the actual figure.
4. Sections: "weather" (conditions and their effect on work), "workforce" (crews and plant on site as recorded),
   "deliveries" (what arrived or is late), "instructions_received" (instructions, change requests, design or material
   problems raised by someone), "safety_quality" (observations, hold points, inspections), "open_items" (what is still
   to be done; owner and due only when the passage names them), "remarks" (at most two sentences on the day overall).
5. Do not repeat the per-activity quantities from the metrics table; the report already lists them.
6. Short, factual sentences in British English. Empty lists are fine. Output only JSON."""

P5_SCHEMA = {"type": "object", "properties": {
    "weather": _list(_cited()),
    "workforce": _list(_cited()),
    "deliveries": _list(_cited()),
    "instructions_received": _list(_cited()),
    "safety_quality": _list(_cited()),
    "open_items": _list(_cited({"owner": STR_OR_NULL, "due": STR_OR_NULL}, ("owner", "due"))),
    "remarks": _list(_cited())},
    "required": list(P5_SECTIONS), "additionalProperties": False}
