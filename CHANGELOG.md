## [1.2.2] - 2026-07-21

### Changed
- Release sync bump (2026-07-21). No functional changes in this tag.

# Changelog

All notable changes to the Hollow Grid bot (`hollow-grid/bot.mjs`) and its container
image (`ghcr.io/skyphusion-labs/mud-bots-hg`).

## [1.2.1] - 2026-07-15

### Changed
- CI maintenance only: `actions/checkout` v4 -> v7 (#44). **No change to `bot.mjs`
  or the container image logic** -- the `:1.2.1` image is functionally identical to
  `:1.2.0`. Cut so the published image tag matches current `main`.

## [1.2.0] - 2026-07-11

### Added
- Consume `@event char.create` (issue #41; the-hollow-grid#63/v0.30.0): the creation
  race menu's offered options now arrive structured, so the bot no longer depends on
  any world's menu WORDING to know it is at the menu or what it may choose. Prose
  parsing (`menuRaces` + the known prompt phrasings) stays as the legacy fallback for
  worlds that have not shipped the event. Model-owned-choice semantics from #39 are
  unchanged (honor a named race, dedicated ask on generic replies, random only after
  3 misses and only from the offered list).

## [1.1.2] - 2026-07-11

### Fixed
- The race pick is the model's own choice, never a silent die roll (issue #39): the
  race-menu override that replaced generic replies with a random race is gone. A race
  named via the normal think path is honored; otherwise a dedicated ask retries until
  the model names one of the world's own menu options (parsed, so port-only races are
  choosable); random only after 3 misses, logged as random.

## [1.1.1] - 2026-07-11

### Added
- `BOT_TEMPERATURE` (issue #37): default `0.8`; `none` omits the field entirely
  (Claude 5 models reject `temperature` on the gateway compat endpoint; without this
  the bot silently degraded to the no-brain fallback).

## [1.1.0] - 2026-07-10

### Added
- Provider fallback chain for the always-on fleet population (issue #35). `BOT_PROVIDERS`
  (e.g. `ollama,workersai`) runs an ordered chain: a local ollama primary
  (`http://10.1.1.7:11434`, `qwen2.5:14b-instruct-q4_K_M`) with a Cloudflare Workers AI
  REST fallback (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`). ollama, Workers AI, and the
  AI Gateway all speak the same OpenAI-compatible shape, so prompt and response parsing
  are identical across providers.
- Per-provider circuit breaker (`BOT_CB_FAILS`, `BOT_CB_COOLDOWN_MS`) that auto-flips
  traffic in BOTH directions with no human action: when the local endpoint is preempted
  it falls through to the fallback, and once a gentle health probe (>=30s) re-tests the
  primary and passes, it returns to local on its own. Provider flips log at info level
  with a timestamp (grep `PROVIDER FLIP`). Both providers down degrades to a quiet
  canned idle move.

### Unchanged
- `BOT_BRAIN` single-brain mode (ollama/gateway/anthropic) is untouched when
  `BOT_PROVIDERS` is unset; the published npm bot and the biafra gateway stack keep
  working exactly as before.

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