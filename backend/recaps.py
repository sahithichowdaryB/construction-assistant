"""Daily recaps: each site day told as short story cards, built from the project's action items.

An action item (sitemate.action_items, extracted from a record by the summariser) feeds a day's
recap in three ways, each on the project-local calendar day it happened:
  - raised    the record it came from became available  -> "Said & decided"
  - completed someone marked it done                     -> "Wins"
  - overdue   its due time passed before it was done      -> "Problems"
Items still open at the end of the day are carried into the next morning ("Start today").

A day's recap is published at 06:00 the next morning and respects `as_of`: nothing appears before
its record, completion or due time does. Every card cites the passage the action item came from.
Response shape: DayRecap in frontend/lib/types.ts.
"""
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from sqlalchemy import text

from deps import check_cutoff, check_member, connection

router = APIRouter(prefix="/projects/{project_id}", tags=["recaps"])

PUBLISH_AT = time(6, 0)
MAX_PER_CHAPTER = 4
REPORT_KINDS = {"daily_report"}
DOC_KINDS = {"email", "minutes", "diary", "register", "schedule", "project"}
WEEKDAY = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _ref(row):
    return {"source_id": row["source_id"], "locator": row["locator"], "page": row["page"],
            "passage_id": f"{row['source_id']}:{row['locator']}"}


def _title(description, limit=90):
    d = " ".join((description or "").split())
    return d if len(d) <= limit else d[: limit - 1].rstrip() + "…"


def _when(dt, tz):
    local = dt.astimezone(tz)
    return f"{local.day} {MONTH[local.month - 1]} {local:%H:%M}"


