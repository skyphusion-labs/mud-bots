"""Helpers to keep credentials out of logs and credential files."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_REDACTED = "********"
_SENSITIVE_QUERY_KEYS = {
    "password", "pass", "pwd", "token", "access_token", "refresh_token",
    "secret", "api_key", "apikey", "auth", "authorization",
}


def _safe_url_for_log(url: str) -> str:
    """Return a URL string safe for logs by redacting embedded secrets."""
    if not url:
        return url
    try:
        parts = urlsplit(url)
        netloc = parts.netloc
        if "@" in netloc:
            userinfo, hostinfo = netloc.rsplit("@", 1)
            username = userinfo.split(":", 1)[0] if userinfo else ""
            masked_user = f"{username}:{_REDACTED}" if username else _REDACTED
            netloc = f"{masked_user}@{hostinfo}"
        query_pairs = parse_qsl(parts.query, keep_blank_values=True)
        safe_query_pairs = [
            (k, _REDACTED if k.lower() in _SENSITIVE_QUERY_KEYS else v)
            for k, v in query_pairs
        ]
        safe_query = urlencode(safe_query_pairs, doseq=True)
        return urlunsplit((parts.scheme, netloc, parts.path, safe_query, parts.fragment))
    except Exception:
        return _REDACTED


def redact_command(command: str, password: str = "") -> str:
    """Return a command string that is safe to log."""
    if not command:
        return command
    # If a password context is present, never log outbound command text.
    # This avoids accidental disclosure of secrets through prompt/value drift.
    if password:
        return _REDACTED
    if "pass" in command.lower():
        return _REDACTED
    return command

    logger.info("Connecting to %s", _safe_url_for_log(url))
def log_connect(logger: logging.Logger, url: str) -> None:
    logger.info("Connecting to %s", url)


def log_outbound(logger: logging.Logger, command: str, *, password: str = "") -> None:
    logger.info(">>> %r", _REDACTED)


def log_outbound_tagged(
    logger: logging.Logger, command: str, tag: str, *, password: str = ""
) -> None:
    logger.info(">>> [%s] %r", tag, _REDACTED)


def log_login_reply(logger: logging.Logger, reply: str, *, password: str = "") -> None:
    shown = _REDACTED if password and reply == password else reply
    logger.info("login: answering prompt -> %r", shown)


def log_username_login(logger: logging.Logger, username: str) -> None:
    logger.info("Logging in with configured credentials")


def write_creds_json(path: Path | str, payload: dict) -> None:
    """Write a credentials JSON file without password-like fields (mode 0600)."""
    path = Path(path)
    sensitive_keys = {"password", "passwd", "pass"}
    out = {
        k: v
        for k, v in payload.items()
        if not (isinstance(k, str) and k.strip().lower() in sensitive_keys)
    }
    path.write_text(json.dumps(out, indent=2) + "\n")
    path.chmod(0o600)
