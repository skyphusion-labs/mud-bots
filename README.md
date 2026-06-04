# packet-wastes-bots

A small suite of Python tools that play and probe the **Packet Wastes** MUD (a
text MUD reached over WebSocket). The driving model is a **local model served by
ollama** through its OpenAI-compatible API, so there is no per-token API cost.

See [`CLAUDE.md`](CLAUDE.md) for the full architecture and operational notes.

## Tools

| Script | What it does |
| --- | --- |
| `bot.py` | AI-driven player: explores, fights, socializes, files bug reports. Runs the tutorial deterministically, then hands open-world play to the LLM. |
| `mapper.py` | **Zero-AI** GMCP-native crawler. BFS-walks the world purely off `Room.Info` packets and writes a `map.json`. No model required. |
| `onboard.py` | Hands-off pipeline: register account, create character, walk the tutorial, write a creds JSON. |
| `tutorial.py` | Runs/parses the tutorial; its instruction parser is reused by the bot and onboarder. |
| `revive.py` | Recovers a character stuck dead ("downed") in the Shadow Realm: waits for HP to cross above 0, then `recall`s back to town. |
| `probe_fightroom.py`, `register.py` | Diagnostics / standalone account creation. |

## Two findings this repo demonstrates

1. **Mapping a MUD needs no "reasoning AI."** `mapper.py` reconstructs the world
   graph deterministically from GMCP `Room.Info` packets. No LLM, local or
   otherwise, is involved in producing the map.
2. **The game assigns drug withdrawal at character creation.** Every freshly
   created character spawns with a full-duration `Stim Withdrawal` debuff
   (dexterity -8, strength -4, wisdom -6) before taking a single action. It is a
   property of the game's design, not a behavior of whatever agent is playing.

## Running

Requires a local ollama server and a Python venv with `openai` + `websockets`.
Configuration is environment-driven (`OLLAMA_BASE_URL`, `MUD_MODEL`,
`MUD_IDENTITY_FILE`, etc.); see `CLAUDE.md`. Credentials live in identity JSON
files that are **git-ignored** and never committed.

```bash
# deterministic map crawl (no model needed)
python3 mapper.py --creds creds.json --output map.json

# AI player (local ollama)
MUD_MODEL='<your-ollama-tag>' python3 bot.py
```
