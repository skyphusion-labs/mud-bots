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
//   BOT_LOG           tee output to a file  (optional)
//
// Note: the bot acts every few seconds, so the anthropic/gateway brains bill
// continuously while running. Pick the model and BOT_THINK_MS with that in mind.
// The gateway brain holds only a gateway token; provider API keys live in the
// AI Gateway (BYOK), never in the bot.
//
// Requires Node 24+ (global WebSocket + fetch). No build step, no deps.

import { appendFileSync } from "node:fs";

const BRAIN = (process.env.BOT_BRAIN ?? "ollama").toLowerCase();
const DEFAULT_MODEL = {
  anthropic: "claude-sonnet-4-6",
  gateway: "openai/gpt-5",
  ollama: "qwen3:30b-a3b-instruct-2507-q4_K_M",
}[BRAIN] ?? "qwen3:30b-a3b-instruct-2507-q4_K_M";

const CFG = {
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
  thinkMs: Number(process.env.BOT_THINK_MS ?? 4000),
  quietMs: Number(process.env.BOT_QUIET_MS ?? 700),
  logFile: process.env.BOT_LOG ?? "",
  // Force a move out after this many model decisions in one room without leaving.
  // Breaks a VARIED but unproductive loop (e.g. attack/free/get cycling in the
  // holding pit once the rescue is done) that isLooping() misses because the
  // commands differ. Raise it for rooms that legitimately need many actions.
  roomStreakLimit: Number(process.env.BOT_ROOM_LIMIT ?? 8),
  // Survival tuning (fractions of maxHp).
  restBelow: 0.35,
  restUntil: 0.85,
};

// The AI Gateway OpenAI-compatible chat/completions endpoint, from either an
// explicit base URL or the account-id + gateway-name pair.
function gatewayEndpoint() {
  const base = CFG.gatewayBase
    ? CFG.gatewayBase.replace(/\/+$/, "")
    : `https://gateway.ai.cloudflare.com/v1/${CFG.cfAccountId}/${CFG.cfGateway}/compat`;
  return `${base}/chat/completions`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
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

const state = {
  loggedIn: false,
  url: CFG.url, // where to (re)connect; a grid.travel handoff repoints this to another world
  room: null, // { id, name, exits[], mobs[], items[], players[] }
  actions: null, // room.actions: the enumerated valid verbs here {verb,label,kind,valence?}
  vitals: null, // { hp, maxHp, level, xp, gold, room, inCombat, poisoned, position }
  affects: null, // { morality, addiction, faction, resisted }
  equipment: null, // { weapon, head, body, hands, feet }
  prose: [], // recent human-readable lines (no @event), capped
  recentEvents: [], // recent event names, for context
  resting: false, // we issued rest and are waiting to heal up
  recentCommands: [], // last commands we sent, for anti-loop nudging
  lastRoomId: null, // room we were in before the most recent move
  roomStreak: 0, // consecutive model decisions made without the room changing
  lastDecisionRoom: null, // room id at the previous model decision
};

function ingest(chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    const m = line.match(/^@event (\S+) (.*)$/);
    if (m) {
      let data;
      try {
        data = JSON.parse(m[2]);
      } catch {
        continue;
      }
      applyEvent(m[1], data);
      state.recentEvents.push(m[1]);
      if (state.recentEvents.length > 20) state.recentEvents.shift();
    } else {
      const t = line.trim();
      // Skip the bare prompt and blanks; keep real prose for context.
      if (t && t !== ">" && t !== "> ") {
        state.prose.push(t);
        if (state.prose.length > 40) state.prose.shift();
      }
    }
  }
}

