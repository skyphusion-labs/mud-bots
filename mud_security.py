"""Helpers to keep credentials out of logs and credential files."""

from __future__ import annotations

import json
import logging
from pathlib import Path

_REDACTED = "********"


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
