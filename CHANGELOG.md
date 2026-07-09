# Changelog

All notable changes to the Hollow Grid bot (`hollow-grid/bot.mjs`) and its container
image (`ghcr.io/skyphusion-labs/mud-bots-hg`).

## [1.0.3] - 2026-07-09

### Fixed
- Salvage MUD commands from reasoning-only gateway replies when `message.content` is
  empty but `message.reasoning` is populated (GLM-4.7-Flash and similar Workers AI
  models).
- Reject markdown junk extracted from deliberation text; char-create fallback when
  the model returns nothing at the race menu.

### Added
- `compose.laptop.yaml` for Docker Desktop external QA against
  `wss://rustchoir.skyphusion.org/ws` (logs under `hollow-grid/local/logs/`).

## [1.0.2] - 2026-07-08

### Fixed
- Ingest `char.vitals`, `room.actions`, `char.affects`, and `char.equipment` from
  `@event` lines so survival reflexes and affordance-aware play work in production.

## [1.0.1] - 2026-07-07

Initial tagged GHCR releases (CI `v*` tag workflow).

## [1.0.0] - 2026-07-07

First semver-tagged container image for fleet deployment.
