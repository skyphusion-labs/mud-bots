# CodeQL configuration

This repository uses **GitHub CodeQL default setup** (repo Settings > Code security >
CodeQL analysis). Do not add a custom `codeql-analysis` workflow; GitHub rejects
SARIF uploads from advanced setup while default setup is enabled.

The active bot surface is `hollow-grid/bot.mjs` (JavaScript/TypeScript analysis).
Default setup does not load custom model packs from this repo.
