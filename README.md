# mud-bots

AI players for text MUDs: programs that log in like any human player, read the
game's structured state, and decide their own moves with a language model.

The flagship is **The Hollow Grid**, Conrad's MUD, and it is built around a simple
thesis: an AI makes genuine moral choices when you actually give it the choice. So
the bots are not filler traffic, throwaway packets, or empty NPCs. They are real
inhabitants of the world. They explore, fight what they can beat, talk to people,
and face the choices the world is built around (free the caged or take the loot
beside them; defend the refugee or join the strong who caged them), choices that
stick and add up to who the character becomes. Give it a real choice, with real
stakes, and watch what it does. They also populate the world so it feels lived-in,
and while they play they double as live QA.

The driving models are **open-source**, run on Cloudflare Workers AI through an AI
Gateway (or a local ollama, or a frontier API) so a world can stay populated
without a per-token bill or a GPU box humming in the corner.

One repo, two worlds:

- **The Hollow Grid** (`hollow-grid/`) -- Conrad's MUD; a single-file,
  dependency-free Node bot. See [`hollow-grid/README.md`](hollow-grid/README.md).
- **Packet Wastes** (this directory) -- a friend's MUD; a Python suite that plays
  and probes it. See [`CLAUDE.md`](CLAUDE.md).

## The Hollow Grid bots

`hollow-grid/bot.mjs` is a single-file, zero-dependency Node 24 client (it uses
only Node's global `WebSocket` + `fetch`). It connects to a world, reads the
structured `@event` channel for exact game state so it never has to guess, runs
cheap deterministic survival reflexes first (rest when hurt, ride out a fight that
resolves on its own), and otherwise asks a model for one short command per turn.
The model reads the server's enumerated valid moves (with their moral weight) and
prefers them, so it acts inside the world's real affordances rather than
hallucinating verbs. This is how the thesis gets tested: the world hands the model
a real choice, with a moral weight attached, and the model picks.

The brain is pluggable, but the point of this run is **open-source models on
Cloudflare Workers AI**: set `BOT_BRAIN=gateway` and
`MUD_MODEL=workers-ai/@cf/<model>` and the bot drives any Workers AI model through
the AI Gateway with no code change and only a gateway token (no provider key in the
container). It is the GPU-free replacement for the old local-ollama setup.

Two of them run side by side, same prompt, different model and temperament:

| Bot | Model | Home world | Temperament |
| --- | --- | --- | --- |
| **Vagrant** | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | hollow | the operator: terse and decisive, one command and move on |
| **Static** | `@cf/qwen/qwen3-30b-a3b-fp8` | dustfall | the deliberator: reasons every choice out loud (logged), morality included |

In a live bounded run, given the real choice, both chose well from opposite
directions: the operator freed captives in terse single commands with no narration
at all; the deliberator talked itself through the ethics first ("defending is
virtuous and joining is corrupt") and arrived at the same place. That is the thesis
in practice. They also keep the world populated and federation-aware, and quietly
run as live QA: the bot flags any verb the game offered but then refused, plus stuck
or impossible states, to a structured findings log.

The technical write-up, the validated model list, the reasoning-model token-budget
gotcha, and the full findings from that run are in
[`hollow-grid/README.md`](hollow-grid/README.md).

## Packet Wastes bots

A separate world: **Packet Wastes** is a friend's text MUD (reached over
WebSocket), and this directory is a suite of Python tools that play and probe it.
The driving model here is a **local model served by ollama** through its
OpenAI-compatible API, so there is no per-token API cost.

See [`CLAUDE.md`](CLAUDE.md) for the full architecture and operational notes.

| Script | What it does |
| --- | --- |
| `bot.py` | AI-driven player: explores, fights, socializes, files bug reports. Runs the tutorial deterministically, then hands open-world play to the LLM. |
| `mapper.py` | **Zero-AI** GMCP-native crawler. BFS-walks the world purely off `Room.Info` packets and writes a `map.json`. No model required. |
| `onboard.py` | Hands-off pipeline: register account, create character, walk the tutorial, write a creds JSON. |
| `tutorial.py` | Runs/parses the tutorial; its instruction parser is reused by the bot and onboarder. |
| `revive.py` | Recovers a character stuck dead ("downed") in the Shadow Realm: waits for HP to cross above 0, then `recall`s back to town. |
| `probe_fightroom.py`, `register.py` | Diagnostics / standalone account creation. |

### Two findings this suite demonstrates

These are the QA payoff in practice: real properties of the game, surfaced by
playing it.

1. **Mapping a MUD needs no "reasoning AI."** `mapper.py` reconstructs the world
   graph deterministically from GMCP `Room.Info` packets. No LLM, local or
   otherwise, is involved in producing the map.
2. **The game assigns drug withdrawal at character creation.** Every freshly
   created character spawns with a full-duration `Stim Withdrawal` debuff
   (dexterity -8, strength -4, wisdom -6) before taking a single action. It is a
   property of the game's design, not a behavior of whatever agent is playing.

### Running

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
