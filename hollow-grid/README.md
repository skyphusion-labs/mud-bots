# Hollow Grid bot

The **only bot in this repository**. An AI player for **The Hollow Grid**
(Conrad's MUD on Cloudflare Workers; world engine in the separate `the-hollow-grid`
repo). Everything else that once lived alongside it (the Discord-to-ollama relay
and the Packet Wastes Python tooling) was removed from this repository.

It connects like any other client (WebSocket to `/ws`, first line = character name), reads the structured
`@event` channel for exact game state (the same lines `smoke.mjs` asserts on),
and asks a model for the next command. Deterministic survival reflexes (rest when
hurt, ride out combat) run before the model so it never burns a round, or its
life, on the obvious calls.

Single file, **no build step and no dependencies** (uses Node's global
`WebSocket` + `fetch`). Requires **Node 24+**.

## Brains (pluggable via `BOT_BRAIN`)

- `ollama` (default) -- a free local model.
- `anthropic` -- the Anthropic API (billed per call).
- `gateway` -- any provider through a Cloudflare AI Gateway (OpenAI-compatible);
  the bot holds only a gateway token, provider keys stay in the Gateway (BYOK).
  This includes **open-source models on Cloudflare Workers AI** via
  `MUD_MODEL=workers-ai/@cf/<model>`; under Unified Billing the gateway token is
  the only credential the bot needs (no BYOK, no provider key). See below.

## Run

```bash
# against a local dev world (the-hollow-grid: npm run dev) on ollama
node bot.mjs

# against live prod
MUD_URL=wss://hollow.skyphusion.org/ws node bot.mjs

# on Claude via the Anthropic API
BOT_BRAIN=anthropic ANTHROPIC_API_KEY=sk-... node bot.mjs

# via a Cloudflare AI Gateway (keys stay in Cloudflare)
BOT_BRAIN=gateway CF_AIG_TOKEN=... CF_ACCOUNT_ID=... CF_AIG_GATEWAY=skyphusion-llm \
  MUD_MODEL=anthropic/claude-sonnet-4-6 node bot.mjs

# open-source model on Cloudflare Workers AI (gateway token only, no BYOK)
BOT_BRAIN=gateway CF_AIG_TOKEN=... CF_ACCOUNT_ID=... CF_AIG_GATEWAY=skyphusion-llm \
  MUD_MODEL=workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast node bot.mjs
```

Full env config (`MUD_NAME`, `MUD_MODEL`, `BOT_THINK_MS`, the gateway/anthropic
knobs, `BOT_LOG`, `MUD_WORLD_URLS`, `MUD_WORLD_ALIASES`, ...) is documented in the
header comment of `bot.mjs`.

## Tests

`bot.test.mjs` is a dependency-free suite on Node's built-in `node:test` runner.
It exercises the pure core of the bot: `@event` ingestion and state rebuild, the
SSRF-safe world registry and `grid.travel` handling, command sanitizing, the
survival reflexes (rest, stuck-combat watchdog), loop breaking, the QA
bug-reporting side-channel, and all three brains against a stubbed `fetch` (no
network). `bot.mjs` only starts playing when executed directly, so the suite can
import it without side effects.

```bash
npm test               # plain run
npm run test:coverage  # the CI gate: fails under 75% line/branch/function coverage on bot.mjs
```

The release workflow runs both the lint (`node --check`) and the coverage gate on
every push and PR; the GHCR image build on a `v*` tag depends on them passing.

### Grid travel (SSRF-safe)

The bot never dials server-supplied URLs on `grid.travel`. It maps the world name
(`data.to`) to ws endpoints configured at startup via `MUD_WORLD_URLS` /
`MUD_WORLD_ALIASES`. Code scanning uses GitHub CodeQL default setup.

The anthropic/gateway brains bill continuously while the bot runs (it acts every
few seconds); pick the model and `BOT_THINK_MS` accordingly.

## Open-source models on Cloudflare Workers AI

