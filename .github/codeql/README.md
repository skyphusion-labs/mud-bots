# CodeQL configuration

This repository uses **GitHub CodeQL default setup** (repo Settings > Code security >
CodeQL analysis). Do not add a custom `codeql-analysis` workflow; GitHub rejects
SARIF uploads from advanced setup while default setup is enabled.

Security fixes for clear-text logging and credential handling live in application
code (`mud_security.py`, `hollow-grid/bot.mjs`, etc.). Default setup does not load
custom model packs from this repo.
