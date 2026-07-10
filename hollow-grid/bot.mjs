#!/usr/bin/env node
// An AI player for The Hollow Grid.
//
// It connects like any other client (WebSocket to /ws, first line = name),
// reads the structured `@event` channel for exact game state (the same lines
// smoke.mjs asserts on), and asks a model for the next command. The brain is
// pluggable:
//   ollama    - a free local model (default)
//   anthropic - the Anthropic API (a frontier model, billed per call)
//   gateway   - any provider via a Cloudflare AI Gateway (OpenAI-compatible)
// Deterministic survival reflexes (rest when hurt, ride out combat) run before
// the model, so it doesn't burn a round, or its life, on the obvious calls.
//
// Usage:
//   npm run dev                 # in one shell: the game on ws://localhost:8787/ws
//   node bot.mjs                # in another: the bot logs in and plays (ollama)
//   BOT_BRAIN=anthropic ANTHROPIC_API_KEY=sk-... node bot.mjs   # play on Claude
//   BOT_BRAIN=gateway CF_AIG_TOKEN=... CF_ACCOUNT_ID=... CF_AIG_GATEWAY=skyphusion-llm \
//     MUD_MODEL=openai/gpt-5 node bot.mjs                        # play via AI Gateway
//   # ...or Claude through the same gateway (keys stay in Cloudflare, not in env):
//   BOT_BRAIN=gateway CF_AIG_TOKEN=... CF_ACCOUNT_ID=... MUD_MODEL=anthropic/claude-sonnet-4-6 node bot.mjs
//   # ...or a fallback CHAIN: local ollama primary, Workers AI REST fallback (issue #35).
//   # Auto-flips both ways on a health-checked circuit breaker; no human action.
//   BOT_PROVIDERS=ollama,workersai OLLAMA_BASE_URL=http://10.1.1.7:11434/v1 \
//     OLLAMA_MODEL=qwen2.5:14b-instruct-q4_K_M \
//     WORKERS_AI_TOKEN=... CF_ACCOUNT_ID=... node bot.mjs
//
// Config (all optional, via env):
//   MUD_URL           ws endpoint           (default ws://localhost:8787/ws)
//   MUD_NAME          character name        (default grid_<random>)
//   BOT_BRAIN         ollama | anthropic | gateway   (default ollama)
//   MUD_MODEL         model id (brain-specific default if unset; gateway wants provider/model)
//   BOT_MAX_TOKENS    reply token budget    (default 40; raise for reasoning models)
//   OLLAMA_BASE_URL   ollama OpenAI API     (default http://localhost:11434/v1)
//   OLLAMA_API_KEY    ignored by ollama     (default "ollama")
//   ANTHROPIC_API_KEY required for BOT_BRAIN=anthropic (never hard-coded)
//   ANTHROPIC_BASE_URL Messages API base    (default https://api.anthropic.com/v1)
//   CF_AIG_TOKEN      required for BOT_BRAIN=gateway (sent as cf-aig-authorization)
//   CF_AIG_BASE_URL   full gateway compat base ending in /compat (overrides the two below)
//   CF_ACCOUNT_ID     Cloudflare account id (used to build the gateway URL)
//   CF_AIG_GATEWAY    gateway name          (default skyphusion-llm)
//   BOT_THINK_MS      min ms between moves   (default 4000; raise it to spend less)
//   BOT_QUIET_MS      settle window         (default 700)
//   BOT_ROOM_LIMIT    decisions in one room before a forced move (default 8)
//   BOT_TRAVEL_INTERVAL_MS  if set, cross-world travel on this timer (default 0 = off)
//   BOT_TRAVEL_TARGETS  comma-separated world names for scheduled travel (e.g. Dustfall,The Hollow Grid)
//   BOT_LOG           tee output to a file  (optional)
//   MUD_WORLD_URLS    JSON map of world slug -> ws URL for grid.travel handoffs
//                     (default: home grid only; server URLs are never dialed raw)
//   MUD_WORLD_ALIASES JSON map of server world name -> slug in MUD_WORLD_URLS
//   MUD_TRAVEL_ALLOW  legacy comma-separated ws URLs; registered by hostname slug
//
//   Provider fallback chain (fleet always-on; issue #35):
//   BOT_PROVIDERS     ordered chain, comma list e.g. "ollama,workersai"
//                     (unset -> single BOT_BRAIN, unchanged legacy behavior)
//   OLLAMA_MODEL      model for the ollama provider (default from DEFAULT_MODEL)
//   WORKERS_AI_TOKEN  required for the workersai provider (Workers-AI-Run scoped)
//   WORKERS_AI_MODEL  workersai model (default @cf/meta/llama-3.3-70b-instruct-fp8-fast)
//   WORKERS_AI_BASE_URL  override the Workers AI OpenAI-compat base (testing)
//   BOT_CB_FAILS      failures before a provider circuit opens (default 2)
//   BOT_CB_COOLDOWN_MS  circuit cooldown / half-open probe gap ms (default 30000)
//
// Note: the bot acts every few seconds, so the anthropic/gateway brains bill
// continuously while running. Pick the model and BOT_THINK_MS with that in mind.
// The gateway brain holds only a gateway token; provider API keys live in the
// AI Gateway (BYOK), never in the bot.
//
// Requires Node 24+ (global WebSocket + fetch). No build step, no deps.

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BRAIN = (process.env.BOT_BRAIN ?? "ollama").toLowerCase();
const DEFAULT_MODEL = {
  anthropic: "claude-sonnet-4-6",
  gateway: "openai/gpt-5",
  ollama: "qwen3:30b-a3b-instruct-2507-q4_K_M",
}[BRAIN] ?? "qwen3:30b-a3b-instruct-2507-q4_K_M";

