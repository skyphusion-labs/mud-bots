# CodeQL configuration

This repository uses **GitHub CodeQL default setup** (repo Settings > Code security >
CodeQL analysis). Do not add a custom `codeql-analysis` workflow; GitHub rejects
SARIF uploads from advanced setup while default setup is enabled.

Model packs under `extensions/` are auto-loaded by default setup:

- `mud-bots-python-models/` (`barrierModel` / `barrierGuardModel` for `mud_security.py`)
- `mud-bots-js-models/` (`barrierModel` for Hollow Grid travel URL lookup and log redaction)

CodeQL 2.25+ requires a fourth/fifth `provenance` column (`manual`) on barrier tuples.

Security-sensitive logging and storage also go through `mud_security.py` and
`redactForLog()` in `hollow-grid/bot.mjs` so behavior stays correct even when
models are not applied.
