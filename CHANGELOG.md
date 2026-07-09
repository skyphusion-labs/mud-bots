# Changelog

All notable changes to the Hollow Grid bot (`hollow-grid/bot.mjs`) and its container
image (`ghcr.io/skyphusion-labs/mud-bots-hg`).

## [1.0.8] - 2026-07-09

### Fixed
- Char-create fallback matches Go/Python race-menu wording (`Answer with a number or a
  name`) as well as TS (`Type a number or a name`), and overrides `look`/`worlds` when
  the model (or escapeMove) replies before vitals exist -- unblocks Verdigris Spool soak
  bots stuck at the race prompt.

## [1.0.6] - 2026-07-09

### Fixed
- Parse Workers inventory prose (`You are carrying:` multi-line and `You are carrying
  nothing.`) so hollow/dustfall bots do not loop on `inventory` when `sell` is offered.
- Fail open to empty inventory after three unparseable refresh attempts (circuit breaker).

## [1.0.5] - 2026-07-09

### Added
- `BOT_TRAVEL_INTERVAL_MS` + `BOT_TRAVEL_TARGETS` for scheduled federation travel
  (hub RPC + cross-world handoff load testing without waiting for the model).

## [1.0.4] - 2026-07-09

### Fixed
- `sanitizeCommand()` rejects gateway garbage (truncated replies, `.printStackTrace`,
  prose) via `looksLikeCommand()` and falls back to `look`.
- Parse `You carry: ...` inventory prose into context; auto-run `inventory` when
  `sell`/`trade` is offered and carrying is unknown.
- Do not arm `action-rejected` on bare `sell`/`buy`/etc or on missing-arg replies
  like `Sell what?`.

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
