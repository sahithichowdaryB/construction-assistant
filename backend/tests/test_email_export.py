"""The .eml export keeps the subject and recipient of emails and formal letters (no database)."""

import email
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from correspondence import email_file  # noqa: E402

AT = datetime(2026, 11, 10, 17, 0, tzinfo=timezone.utc)


def test_email_style_body():
    raw = email_file("To: GroundWorks Ltd\nSubject: Backup excavator\n\nDear Sir,\n\nPlease send the plan.", "Sam", AT)
    msg = email.message_from_bytes(raw)
    assert msg["Subject"] == "Backup excavator" and msg["To"] == "GroundWorks Ltd" and msg["X-Unsent"] == "1"
    assert msg.get_payload().startswith("Dear Sir")


def test_formal_letter_keeps_subject_and_whole_letter():
    body = ("DELAY NOTICE\n10 November 2026 | Riverside\nFrom: Sam Reed\nTo: Client PM\nContract reference: C-1\n\n"
            "Subject: Delay to Excavation Zone B (EXC-B)\n\nDear Client,\n\n1. The signed report records 65 m3.")
    msg = email.message_from_bytes(email_file(body, "Sam", AT))
    assert msg["Subject"] == "Delay to Excavation Zone B (EXC-B)" and msg["To"] == "Client PM"
    assert "From: Sam Reed" in msg.get_payload() and "65 m3" in msg.get_payload()
