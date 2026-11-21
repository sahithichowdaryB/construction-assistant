"""The capture pipeline as a small state machine persisted in sitemate.captures (state jsonb + status), so a capture
paused for the person survives a restart and two clicks can't resume it twice.

  start()               upload -> transcribe -> describe photos -> classify         => needs_category   (202)
  confirm_categories()  person's categories -> search -> relationships -> validate  => needs_input (202) | saved (201)
  answer()              manager's answers  -> validate again                       => needs_input (202) | needs_review (202)
  review()              the speaker's edits, removals or discard                   => saved (201) | discarded (200)

Persisting (events, incident grouping, severity, alerts, facts) is one transaction: see persist.py."""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy import text

from ..llm import LLMClient
from . import steps
from .context import category_rules, load_business_rules, load_project_context, match_relationships, search_database
from .persist import persist_capture, source_kind
from .storage import DiskStorage, audio_storage, image_storage
from .taxonomy import Taxonomy, load_taxonomy
from .transcription import transcribe as whisper, transcription_enabled

IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # Claude's per-image limit
MAX_IMAGES = int(os.environ.get("AGENT_MAX_IMAGES", "5"))
MAX_QUESTION_ROUNDS = int(os.environ.get("AGENT_MAX_QUESTION_ROUNDS", "2"))
# How a member's role is weighted as evidence by the root-cause agent (sources.author_role).
AUTHOR_ROLE = {"contributor": "foreman", "manager": "site_supervisor", "approver": "site_supervisor"}

# Date or date-time like 2026-11-21 or 2026-11-21T09:15:00+01:00 (fromisoformat alone accepts things like "0").
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$")

BLANK_EVENT = {"occurred_at": None, "zone": None, "activity_code": None, "equipment_id_spoken": None,
               "equipment_description": None, "material": None, "quantity": None, "unit": None, "quantity_basis": None,
               "outstanding_quantity": None, "workers_affected": None, "expected_restart_at": None, "location": None,
               "description": None, "asset_key": None, "severity_flags": []}


class CaptureError(Exception):
    """An expected failure with an HTTP status and a message that is safe to show to the user."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


def apply_category_decisions(events: list[dict], resume: dict, taxonomy: Taxonomy) -> list[dict]:
    """Apply the person's decisions to the suggested events. Events they did not mention keep the AI suggestion."""
    decisions = {d["index"]: d for d in (resume.get("events") or []) if isinstance(d, dict) and "index" in d}
    kept = []
    for i, event in enumerate(events):
        d = decisions.get(i)
        if d and d.get("keep") is False:
            continue
        category, event_type = taxonomy.normalise((d or {}).get("category") or event["suggested_category"],
                                                  (d or {}).get("event_type") or event["suggested_event_type"])
        kept.append({**event, "category": category, "event_type": event_type,
                     "user_changed": category != event["suggested_category"] or event_type != event["suggested_event_type"]})
    for a in resume.get("added") or []:
        summary = str(a.get("summary") or "").strip()
        if not summary:
            continue
        category, event_type = taxonomy.normalise(a.get("category"), a.get("event_type"))
        kept.append({**BLANK_EVENT, "summary": summary, "evidence_quote": summary, "category": category,
                     "event_type": event_type, "suggested_category": None, "suggested_event_type": None,
                     "confidence": None, "rationale": "Added by the user", "alternatives": [], "user_changed": True})
    return kept


def _jsonable(value):
    return json.loads(json.dumps(value, default=str))