function applyEvent(name, data) {
  switch (name) {
    case "room.info":
      if (state.room && data.id !== state.room.id) state.lastRoomId = state.room.id;
      state.room = data;
      break;
    case "room.actions":
      // The server enumerates every valid verb here (with moral valence), so we
      // never have to hallucinate the action space. The headline affordance layer.
      state.actions = data.actions;
      break;
    case "char.vitals":
      state.vitals = data;
      break;
    case "char.affects":
      state.affects = data;
      break;
    case "char.equipment":
      state.equipment = data;
      break;
    case "char.died":
      // Respawn handling is server-side; just note it and let the loop resume.
      log("DIED ->", JSON.stringify(data));
      state.resting = false;
      break;
    case "grid.travel":
      // The server hands us off to another world and closes the socket; point
      // the reconnect there so we arrive as the same character (name/level/
      // standing -- and now race -- travel with us across the Grid).
      if (data.url) {
        log(`TRAVELING -> ${data.to ?? "?"} (${data.url})`);
        state.url = data.url;
        state.room = null;
        state.actions = null;
        state.recentCommands = [];
        state.roomStreak = 0;
        state.lastDecisionRoom = null;
        sinceTravel = 0;
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
any time. The moral choices are real and they stick: who you become is the sum of
them.

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

Reply with ONLY the command, nothing else. No quotes, no explanation.`;

function buildContext() {
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

// True when the last few commands are the same thing over and over: the model
// is stuck (e.g. talking to an NPC that has nothing left to say).
function isLooping() {
  const rc = state.recentCommands;
  if (rc.length < 3) return false;
  const last3 = rc.slice(-3);
  return new Set(last3).size === 1;
}

// Break a loop by walking somewhere new: prefer an exit we did not just come from.
function escapeMove() {
  const exits = state.room?.exits ?? [];
  if (!exits.length) return "look";
  const back = { north: "south", south: "north", east: "west", west: "east", up: "down", down: "up" };
  const cameFrom = state.lastRoomId ? Object.values(back) : [];
  const fresh = exits.filter((e) => !cameFrom.includes(e));
  const pick = (fresh.length ? fresh : exits)[Math.floor(Math.random() * (fresh.length || exits.length))];
  return pick;
}

async function think() {
  const prompt = `${buildContext()}\n\nWhat is your next command?`;
  let raw;
  if (CFG.brain === "anthropic") raw = await thinkAnthropic(prompt);
  else if (CFG.brain === "gateway") raw = await thinkGateway(prompt);
  else raw = await thinkOllama(prompt);
  return sanitizeCommand(raw);
}

// Shared caller for any OpenAI-compatible chat/completions endpoint (ollama and
// the AI Gateway compat path are both this shape; only URL/auth/model differ).
async function thinkOpenAICompat(label, endpoint, authHeaders, prompt) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      model: CFG.model,
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
  return msg.content ?? "";
}

// Free local brain: ollama's OpenAI-compatible chat endpoint.
const thinkOllama = (prompt) =>
  thinkOpenAICompat("ollama", `${CFG.ollamaBase}/chat/completions`,
    { Authorization: `Bearer ${CFG.ollamaKey}` }, prompt);

// Cloudflare AI Gateway brain: OpenAI-compatible, any provider via provider/model.
// Authenticates to the gateway with a gateway token; provider keys live in the
// gateway (BYOK), not here.
const thinkGateway = (prompt) =>
  thinkOpenAICompat("gateway", gatewayEndpoint(),
    { "cf-aig-authorization": `Bearer ${CFG.gatewayToken}` }, prompt);

// Paid frontier brain: the Anthropic Messages API (native, no SDK/deps).
async function thinkAnthropic(prompt) {
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
function sanitizeCommand(raw) {
  let cmd = String(raw).split(/\r?\n/).find((l) => l.trim()) ?? "";
  cmd = cmd.replace(/^[`*">\-\s]+/, "").replace(/[`*"]+$/, "").trim();
  // Drop a leading "command:" / "action:" label if the model adds one.
  cmd = cmd.replace(/^(command|action|move)\s*[:\-]\s*/i, "").trim();
  return cmd.slice(0, 120);
}

// ---------------------------------------------------------------------------
// Reflexes: cheap, deterministic decisions that pre-empt the model.
// ---------------------------------------------------------------------------

function reflex() {
  const v = state.vitals;
  if (!v) return null;
  // Ride out combat; the server resolves a round per alarm tick on its own.
  if (v.inCombat) return "WAIT";
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
let msgCount = 0; // total messages received; lets us tell a live world from a dead URL

function connect() {
  return new Promise((resolve, reject) => {
    log(`connecting to ${state.url} as ${CFG.name}`);
    let settled = false; // resolve/reject exactly once for this attempt
    ws = new WebSocket(state.url);
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

async function decideAndAct() {
  const r = reflex();
  if (r === "WAIT") return;
  if (r) {
    send(r); // reflex (rest): deliberate, not counted toward loop detection
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
    log(`stuck in ${curRoom} for ${CFG.roomStreakLimit} decisions -> escape move (${cmd})`);
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
  if (!cmd) return;
  send(cmd);
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

    // A grid.travel handoff repoints state.url at another world. If that world
    // never sends us a single byte (dead host, or a placeholder URL the Grid
    // advertised, e.g. wss://*.example/ws), don't hammer it forever -- after a
    // few dud dials, fall back to the home grid so the bot recovers itself.
    if (msgCount > msgsBefore) {
      deadDials = 0;
    } else if (state.url !== CFG.url && ++deadDials >= 3) {
      log(`travel target ${state.url} is silent/unreachable; falling back home -> ${CFG.url}`);
      state.url = CFG.url;
      state.room = null;
      state.recentCommands = [];
      sinceTravel = 0;
      deadDials = 0;
    }

    log("reconnecting in 5s...");
    await sleep(5000);
  }
}

process.on("SIGINT", () => {
  log("shutting down");
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
});

if (!["ollama", "anthropic", "gateway"].includes(CFG.brain)) {
  console.error(`unknown BOT_BRAIN "${CFG.brain}" (use "ollama", "anthropic", or "gateway")`);
  process.exit(1);
}
if (CFG.brain === "anthropic" && !CFG.anthropicKey) {
  console.error("BOT_BRAIN=anthropic requires ANTHROPIC_API_KEY (it is never hard-coded)");
  process.exit(1);
}
if (CFG.brain === "gateway") {
  if (!CFG.gatewayToken) {
    console.error("BOT_BRAIN=gateway requires CF_AIG_TOKEN (the gateway token; provider keys stay in the gateway)");
    process.exit(1);
  }
  if (!CFG.gatewayBase && !CFG.cfAccountId) {
    console.error("BOT_BRAIN=gateway needs CF_AIG_BASE_URL, or CF_ACCOUNT_ID (+ optional CF_AIG_GATEWAY)");
    process.exit(1);
  }
  log(`gateway endpoint: ${gatewayEndpoint()}`);
}
log(`brain: ${CFG.brain} (model ${CFG.model})`);

run();