The `gateway` brain drives any [Workers AI](https://developers.cloudflare.com/workers-ai/)
open-source model with **no code change** -- set `BOT_BRAIN=gateway` and
`MUD_MODEL=workers-ai/@cf/<model>`. The AI Gateway's OpenAI-compatible `/compat`
endpoint is what `bot.mjs` already speaks; the `workers-ai/` prefix just selects
the provider. Under Unified Billing the bot needs only a gateway token (sent as
`cf-aig-authorization`), so there are no provider keys in the container.

Two models validated against this bot with live play on The Hollow Grid:

| Model | Style | `BOT_MAX_TOKENS` |
|-------|-------|------------------|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | non-reasoning; terse, decisive single commands | `40` is enough |
| `@cf/qwen/qwen3-30b-a3b-fp8` | reasoning; "thinks out loud", surfaced in the logs | `2000`+ (see gotcha) |

**Reasoning-model gotcha.** The default `BOT_MAX_TOKENS=40` is fine for a
non-reasoning model (one short command), but a reasoning model spends that whole
budget *thinking* and emits no command -- the call comes back empty and the bot
falls back to `look`. Raise `BOT_MAX_TOKENS` (~2000) for reasoning models so the
chain-of-thought plus the final command both fit. Through Workers AI the reasoning
is returned in a **separate** `message.reasoning` field (not inline in
`message.content`). Since v1.0.3, when `content` is empty the bot extracts a
one-line command from `reasoning` (backticks, labeled picks, race names) before
falling back to `look`.

Browse the catalog with the Cloudflare API
(`GET /accounts/{id}/ai/models/search?task=Text%20Generation`) or the dashboard;
prefer instruction-tuned models, since the bot needs a single short command per turn.

## Laptop external QA (Docker Desktop)

Same image as fleet (`mud-bots-hg:v1.0.3`), against the **public** Rust Choir URL
(`wss://rustchoir.skyphusion.org/ws`). Gateway creds live in `~/mud-bots-gateway.env`
(source from `~/.zshrc`).

```bash
cd hollow-grid
docker compose -f compose.laptop.yaml up
# logs:      local/logs/local-scrape.log
# bug JSONL: local/logs/local-scrape-bugs.jsonl
```

Override cred path: `MUD_BOTS_GATEWAY_ENV=/path/to/env docker compose -f compose.laptop.yaml up`

## Container image (GHCR)

CI builds and pushes on every `v*` git tag (see root `CHANGELOG.md`):

```text
ghcr.io/skyphusion-labs/mud-bots-hg:v1.0.3
ghcr.io/skyphusion-labs/mud-bots-hg:latest
```

Minimal runtime: Node 24 slim, single file `bot.mjs`, no deps. Example one-shot:

```bash
docker run --rm \
  -e BOT_BRAIN=gateway \
  -e MUD_URL=wss://hollow.skyphusion.org/ws \
  -e MUD_NAME=MyBot \
  -e CF_ACCOUNT_ID=... \
  -e CF_AIG_GATEWAY=skyphusion-llm \
  -e CF_AIG_TOKEN=... \
  -e MUD_MODEL=workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast \
  ghcr.io/skyphusion-labs/mud-bots-hg:v1.0.3
```

Federation travel: set `MUD_WORLD_URLS` and `MUD_WORLD_ALIASES` (see `bot.mjs`
header). Fleet reference compose:
`fleet-chezmoi/system/stacks/biafra/mud-bots/compose.yaml`.

## Deployment

Outbound-only Node containers on the operator host, driven by open-source models on
Cloudflare Workers AI through the `skyphusion-llm` AI Gateway (Unified Billing): no
GPU box, no ollama sidecar. Each bot holds its own AI-Gateway-Run-scoped token
(per-function keys, independently revocable). Pin `v1.0.3` (or latest) in compose;
redeploy with `docker compose pull && docker compose up -d`.

## Provenance

This is the reconciliation of three diverged copies of `bot.mjs` (see the repo
history), all merged here:

- the **`room.actions` consumption** / affordance layer from the world repo's
  `main` (the bot reads the server's enumerated valid verbs, with moral valence,
  and prefers them over guessing),
- the **dead-dial fallback** (a `travel` handoff to a silent world no longer
  hangs the bot; after a few dud dials it falls back to the home grid),
- and the **free-over-loot prompt weighting** (freeing caged/captive people is
  the point of the world, not the loot near them; combat is tick-based).