class CaptureService:
    def __init__(self, engine, llm: LLMClient, *, images: DiskStorage | None = None, audio: DiskStorage | None = None,
                 transcribe=whisper, transcription_on=transcription_enabled):
        self.engine, self.llm = engine, llm
        self.images, self.audio = images or image_storage(), audio or audio_storage()
        self.transcribe, self.transcription_on = transcribe, transcription_on

    # ----------------------------------------------------------------------------------------- helpers ------------
    def _taxonomy(self, project_id) -> Taxonomy:
        with self.engine.connect() as conn:
            return load_taxonomy(conn, project_id)

    def _set(self, project_id, capture_id, status, state=None, keep_state=True):
        with self.engine.begin() as conn:
            if state is not None:
                conn.execute(text("UPDATE sitemate.captures SET status=:s, state=CAST(:st AS jsonb) WHERE project_id=:p AND id=CAST(:c AS uuid)"),
                             {"s": status, "st": json.dumps(_jsonable(state)), "p": project_id, "c": capture_id})
            else:
                conn.execute(text("UPDATE sitemate.captures SET status=:s WHERE project_id=:p AND id=CAST(:c AS uuid)"),
                             {"s": status, "p": project_id, "c": capture_id})

    def _claim(self, project_id, thread_id, expected, what) -> dict:
        """Atomically take a paused capture (compare-and-swap on status) so it cannot be resumed twice."""
        with self.engine.begin() as conn:
            row = conn.execute(text("""
                UPDATE sitemate.captures SET status='processing'
                WHERE project_id=:p AND thread_id=:t AND status=:e RETURNING id::text AS id, state"""),
                               {"p": project_id, "t": thread_id, "e": expected}).mappings().one_or_none()
        if row is None or not row["state"]:
            raise CaptureError(404, f"No capture is waiting for {what}")
        return {"capture_id": row["id"], "state": row["state"]}

    @staticmethod
    def _events_summary(events):
        return [{"index": i, "summary": e["summary"], "suggested_category": e["suggested_category"],
                 "suggested_event_type": e["suggested_event_type"], "confidence": e["confidence"],
                 "rationale": e["rationale"], "alternatives": e.get("alternatives") or []} for i, e in enumerate(events)]

    # -------------------------------------------------------------------------------------------- start -----------
    def start(self, project_id: str, member: dict, *, text_: str | None, audio: tuple | None, images: list[tuple],
              recorded_at: str | None, zone_hint: str | None = None) -> tuple[int, dict]:
        """audio: (bytes, filename, mime) | None; images: [(bytes, filename, mime)]."""
        recorded_at = recorded_at or datetime.now().astimezone().isoformat()
        if not re.search(r"(Z|[+-]\d\d:\d\d)$", recorded_at):
            raise CaptureError(422, "recorded_at must be ISO 8601 with a time zone")
        try:
            datetime.fromisoformat(recorded_at)
        except ValueError:
            raise CaptureError(422, "recorded_at must be ISO 8601 with a time zone") from None
        if len(images) > MAX_IMAGES:
            raise CaptureError(422, f"Upload rejected: at most {MAX_IMAGES} photos")
        for data, _, mime in images:
            if mime not in IMAGE_TYPES:
                raise CaptureError(422, "Photos must be JPEG, PNG, WebP or GIF")
            if len(data) > MAX_IMAGE_BYTES:
                raise CaptureError(422, "Each photo must be 5 MB or smaller")
        if audio and not self.transcription_on():
            raise CaptureError(422, "Audio transcription is not configured; send a `transcript` text field instead")
        typed = (text_ or "").strip() or None
        spoken = self.transcribe(*audio) if audio else None
        transcript = "\n\n".join(x for x in (spoken, typed) if x) or None
        if not transcript and not images:
            raise CaptureError(422, "Send an `audio` file, `images` or a `transcript`")

        source_id, thread_id = f"CAP-{uuid.uuid4().hex[:8].upper()}", str(uuid.uuid4())
        stored = []
        if audio:
            ext = re.sub(r"[^.\w]", "", Path(audio[1]).suffix) or ".webm"
            stored.append({"kind": "audio", "mime": audio[2], **self.audio.put(project_id, f"{source_id}{ext}", audio[0])})
        for n, (data, _, mime) in enumerate(images, start=1):
            stored.append({"kind": "image", "n": n, "mime": mime, "locator": f"image:{n}",
                           **self.images.put(project_id, f"{source_id}-{n}{IMAGE_TYPES[mime]}", data)})
        kinds = [k for k, on in (("voice", audio), ("photo", images), ("text", typed)) if on]
        channel = "mixed" if len(kinds) > 1 else kinds[0]

        with self.engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO sitemate.sources (project_id, id, kind, path, available_at, author, author_role)
                VALUES (:p, :id, :k, :path, CAST(:at AS timestamptz), :a, :r)"""),
                         {"p": project_id, "id": source_id, "k": source_kind(audio=bool(audio), images=bool(images), text=bool(typed)),
                          "path": stored[0]["key"] if stored else "inline:transcript", "at": recorded_at,
                          "a": member["member_id"], "r": AUTHOR_ROLE.get(member["role"], "unknown")})
            capture_id = conn.scalar(text("""
                INSERT INTO sitemate.captures (project_id, source_id, thread_id, captured_by, channel, raw_text, transcript, recorded_at, zone_hint)
                VALUES (:p, :s, :t, :by, :ch, :raw, :tr, CAST(:at AS timestamptz), :z) RETURNING id::text"""),
                                     {"p": project_id, "s": source_id, "t": thread_id, "by": member["member_id"], "ch": channel,
                                      "raw": typed, "tr": spoken, "at": recorded_at, "z": zone_hint or None})
            for a in stored:
                conn.execute(text("""
                    INSERT INTO sitemate.capture_attachments (project_id, capture_id, source_id, kind, storage_key, mime, bytes, sha256, passage_locator)
                    VALUES (:p, CAST(:c AS uuid), :s, :k, :key, :mime, :b, :h, :loc)"""),
                             {"p": project_id, "c": capture_id, "s": source_id, "k": a["kind"], "key": a["key"], "mime": a["mime"],
                              "b": a["bytes"], "h": a["sha256"], "loc": a.get("locator")})

        auditor = steps.Auditor(project_id, capture_id, getattr(self.llm, "model", None))
        try:
            with self.engine.connect() as conn:
                context = load_project_context(conn, project_id)
            taxonomy = self._taxonomy(project_id)
            # [1] intake: describe photos so they become citable passages
            perception = []
            for (data, _, mime), n in zip(images, range(1, len(images) + 1)):
                desc = auditor.run("perception", lambda d=data, m=mime: steps.describe_photo(self.llm, {"mime": m, "data": d}, transcript),
                                   input={"n": n, "mime": mime, "bytes": len(data)})
                perception.append({"n": n, "passage": steps.photo_passage(desc)})
            input_text = "\n\n".join([x for x in (transcript, *[f"[Photo {p['n']}] {p['passage']}" for p in perception]) if x])
            # [2] classification: split into events and SUGGEST a category; the person decides next
            raw_events = auditor.run("classification", lambda: {"events": steps.extract_events(
                self.llm, input_text, recorded_at, context, taxonomy)}, input={"text": input_text})["events"]
            events = []
            for e in raw_events:
                category, event_type = taxonomy.normalise(e["suggested_category"], e["suggested_event_type"])
                events.append({**e, "suggested_category": category, "suggested_event_type": event_type, "category": category,
                               "event_type": event_type, "confidence": min(1.0, max(0.0, float(e.get("confidence") or 0)))})
            state = {"project_id": project_id, "capture_id": capture_id, "source_id": source_id, "thread_id": thread_id,
                     "captured_by": member["member_id"], "attachments": [{"n": a["n"], "key": a["key"], "mime": a["mime"]} for a in stored if a["kind"] == "image"],
                     "transcript": transcript, "perception": perception, "input_text": input_text, "recorded_at": recorded_at,
                     "context": context, "events": events, "answers": [], "round": 0}
            if not events:
                self._set(project_id, capture_id, "no_events")
                return 200, {"status": "no_events", "capture_id": capture_id, "transcript": transcript}
            self._set(project_id, capture_id, "needs_category", state)
            return 202, {"status": "needs_category", "thread_id": thread_id, "capture_id": capture_id, "transcript": transcript,
                         "photo_descriptions": perception, "events": self._events_summary(events)}
        except Exception:
            self._set(project_id, capture_id, "failed")
            raise
        finally:
            auditor.flush(self.engine)

    # ------------------------------------------------------------------------------------------ resume -----------
    def confirm_categories(self, project_id: str, thread_id: str, body: dict) -> tuple[int, dict]:
        """body: {events: [{index, category, event_type, keep}], added: [{summary, category, event_type}]}"""
        claimed = self._claim(project_id, thread_id, "needs_category", "category confirmation")
        state, capture_id = claimed["state"], claimed["capture_id"]
        auditor = steps.Auditor(project_id, capture_id, getattr(self.llm, "model", None))
        try:
            taxonomy = self._taxonomy(project_id)
            state["events"] = apply_category_decisions(state["events"], body or {}, taxonomy)
            if not state["events"]:
                self._set(project_id, capture_id, "no_events")
                return 200, {"status": "no_events", "capture_id": capture_id, "transcript": state["transcript"]}
            with self.engine.connect() as conn:
                state["matches"] = search_database(conn, project_id, state["events"], state["context"]["project"]["timezone"], state["recorded_at"])
                state["relationships"] = match_relationships(conn, project_id, state["matches"])
                rules = load_business_rules(conn, [e["event_type"] for e in state["events"]])
            state["rules"] = [*rules, *category_rules(state["events"], rules, taxonomy)]
            return self._validate_and_route(state, taxonomy, auditor)
        except Exception:
            self._set(project_id, capture_id, "needs_category")  # nothing was saved: let the person retry
            raise
        finally:
            auditor.flush(self.engine)

    def answer(self, project_id: str, thread_id: str, answers: list[dict]) -> tuple[int, dict]:
        """answers: [{id, answer}] for the questions that were asked."""
        claimed = self._claim(project_id, thread_id, "needs_input", "answers")
        state, capture_id = claimed["state"], claimed["capture_id"]
        auditor = steps.Auditor(project_id, capture_id, getattr(self.llm, "model", None))
        try:
            by_id = {a.get("id"): str(a.get("answer") or "").strip() for a in answers if isinstance(a, dict)}
            state["answers"] += [{"id": q["id"], "event_index": q["event_index"], "field_name": q["field_name"],
                                  "question": q["question"], "answer": by_id.get(q["id"]) or "unknown"}
                                 for q in state["validation"]["questions"]]
            state["round"] += 1
            return self._validate_and_route(state, self._taxonomy(project_id), auditor)
        except Exception:
            self._set(project_id, capture_id, "needs_input")
            raise
        finally:
            auditor.flush(self.engine)

    # ------------------------------------------------------------------------------------------ shared -----------
    def _validate_and_route(self, state: dict, taxonomy: Taxonomy, auditor) -> tuple[int, dict]:
        project_id, capture_id = state["project_id"], state["capture_id"]
        validation = auditor.run("validation", lambda: steps.validate_capture(
            self.llm, text_=state["input_text"], events=state["events"], matches=state["matches"],
            relationships=state["relationships"], rules=state["rules"], answers=state["answers"], recorded_at=state["recorded_at"]),
                                 input={"round": state["round"], "events": [e["summary"] for e in state["events"]]})
        validation = steps.enforce_required_fields(validation, state["events"], state["rules"], state["answers"])
        state["validation"] = validation.model_dump()

        if validation.questions and state["round"] < MAX_QUESTION_ROUNDS:
            self._set(project_id, capture_id, "needs_input", state)
            return 202, {"status": "needs_input", "thread_id": state["thread_id"], "capture_id": capture_id,
                         "transcript": state["transcript"], "events": state["events"],
                         "questions": state["validation"]["questions"], "round": state["round"] + 1}

        # Nothing more to ask: the person who spoke gets a last look at the extracted facts before anything is written.
        self._set(project_id, capture_id, "needs_review", state)
        return 202, {"status": "needs_review", "thread_id": state["thread_id"], "capture_id": capture_id,
                     "transcript": state["transcript"], "events": state["events"],
                     "facts": [{"index": i, "event_index": f["event_index"], "field_name": f["field_name"], "value": f["value"],
                                "basis": f["basis"]} for i, f in enumerate(state["validation"]["validated_facts"])],
                     "gaps": state["validation"]["missing"]}

    # ------------------------------------------------------------------------------------------- review -----------
    def review(self, project_id: str, member: dict, thread_id: str, body: dict) -> tuple[int, dict]:
        """body: {edits: [{index, value}], removed: [index], additions: [{event_index, field_name, value}], discard: bool}.
        Corrected values replace the agent's, removed facts are dropped, additions may only fill a gap the rules reported,
        and "discard" saves nothing. Only the person who recorded the note may review it."""
        claimed = self._claim(project_id, thread_id, "needs_review", "review")
        state, capture_id = claimed["state"], claimed["capture_id"]
        auditor = steps.Auditor(project_id, capture_id, getattr(self.llm, "model", None))
        try:
            if state["captured_by"] != member["member_id"]:
                raise CaptureError(403, "Only the person who recorded this note can review it")
            body = body or {}
            if body.get("discard") is True:
                self._discard(state)
                return 200, {"status": "discarded"}
            self._apply_review(state, body)
            return self._finish(state, self._taxonomy(project_id), auditor)
        except Exception:
            self._set(project_id, capture_id, "needs_review")  # nothing was saved: let the person try again
            raise
        finally:
            auditor.flush(self.engine)

    @staticmethod
    def _apply_review(state: dict, decision: dict) -> None:
        facts = state["validation"]["validated_facts"]
        valid = lambda i: isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(facts)  # noqa: E731
        removed = {i for i in (decision.get("removed") or []) if valid(i)}
        edits = {e["index"]: e["value"].strip() for e in (decision.get("edits") or [])
                 if isinstance(e, dict) and valid(e.get("index")) and isinstance(e.get("value"), str) and e["value"].strip()}
        additions = [a for a in (decision.get("additions") or []) if isinstance(a, dict)]
        # occurred_at becomes a timestamp in the database, so refuse anything that is not a date-time before saving.
        for field, value in ([(facts[i]["field_name"], v) for i, v in edits.items()]
                             + [(a.get("field_name"), a.get("value")) for a in additions]):
            if field == "occurred_at" and isinstance(value, str) and value.strip() and not ISO_DATE.match(value.strip()):
                raise CaptureError(422, f'"occurred at" must be a date and time, for example 2026-11-21T09:15:00+01:00 (got "{value}")')

        notes, reviewed = [], []
        for index, f in enumerate(facts):
            if index in removed:
                continue
            new = edits.get(index)
            if new is None or new == str(f["value"]):
                reviewed.append(f)
                continue
            notes.append({"id": str(index), "text": f'Corrected {f["field_name"].replace("_", " ")}: "{f["value"]}" -> "{new}"'})
            reviewed.append({**f, "value": new, "basis": "reported", "source": f"review:{index}", "evidence_refs": [],
                             "reasoning": "Corrected by the speaker before saving"})
        open_gaps = {(g["event_index"], g["field_name"]): g for g in state["validation"]["missing"]}
        for n, a in enumerate(additions):
            value = a.get("value").strip() if isinstance(a.get("value"), str) else ""
            key = (a.get("event_index"), a.get("field_name"))
            if not value or key not in open_gaps:
                continue
            del open_gaps[key]
            notes.append({"id": f"add{n}", "text": f'Added {a["field_name"].replace("_", " ")}: "{value}"'})
            reviewed.append({"event_index": a["event_index"], "field_name": a["field_name"], "value": value, "basis": "reported",
                             "source": f"review:add{n}", "evidence_refs": [], "reasoning": "Supplied by the speaker before saving"})
        state["validation"] = {**state["validation"], "validated_facts": reviewed, "missing": list(open_gaps.values())}
        state["review_notes"] = notes

    def _discard(self, state: dict) -> None:
        """Nothing is kept: the capture, its source row and the uploaded files are removed."""
        project_id, capture_id, source_id = state["project_id"], state["capture_id"], state["source_id"]
        with self.engine.begin() as conn:
            keys = [r[0] for r in conn.execute(text("""
                DELETE FROM sitemate.capture_attachments WHERE project_id=:p AND capture_id=CAST(:c AS uuid) RETURNING storage_key"""),
                                               {"p": project_id, "c": capture_id})]
            conn.execute(text("DELETE FROM sitemate.captures WHERE project_id=:p AND id=CAST(:c AS uuid)"), {"p": project_id, "c": capture_id})
            conn.execute(text("DELETE FROM sitemate.sources WHERE project_id=:p AND id=:s"), {"p": project_id, "s": source_id})
        for key in keys:
            for storage in (self.audio, self.images):
                try:
                    storage.delete(key)
                except (OSError, ValueError):
                    pass

    def _finish(self, state: dict, taxonomy: Taxonomy, auditor) -> tuple[int, dict]:
        ctx = {
            "adjudicate": lambda event, cands: auditor.run(
                "correlation", lambda: steps.adjudicate(self.llm, event, cands), input={"event": event["summary"]}),
            "adjust_severity": lambda incident, rule, stats: auditor.run(
                "severity", lambda: steps.adjust_severity(self.llm, incident, rule, stats),
                incident_id=incident["id"], input={"incident": incident["summary"], "rule": rule["level"]}).model_dump(),
        }
        result = persist_capture(self.engine, state, taxonomy, ctx)
        return 201, {"status": "saved", "thread_id": state["thread_id"], "events": state["events"], **result}
