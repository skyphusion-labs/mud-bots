# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Repo scope (`mud-bots`, formerly `packet-wastes-bots`):** this repo collects the bots for more than one MUD. Everything at the root is the **Packet Wastes** suite (Python; documented below). The `hollow-grid/` subdirectory holds the bot for **The Hollow Grid** (`bot.mjs`, a dependency-free Node 24+ WebSocket client; its world engine lives in the separate `the-hollow-grid` repo). The `discord/` subdirectory holds the Discord-to-ollama relay bot. See `hollow-grid/README.md`. The rest of this file describes the Packet Wastes tools.

**Inference (deliberate Cloudflare-first choice):** the Hollow Grid bots (`hollow-grid/`) run on **Cloudflare Workers AI** via the AI Gateway (`BOT_BRAIN=gateway`), so there is no self-hosted GPU to babysit -- CF GPU time on Unified Billing, effectively free. That is why the old self-hosted ollama GPU boxes were retired. The Packet Wastes (root) tools and the Discord relay still drive a local **ollama** model.

A suite of Python tools that play and probe the **Packet Wastes** MUD (a text MUD reached over WebSocket at `wss://74-208-68-248.sslip.io/ws`). The flagship is `bot.py`, an AI-driven player that explores, fights, socializes, and files bug reports; the rest create accounts, walk the tutorial, and map/diagnose the game. The LLM is a **local model served by ollama** through its OpenAI-compatible API, so there is no per-token API cost, but everything connects to the **live** game server.

## Running it

The Packet Wastes Python bots run LOCALLY (or on any host that has ollama). The old
fleet auto-deploy (to the now-decommissioned GPU boxes) is RETIRED, so there
is no `deploy.sh` -- deployment is local/manual. Two things bite every time:

- **Use the project venv, not system python.** `.venv/bin/python ...`; system
  `python3` lacks the `openai` module and crashes immediately.
- **Override the model.** Set `MUD_MODEL` to whatever your ollama host has pulled; the
  code defaults differ.

```bash
# run the bot (logs in to an existing account via bot_identity.json)
MUD_MODEL='<your-ollama-model>' nohup .venv/bin/python bot.py > bot_run.log 2>&1 &

# create a fresh account + character (hands-off), then point the bot at it
MUD_MODEL='<your-ollama-model>' .venv/bin/python onboard.py --username <u> --password <p> --use-llm

# quick syntax check (no test suite exists)
.venv/bin/python -m py_compile bot.py tutorial.py
```

There is no automated test suite; verify by running against the live server and reading the `*.log` files and `bug_reports.jsonl`.

Gotcha: `pkill -f bot.py` over SSH matches your own SSH command line (it contains "bot.py") and kills the shell with exit 255. Use the regex trick: `pkill -f '[b]ot.py'`.

## Configuration

All runtime config is environment-driven via `BotConfig.from_env()` (`bot.py`): `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, `MUD_MODEL`, `MUD_SERVER_URL`, `MUD_USERNAME`/`MUD_PASSWORD`/`MUD_CHARACTER`, `MUD_IDENTITY_FILE`, `MUD_BUG_FILE`. `bot.py` reads an identity JSON (default `bot_identity.json`) that must contain `username`, `password`, `character_name`, `race`, and `class` (the last two are flavor for the AI brain; the real character's are server-side). Run a second bot by pointing `MUD_IDENTITY_FILE` and `MUD_BUG_FILE` at separate files.

## Architecture

**`mapper.py` is the shared foundation.** Packet Wastes is GMCP-native: it emits `!!GMCP(Room.Info {...})`, `!!GMCP(Char.Vitals {...})`, `!!GMCP(Comm.Channel {...})` etc. inline in the stream. `mapper.py` exports `parse_gmcp()` and `strip_ansi()`, which every other tool imports to read game state exactly (no LLM guessing for structured data).

**`bot.py` is a pipeline of small classes orchestrated by `MUDBot`.** `MUDBot.run()` is the asyncio WebSocket loop (connect, receive, parse, decide, act, reconnect). Inside it: `GameParser` turns raw server text + GMCP into `GameState`/`RoomState`/`CharacterState` plus events; `AIBrain` asks the local model for the next action from that state; `TutorialPilot` handles the tutorial deterministically (the bot defers to it while in the Tutorial area and hands control to the LLM once in the open world); `IdentityGenerator` loads/creates the identity; `BugReporter` appends findings to `bug_reports.jsonl`. Player speech arrives as plain-text `Name says, "..."` lines (primary path) with GMCP `Comm.Channel` as a secondary signal.

**Account/tutorial tooling (standalone scripts):**
- `onboard.py` is the full hands-off pipeline: register account, create character, walk the tutorial, write a creds JSON. `--use-llm` hands unparseable tutorial lines to the model. This supersedes `register.py` (a standalone fresh-account creator).
- `tutorial.py` runs/parses the tutorial; its `extract_command` (instruction parsing) is reused by the bot and onboarder.
- `probe_fightroom.py` is a diagnostic that drives a character to the tutorial fight room and probes the broken exit.

## Critical domain knowledge

- **The Packet Wastes tutorial is currently un-completable (a server-side bug):** the final "head west to complete your training" is a no-op, so fresh characters get trapped in the Tutorial area. `bot.py` detects this (`EXIT_WRONGDIR`), logs the bug, and brute-forces every exit to escape, but nothing works; this gates open-world play and mapping for new characters. Do not treat it as a bot bug.
- **`bot.py` can only log in to a pre-existing account**; at the `username (or "new")` prompt it sends the username, so a fresh identity just loops on "Invalid login." Create accounts with `onboard.py`, not the bot.
- **The tutorial is instanced per character** (two characters in it cannot see each other), so it cannot be escaped by another player's help.
- The server's v1.5 refactor wiped pre-existing accounts.
- The bot uses local ollama (no API cost), but it connects to and acts on the live server; be cost/impact-conscious before long unattended live runs.

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
