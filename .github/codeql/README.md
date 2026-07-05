# CodeQL configuration

This repository uses **GitHub CodeQL default setup** (repo Settings > Code security >
CodeQL analysis). Do not add a custom `codeql-analysis` workflow; GitHub rejects
SARIF uploads from advanced setup while default setup is enabled.

Model packs under `extensions/` are auto-loaded by default setup:

- `mud-bots-python-models/` (`barrierModel` / `barrierGuardModel` for `mud_security.py`)
- `mud-bots-js-models/` (`barrierModel` for Hollow Grid travel URL lookup and log redaction)

Barrier tuples use three or four string columns only (`type`, `path`, `kind`, and
for guards also `acceptingValue`). CodeQL assigns the optional trailing extension
ID itself; do not add a `"manual"` provenance column.

Security-sensitive logging and storage also go through `mud_security.py` and
`redactForLog()` in `hollow-grid/bot.mjs` so behavior stays correct even when
models are not applied.
