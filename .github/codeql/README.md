# CodeQL configuration

This repository uses **GitHub CodeQL default setup** (repo Settings > Code security >
CodeQL analysis). Do not add a custom `codeql-analysis` workflow; GitHub rejects
SARIF uploads from advanced setup while default setup is enabled.

The `extensions/mud-bots-models/` directory is a CodeQL model pack (barriers for
`mud_security` redaction, credential writes, and Hollow Grid travel URL lookup).
Default setup auto-loads model packs placed under `.github/codeql/extensions/`.

Security-sensitive logging and storage also go through `mud_security.py` and
`redactForLog()` in `hollow-grid/bot.mjs` so behavior stays correct even when
models are not applied.
