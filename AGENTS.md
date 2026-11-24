# mud-bots

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

mud-bots holds one bot. The file is `hollow-grid/bot.mjs`. It is a Node 24 WebSocket client for The Hollow Grid. The world engine lives in the separate `the-hollow-grid` repository. Read [README.md](README.md) and [hollow-grid/README.md](hollow-grid/README.md).

Do not add a second bot to this repo. Do not add a Discord relay here. Do not add Packet Wastes tools here.

The version is in `hollow-grid/package.json`. See the latest `v*` tag and `CHANGELOG.md`.

There is no always-on host in this repo. A `v*` tag builds the image `ghcr.io/skyphusion-labs/mud-bots-hg`. Do not add an always-on deploy in a code change.

## Commands

```bash
node --check hollow-grid/bot.mjs
node --check hollow-grid/bot.test.mjs
cd hollow-grid && npm test
cd hollow-grid && npm run test:coverage
```

`npm test` uses `node:test`. The suite imports `bot.mjs` and stubs `fetch`. It needs no game server. `npm run test:coverage` fails if line, branch, or function coverage on `bot.mjs` drops below 75 percent. Keep new logic in exported functions so that gate can see it.

[`.github/workflows/release.yml`](.github/workflows/release.yml) lints and tests on every push and pull request. The image job runs on a `v*` tag. The tag commit must be on `main`. A merge to `main` leaves the image as it is. [`.github/workflows/coverage.yml`](.github/workflows/coverage.yml) runs the coverage script. [`.github/workflows/publish-npm.yml`](.github/workflows/publish-npm.yml) publishes when a GitHub Release is published. CodeQL uses GitHub default setup.

## How the bot behaves

The client connects to `/ws`. The first line is the character name. The server then sends structured `@event` lines. Survival reflexes run before the model asks for one short command. Prefer `room.actions` from the server over a guessed verb.

On grid travel, map the world name to a URL you configured. Do not dial a URL the server supplies. Env vars are in the header of `hollow-grid/bot.mjs`. Optional bug notes go to the path in `BOT_BUG`.

The brain can use a Cloudflare AI Gateway token. Provider keys stay at the provider. Local Ollama is a dev fallback. The matrix is in `hollow-grid/README.md`.

## Docs

Write Simplified Technical English. Use short sentences. Use one idea per sentence. Use the active present tense. Use plain words. Use the same word every time.

Do not use an em dash (U+2014). Do not use an en dash (U+2013). Use a comma, a semicolon, parentheses, or two hyphens (`--`).

State the limit next to the capability. Do not turn a measured result into a promise.

## Safety

Do not put a secret in a tracked file, a log, or an issue. Do not commit a gateway token.

## Commits and versions

Use Conventional Commits. The body says why. A version moves only in a release pull request. The tag shape is `v*`. Feature work does not bump the manifest. Fix work does not bump the manifest.

The public handle is `skyphusion`.
