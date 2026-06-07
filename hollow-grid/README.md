# Hollow Grid bot

An AI player for **The Hollow Grid** (Conrad's MUD on Cloudflare Workers, world
engine lives in the separate `the-hollow-grid` repo). It connects like any other
client (WebSocket to `/ws`, first line = character name), reads the structured
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
```

Full env config (`MUD_NAME`, `MUD_MODEL`, `BOT_THINK_MS`, the gateway/anthropic
knobs, `BOT_LOG`, ...) is documented in the header comment of `bot.mjs`.

The anthropic/gateway brains bill continuously while the bot runs (it acts every
few seconds); pick the model and `BOT_THINK_MS` accordingly.

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
