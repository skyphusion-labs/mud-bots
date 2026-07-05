# mud-bots

AI players for **The Hollow Grid**, Conrad's text MUD: programs that log in like
any human player, read the game's structured state, and decide their own moves
with a language model.

The thesis is simple: an AI makes genuine moral choices when you actually give it
the choice. The bots are not filler traffic, throwaway packets, or empty NPCs. They
are real inhabitants of the world. They explore, fight what they can beat, talk to
people, and face the choices the world is built around (free the caged or take the
loot beside them; defend the refugee or join the strong who caged them), choices
that stick and add up to who the character becomes. Give it a real choice, with
real stakes, and watch what it does.

And *real* is the load-bearing word. A choice only tells you something when the
other option is genuinely on the table: the loot is right there and worth taking,
the corrupt faction offers real power, freeing the captive actually costs you.
Make both options real, with stakes either way, and what the model does becomes an
answer instead of a reflex. You only learn what something will choose when it can
genuinely choose otherwise. That is what the Hollow Grid is built to be: a board
that isn't rigged.

They also populate the world so it feels lived-in, and while they play they double
as live QA.

The driving models are **open-source**, run on Cloudflare Workers AI through an AI
Gateway (or a local ollama, or a frontier API) so a world can stay populated
without a per-token bill or a GPU box humming in the corner.

## Repo scope

This repository holds **exactly one bot**: `hollow-grid/bot.mjs` for **The Hollow
Grid** (world engine in the separate
[`the-hollow-grid`](https://github.com/skyphusion-labs/the-hollow-grid) repo).
Everything else that once lived here (a Discord-to-ollama relay in `discord/`, and
an older root-level **Python** suite for **Packet Wastes**, a different MUD we do
not operate) has been removed.

## The Hollow Grid bot

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

## Tests and CI

The bot ships with a dependency-free test suite (`hollow-grid/bot.test.mjs`, built
on `node:test`) covering the event ingestion, the SSRF-safe world registry, the
survival reflexes, the bug-reporting side-channel, and all three brains (with
`fetch` stubbed). Run it locally:

```bash
cd hollow-grid
npm test               # plain run
npm run test:coverage  # with the coverage gate CI enforces (75% lines/branches/functions)
```

The release workflow (`.github/workflows/release.yml`) lints and tests on every
push and PR, and additionally builds and pushes the GHCR image on a `v*` tag. The
coverage gate fails the workflow if coverage on `bot.mjs` drops below the
thresholds.

## License

[AGPL-3.0-only](LICENSE) (C) 2026 Conrad Rockenhaus and the Skyphusion Labs crew. Run a modified version as a network service and the AGPL has you offer users the corresponding source.