def _plural(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


def _owner(row):
    name = (row["owner_name"] or "").strip()
    return name[:1].upper() + name[1:] if name else None


def _quote(row):
    return {"text": row["quote"], "who": row["source_title"] or row["source_id"]} if row["quote"] else None


def _item_card(row, chapter, tone, kicker, at, tz, card_id):
    return {"id": card_id, "chapter": chapter, "title": _title(row["description"]), "kicker": kicker,
            "at": at.isoformat() if at else None, "tone": tone, "cover": None, "quote": _quote(row),
            "refs": [_ref(row)], "action": {"label": "Open action items", "href": "/actions"}}


def build_recaps(rows, tz, cutoff, include_today=True):
    """Pure function: action item rows -> DayRecap list (newest first). Rows carry UTC-aware datetimes.

    Finished days are published at 06:00 the next morning. With include_today, the current day comes
    first as a live recap ("live": true) covering everything up to `cutoff`.
    """
    local_day = lambda dt: dt.astimezone(tz).date()  # noqa: E731
    raised, done, overdue = defaultdict(list), defaultdict(list), defaultdict(list)
    for r in rows:
        raised[local_day(r["available_at"])].append(r)
        if r["completed_at"] and r["completed_at"] <= cutoff:
            done[local_day(r["completed_at"])].append(r)
        due = r["due_at"]
        if due and due <= cutoff and not (r["completed_at"] and r["completed_at"] <= due):
            overdue[local_day(due)].append(r)

    def open_at(moment):
        return sorted((r for r in rows if r["available_at"] < moment
                       and not (r["completed_at"] and r["completed_at"] < moment)),
                      key=lambda r: (r["due_at"] is None, r["due_at"] or moment))

    recaps = []
    if include_today:
        # Today is still happening: a live story of what has happened so far, rebuilt on every read.
        today = local_day(cutoff)
        recaps.append(_day_recap(today, cutoff, raised.get(today, []), done.get(today, []),
                                 overdue.get(today, []), open_at(cutoff), cutoff, tz, live=True))
    for day in sorted(set(raised) | set(done) | set(overdue), reverse=True):
        publish = datetime.combine(day + timedelta(days=1), PUBLISH_AT, tz)
        if publish > cutoff:
            continue
        end_of_day = datetime.combine(day + timedelta(days=1), time(0, 0), tz)
        new, closed, late = raised.get(day, []), done.get(day, []), overdue.get(day, [])
        recaps.append(_day_recap(day, publish, new, closed, late, open_at(end_of_day), end_of_day, tz))
    return recaps


def _day_recap(day: date, publish, new, closed, late, open_items, end_of_day, tz, live=False):
    if len(late) >= 2:
        mood, mood_label, short = "disrupted", f"{_plural(len(late), 'item')} overdue", f"{len(late)} overdue"
    elif late:
        mood, mood_label, short = "minor", "1 item overdue", "1 overdue"
    else:
        mood, mood_label = "on_plan", "On track"
        short = f"{len(closed)} done" if closed else f"{len(new)} new"

    if live:
        short = "so far"
        mood_label = "Today so far · " + ("on track" if mood == "on_plan" else mood_label)
    if late:
        headline = f"{_plural(len(late), 'action')} went overdue"
    elif closed:
        headline = f"{_plural(len(closed), 'action')} closed"
    elif live and not new:
        headline = "Nothing new yet today"
    else:
        headline = f"{_plural(len(new), 'new action')} from the records"

    day_refs, seen = [], set()
    for r in [*late, *closed, *new]:
        if r["source_id"] not in seen:
            seen.add(r["source_id"])
            day_refs.append(_ref(r))
    overview = {
        "id": f"{day}-overview", "chapter": "overview", "title": headline,
        "kicker": f"{WEEKDAY[day.weekday()]} {day.day} {MONTH[day.month - 1]}"
                  + (f" · so far, up to {end_of_day.astimezone(tz):%H:%M}" if live else ""),
        "tone": "bad" if len(late) >= 2 else "warn" if late else "good", "cover": "meeting",
        "stats": [
            {"value": str(len(new)), "label": "New actions", "tone": "info"},
            {"value": str(len(closed)), "label": "Closed", "tone": "good"},
            {"value": str(len(late)), "label": "Overdue", "tone": "bad" if late else "good"},
        ],
        "refs": day_refs[:4],
    }
    cards = [overview]
    cards += [_item_card(r, "wins", "good", _owner(r) or "No owner named", r["completed_at"], tz,
                         f"{day}-done-{r['id']}") for r in closed[:MAX_PER_CHAPTER]]
    cards += [_item_card(r, "problems", "bad",
                         f"Due {_when(r['due_at'], tz)}" + (f" · {_owner(r)}" if _owner(r) else ""),
                         r["due_at"], tz, f"{day}-late-{r['id']}") for r in late[:MAX_PER_CHAPTER]]
    cards += [_item_card(r, "decisions", "info",
                         (_owner(r) or "No owner named") + (f" · due {_when(r['due_at'], tz)}" if r["due_at"] else ""),
                         r["available_at"], tz, f"{day}-new-{r['id']}") for r in new[:MAX_PER_CHAPTER]]
    if open_items:
        carried = open_items[:5]
        cards.append({
            "id": f"{day}-today", "chapter": "today",
            "title": f"{_plural(len(open_items), 'action')} " + ("open right now" if live else "still open"),
            "kicker": "Still to do today" if live else "Carried into the next day", "tone": "neutral",
            "done": [(f"{_owner(r)}: " if _owner(r) else "") + _title(r["description"], 70)
                     + (" (overdue)" if r["due_at"] and r["due_at"] < end_of_day else "") for r in carried],
            "refs": [_ref(r) for r in carried],
            "action": {"label": "Open action items", "href": "/actions"},
        })

    kinds = [r["source_type"] for r in new]
    return {
        "work_date": day.isoformat(), "available_at": publish.isoformat(), "live": live, "mood": mood,
        "mood_label": mood_label, "short_label": short, "cover": "meeting",
        "inputs": {"voice": kinds.count("voice"), "photo": kinds.count("photo"),
                   "document": sum(k in DOC_KINDS for k in kinds), "report": sum(k in REPORT_KINDS for k in kinds)},
        "cards": cards,
    }


@router.get("/recaps", dependencies=[Depends(check_member)])
def recaps(project_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    cutoff = as_of or datetime.now(timezone.utc)
    tz = ZoneInfo(conn.scalar(text("SELECT timezone FROM sitemate.projects WHERE id=:p"), {"p": project_id})
                  or "Europe/Berlin")
    rows = conn.execute(text("""
        SELECT a.id, a.description, a.owner_name, a.due_at, a.completed_at, a.quote, a.source_id, a.locator,
               sp.page, CASE s.kind WHEN 'voice_note' THEN 'voice' ELSE s.kind END AS source_type,
               s.title AS source_title, s.available_at
        FROM sitemate.action_items a
        JOIN sitemate.sources s ON (s.project_id, s.id) = (a.project_id, a.source_id)
        JOIN sitemate.source_passages sp
          ON (sp.project_id, sp.source_id, sp.locator) = (a.project_id, a.source_id, a.locator)
        WHERE a.project_id=:p AND s.available_at <= :cutoff
        ORDER BY s.available_at, a.id
    """), {"p": project_id, "cutoff": cutoff}).mappings().all()
    rows = [{**dict(r), "id": str(r["id"])} for r in rows]
    return build_recaps(rows, tz, cutoff)
