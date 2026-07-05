# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Repo scope (`mud-bots`, formerly `packet-wastes-bots`):** this repo's **MUD bot** is
**The Hollow Grid** only: `hollow-grid/bot.mjs` (dependency-free Node 24+ WebSocket
client; world engine in the separate `the-hollow-grid` repo). See
`hollow-grid/README.md`.

The `discord/` subdirectory is a **Discord-to-ollama relay**, not a MUD player.

Root-level **Python** tools for **Packet Wastes** (a different MUD we do not
operate) were removed from this repo. Do not reintroduce them here.

**Inference (deliberate Cloudflare-first choice):** the Hollow Grid bot runs through
a **Cloudflare AI Gateway** (`BOT_BRAIN=gateway`), which drives EITHER
Anthropic/Claude models (e.g. `MUD_MODEL=anthropic/claude-sonnet-4-6`) OR
open-source Cloudflare Workers AI models (`MUD_MODEL=workers-ai/@cf/<model>`). The
bot holds ONLY a gateway token; provider keys stay in Cloudflare (BYOK / Unified
Billing) and there is no local GPU. It is the GPU-free replacement for the old
self-hosted ollama setup (`BOT_BRAIN=ollama` + `OLLAMA_BASE_URL`/`localhost` remain
as a local-dev fallback). Full brain matrix: `hollow-grid/README.md` and the root
`README.md`.

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

**Lint check:** `node --check hollow-grid/bot.mjs` (wired into GitHub Actions CI).

Full env config is in the header comment of `hollow-grid/bot.mjs` and in
`hollow-grid/README.md`.

## Architecture (`hollow-grid/bot.mjs`)

Single-file Node client: WebSocket to `/ws`, first line = character name, then read
structured `@event` lines for exact game state. Deterministic survival reflexes
(rest when hurt, disengage stuck combat) run before the model. The brain asks for
one short command per turn; `room.actions` from the server (with moral valence) are
preferred over guessed verbs.

**Grid travel (SSRF-safe):** never dial server-supplied URLs on `grid.travel`. Map
`data.to` (world name) to configured URLs via `MUD_WORLD_URLS`, `MUD_WORLD_ALIASES`,
or legacy `MUD_TRAVEL_ALLOW`.

**Bug findings:** optional JSONL via `BOT_BUG` (defaults beside `BOT_LOG`).

## discord/ -- Discord-to-ollama relay bot

`discord/bot.mjs` is a Discord bot (Node 24+, `discord.js`) that relays messages to a local
ollama model and sends the reply back. It works across multiple servers simultaneously.

**Trigger logic:**
- Responds to every message in channels listed in `DISCORD_CHANNEL_IDS`.
- Always responds to DMs.
- Always responds to @mentions (anywhere in any server).
- `!reset` clears the conversation history for that channel.

**Key env vars:**

| Var | Default | Notes |
|-----|---------|-------|
| `DISCORD_TOKEN` | (required) | Bot token from Developer Portal |
| `DISCORD_CHANNEL_IDS` | (empty = DMs + mentions only) | Comma-separated channel IDs |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | OpenAI-compat ollama base |
| `DISCORD_MODEL` | `qwen3.6:27b-ctx8k` | Model id on that ollama host |
| `DISCORD_HISTORY` | `10` | Rolling exchange-pair history depth per channel |
| `DISCORD_LOG` | (none) | Path to tee logs into |

**Developer Portal requirements:** Bot -> Privileged Gateway Intents -> **MESSAGE CONTENT: ON**.

**One-time setup on the host box:**

```bash
cd ~/dev/bots/discord
npm ci
# create ~/.config/systemd/user/discordbot.service (template in bot.mjs header)
systemctl --user daemon-reload
systemctl --user enable --now discordbot
```

Updates are manual: `git pull` on the host, `npm ci` in `discord/` if `package-lock.json` changed, then `systemctl --user restart discordbot`.

**Lint check:** `node --check discord/bot.mjs` (wired into the GitHub Actions CI).

## Conventions (SkyPhusion house style)

- Default handle/username for any service is `skyphusion`.
- No em-dashes (U+2014) or en-dashes (U+2013) in new source, comments, or docs; use commas, semicolons, or parentheses. (Some existing files predate this.)
