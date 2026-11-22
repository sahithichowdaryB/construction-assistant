"""Send approved email drafts through the SMTP account configured in the environment.

Works with any SMTP provider. Set SMTP_PROVIDER=gmail or outlook for the host and port, or set
SMTP_HOST and SMTP_PORT yourself. Gmail needs an app password (Google account with 2-step
verification); Microsoft 365 tenants must still allow SMTP AUTH for the mailbox.
"""

import logging
import os
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

log = logging.getLogger("sitemate.mail")

PRESETS = {"gmail": ("smtp.gmail.com", 587), "outlook": ("smtp.office365.com", 587)}
ADDRESS = re.compile(r"^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$")
MAX_RECIPIENTS = 10
TIMEOUT = 20


class MailError(Exception):
    """A failure that is safe to show the user. 422 for bad input, 502 when the mail server is the problem."""

    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def _settings():
    preset = PRESETS.get(os.environ.get("SMTP_PROVIDER", "").strip().lower())
    host = os.environ.get("SMTP_HOST", "").strip() or (preset[0] if preset else "")
    port = int(os.environ.get("SMTP_PORT", "").strip() or (preset[1] if preset else 587))
    user = os.environ.get("SMTP_USER", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "")
    if not (host and user and password):
        return None
    return {"host": host, "port": port, "user": user, "password": password,
            "from": os.environ.get("SMTP_FROM", "").strip() or user,
            "reply_to": os.environ.get("SMTP_REPLY_TO", "").strip()}


def status():
    config = _settings()
    return {"configured": config is not None, "from": config["from"] if config else None}


def clean_addresses(values):
    out = []
    for value in values:
        address = parseaddr(value.strip())[1]
        if not ADDRESS.match(address):
            raise MailError(f"'{value}' is not a valid email address")
        if address.lower() not in (a.lower() for a in out):
            out.append(address)
    if len(out) > MAX_RECIPIENTS:
        raise MailError(f"At most {MAX_RECIPIENTS} recipients per email")
    return out


def split_draft(body):
    """The stored wording starts with 'To:' and 'Subject:' lines, then a blank line and the text."""
    head, _, rest = body.partition("\n\n")
    subject = re.search(r"^Subject: (.+)$", head, re.M)
    return (subject[1].strip() if subject else "SiteMate notice"), rest.strip()


def send(to, cc, subject, text, sender_name):
    config = _settings()
    if config is None:
        raise MailError("Email sending is not set up on this server. Set SMTP_PROVIDER, SMTP_USER and SMTP_PASSWORD.", 503)
    message = EmailMessage()
    message["From"] = formataddr((sender_name, config["from"])) if sender_name else config["from"]
    message["To"] = ", ".join(to)
    if cc:
        message["Cc"] = ", ".join(cc)
    if config["reply_to"]:
        message["Reply-To"] = config["reply_to"]
    message["Subject"] = subject
    message.set_content(text)
    try:
        if config["port"] == 465:
            client = smtplib.SMTP_SSL(config["host"], config["port"], timeout=TIMEOUT, context=ssl.create_default_context())
        else:
            client = smtplib.SMTP(config["host"], config["port"], timeout=TIMEOUT)
        with client:
            if config["port"] != 465:
                client.starttls(context=ssl.create_default_context())
            client.login(config["user"], config["password"])
            client.send_message(message, to_addrs=[*to, *cc])
    except smtplib.SMTPAuthenticationError as exc:
        log.warning("SMTP login rejected: %s", exc.smtp_code)
        raise MailError("The mail server rejected the sign-in. For Gmail use an app password; "
                        "for Microsoft 365 SMTP AUTH must be enabled for the mailbox.", 502) from exc
    except smtplib.SMTPRecipientsRefused as exc:
        raise MailError("The mail server refused the recipient address.", 422) from exc
    except (smtplib.SMTPException, OSError) as exc:
        log.warning("SMTP send failed: %s", type(exc).__name__)
        raise MailError("Could not reach the mail server. Try again, or download the .eml instead.", 502) from exc