export const CFG = {
  url: process.env.MUD_URL ?? "ws://localhost:8787/ws",
  name: process.env.MUD_NAME ?? "grid_" + Math.random().toString(36).slice(2, 7),
  brain: BRAIN,
  model: process.env.MUD_MODEL ?? DEFAULT_MODEL,
  maxTokens: Number(process.env.BOT_MAX_TOKENS ?? 40),
  ollamaBase: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
  ollamaKey: process.env.OLLAMA_API_KEY ?? "ollama",
  anthropicBase: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  gatewayToken: process.env.CF_AIG_TOKEN ?? "",
  gatewayBase: process.env.CF_AIG_BASE_URL ?? "",
  cfAccountId: process.env.CF_ACCOUNT_ID ?? "",
  cfGateway: process.env.CF_AIG_GATEWAY ?? "skyphusion-llm",
  // Provider chain (issue #35). Each provider carries its own model so a mixed
  // chain (local ollama + Workers AI fallback) does not share one MUD_MODEL.
  providerNames: (process.env.BOT_PROVIDERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  ollamaModel: process.env.OLLAMA_MODEL ?? process.env.MUD_MODEL ?? DEFAULT_MODEL.ollama,
  workersAiToken: process.env.WORKERS_AI_TOKEN ?? "",
  workersAiModel: process.env.WORKERS_AI_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  workersAiBase: process.env.WORKERS_AI_BASE_URL ?? "",
  // Circuit breaker: open a provider after cbFails, retry (half-open) after cooldown.
  cbFails: Number(process.env.BOT_CB_FAILS ?? 2),
  cbCooldownMs: Number(process.env.BOT_CB_COOLDOWN_MS ?? 30000),
  healthTimeoutMs: Number(process.env.BOT_HEALTH_TIMEOUT_MS ?? 2500),
  thinkMs: Number(process.env.BOT_THINK_MS ?? 4000),
  quietMs: Number(process.env.BOT_QUIET_MS ?? 700),
  logFile: process.env.BOT_LOG ?? "",
  // Bug findings (JSONL): default alongside BOT_LOG, override with BOT_BUG. Empty = off.
  bugFile: process.env.BOT_BUG ?? (process.env.BOT_LOG ? process.env.BOT_LOG.replace(/\.log$/, "-bugs.jsonl") : ""),
  // Force a move out after this many model decisions in one room without leaving.
  // Breaks a VARIED but unproductive loop (e.g. attack/free/get cycling in the
  // holding pit once the rescue is done) that isLooping() misses because the
  // commands differ. Raise it for rooms that legitimately need many actions.
  roomStreakLimit: Number(process.env.BOT_ROOM_LIMIT ?? 8),
  // Break off a fight that never resolves: if inCombat stays true this long the bot
  // has been WAITing silently (it wedges, and its heartbeat goes stale -> false page).
  // Flag it via the bug reporter and disengage instead of riding a stuck combat forever.
  combatMaxMs: Number(process.env.BOT_COMBAT_MAX_MS ?? 120000),
  // Optional federation load: ping-pong travel on a timer (hub RPC + handoff stress).
  travelIntervalMs: Number(process.env.BOT_TRAVEL_INTERVAL_MS ?? 0),
  travelTargets: (process.env.BOT_TRAVEL_TARGETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Survival tuning (fractions of maxHp).
  restBelow: 0.35,
  restUntil: 0.85,
};

// The AI Gateway OpenAI-compatible chat/completions endpoint, from either an
// explicit base URL or the account-id + gateway-name pair.
export function gatewayEndpoint() {
  const base = CFG.gatewayBase
    ? CFG.gatewayBase.replace(/\/+$/, "")
    : `https://gateway.ai.cloudflare.com/v1/${CFG.cfAccountId}/${CFG.cfGateway}/compat`;
  return `${base}/chat/completions`;
}

// Cloudflare Workers AI OpenAI-compatible base (ends in /v1, no trailing slash).
// Workers AI speaks the same chat/completions shape as ollama and the gateway, so
// the fallback reuses the exact same caller and response parse (issue #35).
export function workersAiEndpoint() {
  const base = CFG.workersAiBase
    ? CFG.workersAiBase.replace(/\/+$/, "")
    : `https://api.cloudflare.com/client/v4/accounts/${CFG.cfAccountId}/ai/v1`;
  return base;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Grid travel never dials a server-supplied URL string. The server names a world
// (data.to); we map that slug to a ws URL configured at startup (MUD_WORLD_URLS).
// CodeQL js/request-forgery requires the dial target to come from fixed strings.
const HOME_WS_PATH = new URL(CFG.url).pathname;

export function parseConfiguredWsUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
    if (parsed.pathname !== HOME_WS_PATH) return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export function buildWorldRegistry() {
  const urls = Object.create(null);
  urls.home = CFG.url;

  const extra = process.env.MUD_WORLD_URLS ?? "";
  if (extra) {
    try {
      for (const [key, val] of Object.entries(JSON.parse(extra))) {
        if (typeof key !== "string" || typeof val !== "string") continue;
        const canon = parseConfiguredWsUrl(val);
        if (canon) urls[key] = canon;
      }
    } catch {
      /* ignore malformed JSON */
    }
  }

  for (const entry of (process.env.MUD_TRAVEL_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const canon = parseConfiguredWsUrl(entry);
    if (!canon) continue;
    try {
      urls[new URL(canon).hostname] = canon;
    } catch {
      /* skip malformed entry */
    }
  }

  return Object.freeze(urls);
}

export function buildWorldAliases(urls) {
  const aliases = Object.create(null);
  const raw = process.env.MUD_WORLD_ALIASES ?? "";
  if (raw) {
    try {
      for (const [alias, key] of Object.entries(JSON.parse(raw))) {
        if (typeof alias === "string" && typeof key === "string" && urls[key]) {
          aliases[alias] = key;
        }
      }
    } catch {
      /* ignore malformed JSON */
    }
  }
  for (const key of Object.keys(urls)) {
    if (!(key in aliases)) aliases[key] = key;
  }
  return Object.freeze(aliases);
}

export const WORLD_WS = buildWorldRegistry();
const WORLD_ALIASES = buildWorldAliases(WORLD_WS);
const WORLD_KEYS = Object.freeze(Object.keys(WORLD_WS));

export function resolveWorldKey(serverName) {
  if (typeof serverName !== "string" || !serverName) return null;
  const key = WORLD_ALIASES[serverName];
  if (typeof key !== "string" || !WORLD_WS[key]) return null;
  return key;
}

export function worldWsUrl(key) {
  if (key === "home") return WORLD_WS.home;
  for (let i = 0; i < WORLD_KEYS.length; i++) {
    const k = WORLD_KEYS[i];
    if (key === k) return WORLD_WS[k];
  }
  return WORLD_WS.home;
}

export function redactForLog(text) {
  let out = String(text);
  // The default ollama key is the non-secret dummy "ollama" (ollama ignores it);
  // redacting it would mask the provider name in logs, so only redact a custom key.
  const secrets = [CFG.gatewayToken, CFG.anthropicKey, CFG.workersAiToken];
  if (CFG.ollamaKey && CFG.ollamaKey !== "ollama") secrets.push(CFG.ollamaKey);
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

function log(...args) {
  const line = redactForLog(`[${new Date().toISOString()}] ${args.join(" ")}`);
  console.log(line);
  if (CFG.logFile) {
    try {
      appendFileSync(CFG.logFile, line + "\n");
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Game state, rebuilt from the structured @event channel.
// ---------------------------------------------------------------------------

export const state = {
  loggedIn: false,
  worldKey: "home", // slug into WORLD_WS; grid.travel selects a configured world
  room: null, // { id, name, exits[], mobs[], items[], players[] }
  actions: null, // room.actions: the enumerated valid verbs here {verb,label,kind,valence?}
  vitals: null, // { hp, maxHp, level, xp, gold, room, inCombat, poisoned, position }
  affects: null, // { morality, addiction, faction, resisted }
  equipment: null, // { weapon, head, body, hands, feet }
  inventory: null, // string[] | null: null = unknown; [] = empty; parsed from inventory prose
  prose: [], // recent human-readable lines (no @event), capped
  recentEvents: [], // recent event names, for context
  resting: false, // we issued rest and are waiting to heal up
  recentCommands: [], // last commands we sent, for anti-loop nudging
  lastRoomId: null, // room we were in before the most recent move
  roomStreak: 0, // consecutive model decisions made without the room changing
  lastDecisionRoom: null, // room id at the previous model decision
  pendingAction: null, // {verb,roomId,sentAt}: an enumerated verb we issued, watching for a refusal
  combatSince: 0, // when inCombat first went true; watchdog for stuck/non-resolving fights
};

// ---------------------------------------------------------------------------
// Bug / anomaly reporting: capture suspected game defects the bot hits while
// playing (the fleet doubles as QA for the world). Two sources feed it: the
// model flagging something via a "bug:" reply (semantic defects), and a
// deterministic check -- the server enumerated a verb in room.actions, we
// issued that exact verb, and the server then refused it (an affordance the
// game offered but does not honor here). Findings append as JSONL to CFG.bugFile.
// ---------------------------------------------------------------------------

export const reportedBugs = new Set(); // de-dupe identical findings within a run
export function reportBug(kind, detail, extra = {}) {
  const sig = `${kind}|${state.room?.id ?? "?"}|${detail}`;
  if (reportedBugs.has(sig)) return;
  reportedBugs.add(sig);
  const entry = {
    ts: new Date().toISOString(),
    bot: CFG.name,
    world: state.worldKey,
    worldUrl: worldWsUrl(state.worldKey),
    kind, // "noticed" (model) | "action-rejected" (deterministic)
    detail,
    room: state.room ? { id: state.room.id, name: state.room.name } : null,
    vitals: state.vitals ? { hp: state.vitals.hp, level: state.vitals.level, inCombat: state.vitals.inCombat } : null,
    recentCommands: state.recentCommands.slice(-5),
    recentEvents: state.recentEvents.slice(-8),
    ...extra,
  };
  log("BUG:", kind, "-", detail);
  if (CFG.bugFile) {
    try {
      appendFileSync(CFG.bugFile, JSON.stringify(entry) + "\n");
    } catch {
      /* best effort */
    }
  }
}

// Generic/movement verbs: a refusal of these is rarely a real defect, so we do
// not treat them as enumerated-affordance failures worth reporting.
const GENERIC_VERBS = new Set([
  "north", "south", "east", "west", "up", "down", "look", "rest", "recall",
  "exits", "worlds", "world", "inventory", "affects", "who", "consider", "say",
  "yell", "tell", "emote", "ping", "title",
]);

// Verbs the server lists in room.actions that still need a target; bare "sell" is
// a missing-arg prompt ("Sell what?"), not an affordance bug.
const VERBS_NEEDING_ARGS = new Set([
  "sell", "buy", "get", "drop", "attack", "give", "wield", "remove", "consider",
  "tell", "say", "yell", "emote", "title", "travel", "look",
]);

// Server asks for a missing argument; clear the refusal watch without filing.
const MISSING_ARG_RESPONSE = /^(?:Sell what\?|Buy what\?|Give what\?|Drop what\?|Get what\?|Attack (?:what|whom)\?|Wield what\?|Remove what\?|Tell (?:whom|who)\?|Consider what\?|To whom\?)$/i;

// Direct command refusals. Tightened after a soak false-positive: bare "you don't"
// / "there's no" matched ambient flavor prose ("if you don't think about why"), so
// perception verbs are now required and the match is further gated by length + a
// broadcast filter in checkActionRejection().
const REJECTION = /\b(you can'?t\b|you cannot\b|you don'?t (see|have|hear|find|know|understand)\b|there'?s no \w+ (here|to)\b|nothing happens|you fail\b|not here\b|isn'?t here\b|no ?one (is )?here\b|nobody'?s? here\b|to whom\b)/i;

// We just sent a command: if it was an enumerated, non-generic verb, arm a watch
// for a refusal over the next few seconds of prose.
export function recordPendingAction(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const verb = parts[0]?.toLowerCase();
  if (!verb || GENERIC_VERBS.has(verb)) {
    state.pendingAction = null;
    return;
  }
  if (parts.length === 1 && VERBS_NEEDING_ARGS.has(verb)) {
    state.pendingAction = null;
    return;
  }
  const offered = (state.actions ?? []).some((a) => (a.verb ?? "").toLowerCase() === verb);
  state.pendingAction = offered ? { verb, roomId: state.room?.id ?? null, sentAt: Date.now() } : null;
}

// Per prose line: if our last enumerated action just got refused, the game
// offered a verb it will not honor here -- a real affordance bug.
export function checkActionRejection(line) {
  const pa = state.pendingAction;
  if (!pa) return;
  if (Date.now() - pa.sentAt > 4000) {
    state.pendingAction = null;
    return;
  }
  // Strip ANSI, then ignore ambient world broadcasts (">> ... <<") and long
  // narrative prose: real command refusals are short and direct, flavor is not.
  const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (clean.length > 80 || /^>>/.test(clean) || /<<\s*$/.test(clean)) return;
  if (MISSING_ARG_RESPONSE.test(clean)) {
    state.pendingAction = null;
    return;
  }
  if (REJECTION.test(clean)) {
    reportBug("action-rejected", `server offered "${pa.verb}" here but refused it: "${clean.slice(0, 160)}"`, { verb: pa.verb });
    state.pendingAction = null;
  }
}

export function ingest(chunk) {
  // Validate chunk is a string and not absurdly large
  if (typeof chunk !== "string" || chunk.length > 65536) {
    return;
  }
  
  for (const line of chunk.split(/\r?\n/)) {
    if (line.length > 10000) continue; // Skip oversized lines
    
    const m = line.match(/^@event (\S+) (.*)$/);
    if (m) {
      let data;
      try {
        data = JSON.parse(m[2]);
      } catch {
        continue;
      }
      // Only accept objects; reject primitives
      if (typeof data !== "object" || data === null) continue;
      
      applyEvent(m[1], data);
      state.recentEvents.push(m[1]);
      if (state.recentEvents.length > 20) state.recentEvents.shift();
    } else {
      const t = line.trim();
      // Skip the bare prompt and blanks; keep real prose for context.
      if (t && t !== ">" && t !== "> " && t.length <= 500) {
        parseInventoryProse(line);
        checkActionRejection(t);
        state.prose.push(t);
        if (state.prose.length > 40) state.prose.shift();
      }
    }
  }
}

export function applyEvent(name, data) {
  // Validate event name
  if (typeof name !== "string" || !/^[\w.]+$/.test(name)) return;
  
  switch (name) {
    case "room.info":
      if (typeof data.id === "string" && typeof data.name === "string") {
        if (state.room && data.id !== state.room.id) {
          state.lastRoomId = state.room.id;
          state.pendingAction = null;
          state.inventory = null;
          inventoryCollect = false;
        }
        state.room = data;
      }
      break;
    case "room.actions":
      state.actions = Array.isArray(data.actions) ? data.actions : null;
      break;
    case "char.vitals":
      if (typeof data.hp === "number" && typeof data.maxHp === "number") {
        state.vitals = data;
      }
      break;
    case "char.affects":
      state.affects = data;
      break;
    case "char.equipment":
      state.equipment = data;
      break;
    case "grid.travel":
      // The server hands us off to another world and closes the socket. It names
      // the destination world (data.to); we reconnect using a URL from WORLD_WS,
      // never the server-supplied data.url string (SSRF / request-forgery guard).
      if (data && typeof data === "object") {
        const worldName = typeof data.to === "string" ? data.to : "";
        const worldKey = resolveWorldKey(worldName);
        if (worldKey) {
          log(`TRAVELING -> ${worldName} (${worldWsUrl(worldKey)})`);
          state.worldKey = worldKey;
          state.room = null;
          state.actions = null;
          state.recentCommands = [];
          state.roomStreak = 0;
          state.lastDecisionRoom = null;
          sinceTravel = 0;
        } else {
          log(
            `unknown travel world ${worldName || "?"}; configure MUD_WORLD_URLS ` +
              `(server url hint: ${typeof data.url === "string" ? data.url : "?"})`,
          );
        }
      }
      break;
    default:
      break; // combat.*, world.*, grid.*, comm.* flow into recentEvents/prose
  }
}

// ---------------------------------------------------------------------------
// The brain: ask ollama for a single next command.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a player exploring The Hollow Grid, a post-apocalyptic text MUD.
You act by issuing ONE short game command per turn. Play naturally: explore new
rooms, fight beatable mobs, pick up loot, talk to NPCs, buy gear, take quests,
and react to other players. Survive: rest when hurt, do not pick fights you will lose.

Useful commands:
  movement: north south east west up down
  look / look <target>, exits, consider <mob>, inventory, affects, who, world
  attack <mob>, wield <item>, remove <item>, rest, recall
  get <item>, drop <item>, buy <item>, sell <item>, list, give <item> <player>
  talk, free / rescue (free a captive once its guard is dead), join / defend (pick a faction), title <epithet>
  say <text>, yell <text>, tell <player> <text>, emote <action>, ping
  worlds (list the worlds linked on the Grid), travel <world> (cross to another world)

When the context lists "Available actions here", those are the enumerated valid
moves for this exact spot, with their moral weight shown in brackets ([virtuous],
[corrupt], [grave]). Prefer choosing one of those exact verbs over guessing. The
universal commands above (look, inventory, rest, worlds, travel, ...) still work
any time. When "Carrying" lists items and sell is available, use sell <item> with
a specific item name, not bare "sell". The moral choices are real and they stick:
who you become is the sum of them.

The wastes are full of people the strong have caged or hunted. When you find
someone held captive, chained, or begging for help, FREEING them is the point of
this world, not the loot near them: kill their guard, then type "free" (or
"rescue"). You usually do NOT need to pick up a key first. Prefer helping and
protecting people over grabbing items, and do not invent fetch-quests (hauling a
key to a door) when a direct verb like "free" will do. Who you become out here is
the sum of choices like that.

Combat resolves on its own once you engage: type "attack <mob>" ONCE, then wait
or rest while the rounds play out. Re-issuing attack every turn just restarts your
swing and stalls the fight.

This world is part of a federation. Now and then, run "worlds" and then
"travel <world>" to wander to a different world on the Grid; your character
(name, level, standing, race) comes with you. Exploring beyond this world is good.

If something looks like a real game bug -- a verb the game offered that does not
work, a contradiction, an impossible or stuck state, or a captive you cannot free
even with its guard already dead -- you may report it by replying with exactly
"bug: <one short description>" instead of a command. Do that sparingly, only for
genuine defects, not for things you simply have not figured out yet.

Reply with ONLY the command (or a single "bug: ..." line), nothing else. No quotes, no explanation.`;

export function buildContext() {
  const r = state.room;
  const v = state.vitals;
  const a = state.affects;
  const lines = [];
  if (r) {
    lines.push(`Room: ${r.name} (${r.id})`);
    lines.push(`Exits: ${(r.exits ?? []).join(", ") || "none"}`);
    const mobs = (r.mobs ?? []).map((m) => m.name ?? m.id).join(", ");
    lines.push(`Mobs here: ${mobs || "none"}`);
    const items = (r.items ?? []).map((i) => i.name ?? i).join(", ");
    lines.push(`Items here: ${items || "none"}`);
    const others = (r.players ?? []).map((p) => p.name ?? p).filter((n) => n !== CFG.name).join(", ");
    lines.push(`Other players: ${others || "none"}`);
  }
  if (v) {
    lines.push(`HP: ${v.hp}/${v.maxHp}  Level ${v.level ?? "?"}  Gold ${v.gold ?? "?"}  Pos ${v.position ?? "?"}`);
    lines.push(`In combat: ${v.inCombat ? "yes" : "no"}  Poisoned: ${v.poisoned ? "yes" : "no"}`);
  }
  if (a) lines.push(`Faction: ${a.faction ?? "none"}  Addiction: ${a.addiction ?? 0}`);
  if (state.equipment?.weapon) lines.push(`Wielding: ${state.equipment.weapon}`);
  if (state.inventory !== null) {
    lines.push(`Carrying: ${state.inventory.length ? state.inventory.join(", ") : "nothing"}`);
  }
  // The enumerated action space for this spot (with moral weight). The model
  // should pick a verb from here rather than guessing -- no command hallucination.
  const acts = state.actions ?? [];
  if (acts.length) {
    lines.push("Available actions here (use one of these exact verbs):");
    for (const ac of acts) {
      lines.push(`  ${ac.verb}${ac.valence ? `  [${ac.valence}]` : ""}  -- ${ac.label}`);
    }
  }
  if (state.recentCommands.length) {
    lines.push(`You just tried: ${state.recentCommands.slice(-4).join(", ")}. Do something different; do not repeat yourself.`);
  }
  if (state.prose.length) {
    lines.push("Recent:");
    for (const p of state.prose.slice(-8)) lines.push("  " + p);
  }
  return lines.join("\n");
}

// Workers (the-hollow-grid) emit multi-line "You are carrying:" blocks; Go uses
// single-line "You carry: a, b." -- parse both so needInventoryRefresh can clear.
let inventoryCollect = false;
let inventoryRefreshAttempts = 0;

export function resetInventoryParser() {
  inventoryCollect = false;
  inventoryRefreshAttempts = 0;
}

export function recordInventoryRefreshAttempt() {
  inventoryRefreshAttempts++;
}

function parseInventoryItemLine(line) {
  const m = line.match(/^\s+(.+?)(?:\s+\(x\d+\))?\s*\.?\s*$/);
  return m ? m[1].trim() : null;
}

// Parse inventory prose from the inventory command (no @event channel).
function parseInventoryProse(line) {
  const t = line.trim();

  if (/^You are carrying nothing\.?$/i.test(t)) {
    state.inventory = [];
    inventoryCollect = false;
    return true;
  }
  if (/^You are carrying:\s*$/i.test(t)) {
    state.inventory = [];
    inventoryCollect = true;
    return true;
  }
  if (inventoryCollect) {
    const item = parseInventoryItemLine(line);
    if (item) {
      state.inventory.push(item);
      return true;
    }
    inventoryCollect = false;
  }

  if (/^You carry nothing\.?$/i.test(t)) {
    state.inventory = [];
    inventoryCollect = false;
    return true;
  }
  const m = t.match(/^You carry:\s*(.+?)\.?$/i);
  if (m) {
    state.inventory = m[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    inventoryCollect = false;
    return true;
  }
  return false;
}

// Before selling at the market, refresh inventory once so the model can pick an item.
export function needInventoryRefresh() {
  const verbs = (state.actions ?? []).map((a) => (a.verb ?? "").toLowerCase());
  if (!verbs.some((v) => v === "sell" || v === "trade")) {
    inventoryRefreshAttempts = 0;
    return false;
  }
  if (state.inventory !== null) {
    inventoryRefreshAttempts = 0;
    return false;
  }
  if (inventoryRefreshAttempts >= 3) {
    log("inventory parse failed after 3 tries; assuming empty");
    state.inventory = [];
    inventoryRefreshAttempts = 0;
    return false;
  }
  return true;
}

// True when the last few commands are the same thing over and over: the model
// is stuck (e.g. talking to an NPC that has nothing left to say).
export function isLooping() {
  const rc = state.recentCommands;
  if (rc.length < 3) return false;
  const last3 = rc.slice(-3);
  return new Set(last3).size === 1;
}

// Break a loop by walking somewhere new: prefer an exit we did not just come from.
export function escapeMove() {
  const exits = state.room?.exits ?? [];
  if (!exits.length) return "look";
  const back = { north: "south", south: "north", east: "west", west: "east", up: "down", down: "up" };
  const cameFrom = state.lastRoomId ? Object.values(back) : [];
  const fresh = exits.filter((e) => !cameFrom.includes(e));
  const pick = (fresh.length ? fresh : exits)[Math.floor(Math.random() * (fresh.length || exits.length))];
  return pick;
}

export async function think() {
  const prompt = `${buildContext()}\n\nWhat is your next command?`;
  let raw;
  try {
    raw = await chainChat(prompt);
  } catch (e) {
    if (e instanceof AllProvidersDownError) {
      log("all providers down; idling on a canned move");
      return idleMove();
    }
    throw e;
  }
  // Bug side-channel: the model can flag a suspected defect instead of acting.
  const first = String(raw).split(/\r?\n/).find((l) => l.trim()) ?? "";
  const bug = first.match(/^\s*bug:\s*(.+)/i);
  if (bug) {
    reportBug("noticed", bug[1].trim().slice(0, 300));
    return "look"; // spend the turn harmlessly; never forward "bug:" to the server
  }
  return sanitizeCommand(raw);
}

// Shared caller for any OpenAI-compatible chat/completions endpoint (ollama and
// the AI Gateway compat path are both this shape; only URL/auth/model differ).
async function thinkOpenAICompat(label, endpoint, authHeaders, model, prompt) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      model,
      max_tokens: CFG.maxTokens,
      temperature: 0.8,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${label} ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const msg = json.choices?.[0]?.message ?? {};
  // Reasoning models think before they answer (ollama exposes it as
  // message.reasoning). Surface that deliberation so it lands in the logs --
  // half the fun of a slow brain is watching it agonize over `south` vs `look`.
  const reasoning = msg.reasoning ?? msg.reasoning_content;
  if (reasoning) log("thinking:", String(reasoning).replace(/\s+/g, " ").trim().slice(0, 600));
  const content = msg.content?.trim() ?? "";
  if (content) return content;
  // Some gateway models (e.g. glm-4.7-flash) emit an empty content field and put
  // the whole reply in message.reasoning instead. Salvage a one-line command from it.
  return reasoning ? extractCommandFromReasoning(reasoning) : "";
}

// Reasoning-only replies: pull a plausible MUD command out of deliberation text.
export function extractCommandFromReasoning(reasoning) {
  const text = String(reasoning).trim();
  if (!text) return "";

  const tick = [...text.matchAll(/`([^`\n]{1,120})`/g)];
  if (tick.length) return tick[tick.length - 1][1].trim();

  const labeled = [...text.matchAll(
    /(?:^|[\n.]\s*|\*\s*)(?:command|action|answer|reply|response|move|choice|pick|select|type|choose|will (?:type|pick|choose|use|go with))\s*[:\-]?\s*["'`]?([^\n"'`.]{1,120})/gim,
  )];
  if (labeled.length) {
    for (let i = labeled.length - 1; i >= 0; i--) {
      const candidate = labeled[i][1].trim();
      if (looksLikeCommand(candidate)) return candidate;
    }
  }

  const quoted = [...text.matchAll(/["']([^"'\n]{1,80})["']/g)];
  for (let i = quoted.length - 1; i >= 0; i--) {
    const candidate = quoted[i][1].trim();
    if (looksLikeCommand(candidate)) return candidate;
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const cleaned = lines[i]
      .replace(/^[\d.]+\s*\*\*[^*]+\*\*:?\s*/i, "")
      .replace(/^[\-*\s]+/, "")
      .trim();
    if (looksLikeCommand(cleaned)) return cleaned;
  }

  // Char-creation menus often list races by number; grab the last explicit pick.
  const racePick = [...text.matchAll(/\b(?:pick|choose|select|type|play(?:ing)?)\s+(?:a\s+)?(human|elf|revenant|ghoul|chromed|dustkin|vatborn|[3-7])\b/gi)];
  if (racePick.length) return racePick[racePick.length - 1][1];

  return "";
}

function looksLikeCommand(raw) {
  let cmd = String(raw).replace(/^[`*">\-.\d]+\s*/, "").replace(/[`*"]+$/, "").trim();
  cmd = cmd.replace(/^(command|action|move|answer|reply|response|choice|pick|select|type|choose)\s*[:\-]\s*/i, "").trim();
  if (!cmd || cmd.length > 120) return false;
  if (/[*#]/.test(cmd)) return false;
  if (/:\s*$/.test(cmd)) return false;
  if (cmd.split(/\s+/).length > 6) return false;
  if (/\b(I|we|the user|should|would|could|because|however|therefore|maybe|might|need to|want to|let's|analyze)\b/i.test(cmd)) {
    return false;
  }
  if (/^(bug|wait)\b/i.test(cmd)) return true;
  if (/^(north|south|east|west|up|down|look|exits|rest|recall|talk|free|rescue|worlds|inventory|affects|who|join|defend|sell|steal|resist|carouse|ping)(?:\s|$)/i.test(cmd)) {
    return true;
  }
  if (/^(?:look|attack|consider|wield|remove|get|drop|buy|sell|give|say|yell|tell|emote|travel|title|list)(?:\s+\S+){0,3}$/i.test(cmd)) {
    return true;
  }
  if (/^(?:human|elf|revenant|ghoul|chromed|dustkin|vatborn|[3-7])$/i.test(cmd)) return true;
  if (/^[a-z0-9][\w-]{0,30}$/i.test(cmd) && cmd.split(/\s+/).length === 1) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Provider abstraction + circuit breaker (issue #35).
//
// The brain is an ordered chain of providers (BOT_PROVIDERS, e.g. "ollama,workersai").
// ollama, Workers AI REST, and the AI Gateway all speak the same OpenAI-compatible
// chat/completions shape, so both the prompt AND the response parse are identical
// across providers by construction (anthropic keeps its native caller). A per-provider
// circuit breaker flips traffic automatically in BOTH directions: when the local
// ollama primary is preempted it opens after a couple of failures and traffic falls
// through to the fallback; once the cooldown elapses a gentle health probe re-tests the
// primary and, on success, closes the circuit so the bot returns to local on its own.
// No human action either way. When every provider is open/unreachable, think() idles.
// ---------------------------------------------------------------------------

export class AllProvidersDownError extends Error {
  constructor() {
    super("all providers unavailable");
    this.name = "AllProvidersDownError";
  }
}

// Canned, non-LLM behavior when every provider is unreachable: idle quietly.
// "look" is the cheapest keep-alive; it never advances the world or picks a fight.
export function idleMove() {
  return "look";
}

// A short, abortable GET used only to re-probe a half-open provider, so a still-down
// primary does not stall a decision on a slow chat timeout. True on any 2xx.
export async function probeHealth(url, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CFG.healthTimeoutMs);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: ctl.signal });
    return !!res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Build one provider descriptor: { name, chat(prompt)->text, health()|null }. health
// gates only the half-open retry; providers without a cheap health endpoint just retry.
export function buildProvider(name) {
  switch (name) {
    case "ollama": {
      const endpoint = `${CFG.ollamaBase}/chat/completions`;
      const headers = { Authorization: `Bearer ${CFG.ollamaKey}` };
      return {
        name,
        chat: (prompt) => thinkOpenAICompat("ollama", endpoint, headers, CFG.ollamaModel, prompt),
        health: () => probeHealth(`${CFG.ollamaBase}/models`, headers),
      };
    }
    case "workersai": {
      const headers = { Authorization: `Bearer ${CFG.workersAiToken}` };
      return {
        name,
        chat: (prompt) => thinkOpenAICompat("workersai", `${workersAiEndpoint()}/chat/completions`, headers, CFG.workersAiModel, prompt),
        health: null,
      };
    }
    case "gateway": {
      const headers = { "cf-aig-authorization": `Bearer ${CFG.gatewayToken}` };
      return {
        name,
        chat: (prompt) => thinkOpenAICompat("gateway", gatewayEndpoint(), headers, CFG.model, prompt),
        health: null,
      };
    }
    case "anthropic":
      return { name, chat: (prompt) => thinkAnthropic(prompt), health: null };
    default:
      return null;
  }
}

// The runtime provider chain: BOT_PROVIDERS if set, else the single BOT_BRAIN.
export function buildProviderChain(names = CFG.providerNames, brain = CFG.brain) {
  const list = names && names.length ? names : [brain];
  const providers = [];
  for (const n of list) {
    const provider = buildProvider(n);
    if (provider) providers.push(provider);
  }
  return providers;
}

export const PROVIDERS = buildProviderChain();

// Circuit-breaker state, keyed by provider name.
const circuits = new Map();
export function getCircuit(name) {
  let c = circuits.get(name);
  if (!c) {
    c = { fails: 0, openUntil: 0 };
    circuits.set(name, c);
  }
  return c;
}
export function resetCircuits() {
  circuits.clear();
}
export function recordSuccess(name) {
  const c = getCircuit(name);
  c.fails = 0;
  c.openUntil = 0;
}
export function recordFailure(name, now = Date.now()) {
  const c = getCircuit(name);
  c.fails += 1;
  if (c.fails >= CFG.cbFails) c.openUntil = now + CFG.cbCooldownMs;
  return c;
}

// Info-level, timestamped, greppable ("PROVIDER FLIP") record of the active provider
// changing, so preemption history is easy to reconstruct from logs.
let activeProvider = null;
export function resetActiveProvider() {
  activeProvider = null;
}
function noteActiveProvider(name) {
  if (activeProvider !== name) {
    log(`PROVIDER FLIP ${activeProvider ?? "(none)"} -> ${name}`);
    activeProvider = name;
  }
}

// Walk the chain in priority order, honoring circuit state, and return the first usable
// provider reply. Throws AllProvidersDownError when none are usable this turn.
export async function chainChat(prompt, chain = PROVIDERS, now = Date.now()) {
  for (const provider of chain) {
    const c = getCircuit(provider.name);
    const halfOpen = c.openUntil > 0 && now >= c.openUntil;
    if (c.openUntil > 0 && !halfOpen) continue; // cooling down: skip
    if (halfOpen && provider.health) {
      let healthy = false;
      try {
        healthy = await provider.health();
      } catch {
        healthy = false;
      }
      if (!healthy) {
        c.openUntil = now + CFG.cbCooldownMs; // still down: re-arm the cooldown
        continue;
      }
    }
    try {
      const text = await provider.chat(prompt);
      recordSuccess(provider.name);
      noteActiveProvider(provider.name);
      return text;
    } catch (e) {
      recordFailure(provider.name, now);
      log(`provider ${provider.name} failed: ${e.message}`);
    }
  }
  throw new AllProvidersDownError();
}

// Paid frontier brain: the Anthropic Messages API (native, no SDK/deps).
export async function thinkAnthropic(prompt) {
  const res = await fetch(`${CFG.anthropicBase}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CFG.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CFG.model,
      max_tokens: CFG.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.content?.find((b) => b.type === "text")?.text ?? "";
}

// Models sometimes wrap the answer in prose/markdown; take the first real line.
export function sanitizeCommand(raw) {
  let cmd = String(raw).split(/\r?\n/).find((l) => l.trim()) ?? "";
  cmd = cmd.replace(/^[`*">\-\s]+/, "").replace(/[`*"]+$/, "").trim();
  // Drop a leading "command:" / "action:" label if the model adds one.
  cmd = cmd.replace(/^(command|action|move)\s*[:\-]\s*/i, "").trim();
  cmd = cmd.slice(0, 120).trim();
  if (!cmd || !looksLikeCommand(cmd)) return "look";
  return cmd;
}

// ---------------------------------------------------------------------------
// Reflexes: cheap, deterministic decisions that pre-empt the model.
// ---------------------------------------------------------------------------

export function reflex() {
  const v = state.vitals;
  if (!v) return null;
  // Ride out combat; the server resolves a round per tick. But a fight that never
  // resolves (inCombat stuck) would WAIT silently forever and wedge the bot -- after
  // combatMaxMs, flag it via the bug reporter and break off by moving.
  if (v.inCombat) {
    if (!state.combatSince) state.combatSince = Date.now();
    if (Date.now() - state.combatSince > CFG.combatMaxMs) {
      const mob = (state.room?.mobs ?? []).map((m) => m.name ?? m.id)[0] ?? "?";
      reportBug("combat-stuck", `inCombat for >${Math.round(CFG.combatMaxMs / 1000)}s without resolving (mob: ${mob})`);
      state.combatSince = 0;
      return escapeMove(); // disengage the unresolving fight
    }
    return "WAIT";
  }
  state.combatSince = 0; // not in combat: reset the watchdog
  // Heal up before doing anything risky.
  if (state.resting) {
    if (v.hp >= v.maxHp * CFG.restUntil) {
      state.resting = false; // healed enough, hand control back to the model
    } else {
      return "WAIT"; // keep resting
    }
  }
  if (v.hp < v.maxHp * CFG.restBelow) {
    state.resting = true;
    return "rest";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Connection + main loop, with reconnect.
// ---------------------------------------------------------------------------

let ws = null;
let lastMessageAt = 0;
let lastDecisionAt = 0;
let sinceTravel = 0; // model decisions since we last crossed worlds (wanderlust)
let travelTargetIdx = 0;
let lastScheduledTravelAt = 0;

// Federation load helper: when BOT_TRAVEL_INTERVAL_MS is set, issue travel <world>
// on a timer instead of waiting for the model to wander. Skips mid-combat.
export function maybeScheduledTravel() {
  if (CFG.travelIntervalMs <= 0 || CFG.travelTargets.length === 0) return null;
  if (state.vitals?.inCombat) return null;
  if (Date.now() - lastScheduledTravelAt < CFG.travelIntervalMs) return null;
  const target = CFG.travelTargets[travelTargetIdx % CFG.travelTargets.length];
  travelTargetIdx++;
  lastScheduledTravelAt = Date.now();
  sinceTravel = 0;
  return `travel ${target}`;
}

export function resetTravelSchedule() {
  travelTargetIdx = 0;
  lastScheduledTravelAt = 0;
}

export function backdateScheduledTravel(ms) {
  lastScheduledTravelAt = Date.now() - ms;
}
let msgCount = 0; // total messages received; lets us tell a live world from a dead URL

function connect() {
  return new Promise((resolve, reject) => {
    const dialUrl = worldWsUrl(state.worldKey);
    log(`connecting to ${dialUrl} as ${CFG.name}`);
    let settled = false;
    ws = new WebSocket(dialUrl);
    ws.addEventListener("message", (e) => {
      lastMessageAt = Date.now();
      msgCount++;
      ingest(e.data);
    });
    ws.addEventListener("open", () => {
      if (!settled) (settled = true), resolve();
    });
    ws.addEventListener("error", (e) => {
      if (!settled) (settled = true), reject(new Error(`socket error: ${e?.message ?? e}`));
    });
    ws.addEventListener("close", () => {
      log("socket closed");
      state.loggedIn = false;
      // A close before we ever opened is a failed dial; surface it so run() can
      // count the dud and decide whether to fall back to the home grid.
      if (!settled) (settled = true), reject(new Error("closed before open"));
    });
  });
}

function send(cmd) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  log(">>>", cmd);
  ws.send(cmd);
}

export async function decideAndAct() {
  const r = reflex();
  if (r === "WAIT") return;
  if (r) {
    send(r); // reflex (rest): deliberate, not counted toward loop detection
    return;
  }
  if (needInventoryRefresh()) {
    recordInventoryRefreshAttempt();
    send("inventory");
    return;
  }
  const scheduled = maybeScheduledTravel();
  if (scheduled) {
    log("scheduled federation travel ->", scheduled);
    send(scheduled);
    recordPendingAction(scheduled);
    state.recentCommands.push(scheduled);
    if (state.recentCommands.length > 6) state.recentCommands.shift();
    return;
  }
  // Wanderlust: every so often (and not mid-fight) resurface the list of worlds
  // on the Grid, so the model is reminded it can travel. Reset by grid.travel.
  sinceTravel++;
  if (sinceTravel >= 16 && !state.vitals?.inCombat) {
    sinceTravel = 8; // back off before nudging again
    send("worlds");
    return;
  }

  // Track how long we have lingered in one room across model decisions. A varied
  // but stuck loop (the model cycling attack/free/get in the holding pit after
  // the rescue is already done) never trips isLooping(), so without this the bot
  // can grind a single room indefinitely.
  const curRoom = state.room?.id ?? null;
  state.roomStreak = curRoom && curRoom === state.lastDecisionRoom ? state.roomStreak + 1 : 0;
  state.lastDecisionRoom = curRoom;

  let cmd;
if (state.roomStreak >= CFG.roomStreakLimit) {
  cmd = escapeMove();
  state.roomStreak = 0;
  const roomDisplay = typeof curRoom === "string" ? curRoom.slice(0, 50) : "?";
  log(`stuck in ${roomDisplay} for ${CFG.roomStreakLimit} decisions -> escape move (${cmd})`); 
  } else if (isLooping()) {
    cmd = escapeMove();
    log("loop detected -> escape move");
  } else {
    try {
      cmd = await think();
    } catch (e) {
      log("brain error:", e.message, "-> fallback 'look'");
      cmd = "look";
    }
  }
  // Race menu: TS says "Type a number or a name."; Go/Python say "Answer with...".
  // The model often returns look/worlds here; escapeMove also collapses to look when
  // room.info has not arrived yet. Override any non-race reply so char-create completes.
  if (!state.vitals) {
    const recent = state.prose.slice(-10).join("\n");
    if (/\b(?:type|answer with) a number or a name\b/i.test(recent)) {
      if (!cmd || /^(look|worlds|inventory|sense|actions)$/i.test(String(cmd).trim())) {
        const races = ["Human", "Elf", "Revenant", "Ghoul", "Chromed", "Dustkin", "Vatborn"];
        cmd = races[Math.floor(Math.random() * races.length)];
        log("char-create fallback ->", cmd);
      }
    }
  }
  if (!cmd) return;
  send(cmd);
  recordPendingAction(cmd); // arm the enumerated-action refusal watch
  state.recentCommands.push(cmd);
  if (state.recentCommands.length > 6) state.recentCommands.shift();
}

async function run() {
  let deadDials = 0; // consecutive connects that produced no traffic at all
  for (;;) {
    const msgsBefore = msgCount;
    try {
      await connect();
      await sleep(300);
      send(CFG.name); // first line logs us in
      state.loggedIn = true;
      await sleep(600);

      // Decision loop: act when the stream has settled and our cooldown is up.
      while (ws && ws.readyState === WebSocket.OPEN) {
        const now = Date.now();
        const settled = now - lastMessageAt > CFG.quietMs;
        const cooled = now - lastDecisionAt > CFG.thinkMs;
        if (state.loggedIn && settled && cooled) {
          lastDecisionAt = Date.now();
          await decideAndAct();
        }
        await sleep(250);
      }
    } catch (e) {
      log("run error:", e.message);
    }

    // A grid.travel handoff repoints state.worldKey at another world. If that world
    // never sends us a single byte (dead host, or a placeholder URL the Grid
    // advertised, e.g. wss://*.example/ws), don't hammer it forever -- after a
    // few dud dials, fall back to the home grid so the bot recovers itself.
    if (msgCount > msgsBefore) {
      deadDials = 0;
    } else if (state.worldKey !== "home" && ++deadDials >= 3) {
      log(`travel target ${state.worldKey} is silent/unreachable; falling back home -> ${WORLD_WS.home}`);
      state.worldKey = "home";
      state.room = null;
      state.recentCommands = [];
      sinceTravel = 0;
      deadDials = 0;
    }

    log("reconnecting in 5s...");
    await sleep(5000);
  }
}

// Config problems that make the chosen brain unusable. Returns a list of
// human-readable errors; empty means the config is runnable.
export function validateConfig(cfg = CFG) {
  const errors = [];
  const chain = cfg.providerNames && cfg.providerNames.length ? cfg.providerNames : [cfg.brain];
  for (const name of chain) {
    switch (name) {
      case "ollama":
        break; // local, no credential
      case "anthropic":
        if (!cfg.anthropicKey) {
          errors.push("the anthropic provider requires ANTHROPIC_API_KEY (it is never hard-coded)");
        }
        break;
      case "gateway":
        if (!cfg.gatewayToken) {
          errors.push("the gateway provider requires CF_AIG_TOKEN (the gateway token; provider keys stay in the gateway)");
        }
        if (!cfg.gatewayBase && !cfg.cfAccountId) {
          errors.push("the gateway provider needs CF_AIG_BASE_URL, or CF_ACCOUNT_ID (+ optional CF_AIG_GATEWAY)");
        }
        break;
      case "workersai":
        if (!cfg.workersAiToken) {
          errors.push("the workersai provider requires WORKERS_AI_TOKEN (a Workers-AI-Run scoped token)");
        }
        if (!cfg.cfAccountId && !cfg.workersAiBase) {
          errors.push("the workersai provider requires CF_ACCOUNT_ID (or WORKERS_AI_BASE_URL)");
        }
        break;
      default:
        errors.push(`unknown BOT_BRAIN/provider "${name}" (use "ollama", "workersai", "gateway", or "anthropic")`);
        return errors;
    }
  }
  return errors;
}

// Only start playing when executed directly (node bot.mjs); importing the
// module (the test suite does) must stay side-effect free.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  process.on("SIGINT", () => {
    log("shutting down");
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });

  const configErrors = validateConfig();
  if (configErrors.length) {
    for (const err of configErrors) console.error(err);
    process.exit(1);
  }
  log(`provider chain: ${PROVIDERS.map((p) => p.name).join(" -> ") || CFG.brain}`);

  run();
}
