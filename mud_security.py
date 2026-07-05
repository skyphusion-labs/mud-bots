"""Helpers to keep credentials out of logs and credential files."""

from __future__ import annotations

import json
import logging
from pathlib import Path

_REDACTED = "********"
_SENSITIVE_KEYS = frozenset({"password", "passwd", "pass"})


def _command_is_sensitive(command: str, password: str) -> bool:
    if not command:
        return False
    if password and command == password:
        return True
    return "pass" in command.lower()


def _command_is_safe_to_log(command: str, password: str = "") -> bool:
    return not _command_is_sensitive(command, password)


def redact_command(command: str, password: str = "") -> str:
    return _REDACTED if _command_is_sensitive(command, password) else command


def log_connect(logger: logging.Logger, url: str = "") -> None:
    del url
    logger.info("Connecting to server")


def log_outbound(logger: logging.Logger, command: str, *, password: str = "") -> None:
    logger.info(">>> %r", redact_command(command, password))


def log_outbound_tagged(
    logger: logging.Logger, command: str, tag: str, *, password: str = ""
) -> None:
    logger.info(">>> [%s] %r", tag, redact_command(command, password))


def log_login_reply(logger: logging.Logger, reply: str, *, password: str = "") -> None:
    logger.info("login: answering prompt -> %r", redact_command(reply, password))


def log_username_login(logger: logging.Logger, username: str = "") -> None:
    del username
    logger.info("Logging in with configured credentials")


def print_outbound(command: str, *, password: str = "", file=None) -> None:
    """Like log_outbound, but for scripts that print progress to stdout."""
    print(f">>> {redact_command(command, password)}", flush=True, file=file)


def write_creds_json(path: Path | str, payload: dict) -> None:
    """Write a credentials JSON file without password-like fields (mode 0600)."""
    path = Path(path)
    out: dict = {}
    for key, value in payload.items():
        if isinstance(key, str) and key.strip().lower() in _SENSITIVE_KEYS:
            continue
        out[key] = value
    path.write_text(json.dumps(out, indent=2) + "\n")
    path.chmod(0o600)
