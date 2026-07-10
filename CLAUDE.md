# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Repo scope (`mud-bots`, formerly `packet-wastes-bots`):** this repo holds
**exactly one bot**: the Hollow Grid MUD bot, `hollow-grid/bot.mjs` (dependency-free
Node 24+ WebSocket client; world engine in the separate `the-hollow-grid` repo). See
`hollow-grid/README.md`.

Everything else was removed and must not be reintroduced here:

- The `discord/` Discord-to-ollama relay bot (removed; it was never a MUD player).
- Root-level **Python** tools for **Packet Wastes** (a different MUD we do not
  operate).

**Inference (deliberate Cloudflare-first choice):** the Hollow Grid bot runs through
a **Cloudflare AI Gateway** (`BOT_BRAIN=gateway`), which drives EITHER
Anthropic/Claude models (e.g. `MUD_MODEL=anthropic/claude-sonnet-4-6`) OR
open-source Cloudflare Workers AI models (`MUD_MODEL=workers-ai/@cf/<model>`). The
bot holds ONLY a gateway token; provider keys stay in Cloudflare (BYOK / Unified
Billing) and there is no local GPU. It is the GPU-free replacement for the old
self-hosted ollama setup (`BOT_BRAIN=ollama` + `OLLAMA_BASE_URL`/`localhost` remain
as a local-dev fallback). Full brain matrix: `hollow-grid/README.md` and the root
`README.md`.

**Always-on fleet population (issue #35):** the standing bots on a fleet box run a
**provider fallback chain** via `BOT_PROVIDERS=ollama,workersai`: a fleet-local ollama
primary (`http://10.1.1.7:11434`, `qwen2.5:14b-instruct-q4_K_M`) with a Cloudflare Workers
AI REST fallback, auto-flipped in both directions by a health-checked circuit breaker (no
human action). This is orthogonal to the single-`BOT_BRAIN` gateway path above, which is
still the default when `BOT_PROVIDERS` is unset.

## Running the Hollow Grid bot

```bash
cd hollow-grid

# local dev world (the-hollow-grid: npm run dev) on ollama
node bot.mjs

# live prod
MUD_URL=wss://hollow.skyphusion.org/ws node bot.mjs

# Workers AI via gateway (production path)
BOT_BRAIN=gateway CF_AIG_TOKEN=... CF_ACCOUNT_ID=... CF_AIG_GATEWAY=skyphusion-llm \
 MUD_MODEL=workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast node bot.mjs
```

Full env config is in the header comment of `hollow-grid/bot.mjs` and in
`hollow-grid/README.md`.

## Lint, tests, and CI

- **Lint:** `node --check hollow-grid/bot.mjs` (and `bot.test.mjs`).
- **Tests:** `cd hollow-grid && npm test`. The suite (`hollow-grid/bot.test.mjs`)
  uses Node's built-in `node:test` runner, zero dependencies. It imports `bot.mjs`
  as a module (the bot only starts playing when executed directly) and stubs
  `globalThis.fetch` for the brain tests; no network, no game server needed.
- **Coverage gate:** `npm run test:coverage` fails if line/branch/function
  coverage on `bot.mjs` drops below 75%. Keep new logic in testable exported
  functions so the gate stays green.
- **CI (`.github/workflows/release.yml`):** lint + test jobs run on every push
  and PR; the GHCR image build/push job runs only on a `v*` tag and depends on
  both. This is the only workflow; do not add others (CodeQL runs via GitHub
  default setup, see `.github/codeql/README.md`).

## Architecture (`hollow-grid/bot.mjs`)

Single-file Node client: WebSocket to `/ws`, first line = character name, then read
structured `@event` lines for exact game state. Deterministic survival reflexes
(rest when hurt, disengage stuck combat) run before the model. The brain asks for
one short command per turn; `room.actions` from the server (with moral valence)
are preferred over guessed verbs.

Testability: the pure core (ingestion, world registry, reflexes, sanitizing,
brains, bug reporting) is exported; connection/main-loop side effects only start
when the file is run directly (`node bot.mjs`).

**Grid travel (SSRF-safe):** never dial server-supplied URLs on `grid.travel`. Map
`data.to` (world name) to configured URLs via `MUD_WORLD_URLS`, `MUD_WORLD_ALIASES`,
or legacy `MUD_TRAVEL_ALLOW`. Optional load-test timer: `BOT_TRAVEL_INTERVAL_MS` +
`BOT_TRAVEL_TARGETS` (see `bot.mjs` header; v1.0.4+).

**Bug findings:** optional JSONL via `BOT_BUG` (defaults beside `BOT_LOG`).

## Deploy artifacts

- **GHCR image:** `ghcr.io/skyphusion-labs/mud-bots-hg` (tagged on `v*`; current
  release `v1.0.3`, `v1.0.4` adds scheduled travel). See root `CHANGELOG.md`.
- **Fleet compose + matrix:** `fleet-chezmoi/system/stacks/biafra/mud-bots/`
  (`README.md` lists every bot name → world → token → model).
- **Secrets escrow:** `crew-secrets/swarm-secrets/mud-bots-env/`.
- **Laptop QA:** `hollow-grid/compose.laptop.yaml` (public `rustchoir.skyphusion.org`).

## Conventions (SkyPhusion house style)

- Default handle/username for any service is `skyphusion`.
- No em-dashes (U+2014) or en-dashes (U+2013) in new source, comments, or docs; use commas, semicolons, or parentheses. (Some existing files predate this.)
