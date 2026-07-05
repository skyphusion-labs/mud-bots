# Hollow Grid bot

The **only MUD bot in this repository**. An AI player for **The Hollow Grid**
(Conrad's MUD on Cloudflare Workers; world engine in the separate `the-hollow-grid`
repo). Packet Wastes tooling (a different MUD we do not operate) was removed
from this repository.

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
`message.content`), so the one-command parser still gets a clean command and the
deliberation is logged for you to watch -- no `<think>` leakage to sanitize.

Browse the catalog with the Cloudflare API
(`GET /accounts/{id}/ai/models/search?task=Text%20Generation`) or the dashboard;
prefer instruction-tuned models, since the bot needs a single short command per turn.

## Deployment

Both bots run as outbound-only Node containers on the operator's container host, driven by
open-source models on Cloudflare Workers AI through the `skyphusion-llm` AI Gateway
(Unified Billing): no GPU box, no ollama sidecar. This is the GPU-free replacement
for the retired self-hosted ollama stacks, which died with those decommissioned GPU boxes. Each bot holds its own AI-Gateway-Run-scoped token (per-function keys,
independently revocable); the `bot.mjs` gateway brain needed zero code change.
Sessions are bounded (start, watch, stop), keeping cost near-zero.

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
