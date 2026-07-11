// Test suite for the Hollow Grid bot (node:test, zero dependencies).
//
// Run:  npm test          (wired with coverage thresholds; see package.json)
//       node --test bot.test.mjs
//
// The env below is set BEFORE bot.mjs is imported because the world registry
// and CFG are built at module load. bot.mjs only starts playing when executed
// directly, so importing it here is side-effect free.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.MUD_URL = "ws://localhost:8787/ws";
process.env.MUD_NAME = "testbot";
process.env.BOT_BRAIN = "ollama";
process.env.CF_AIG_TOKEN = "gw-secret-token-1234";
process.env.MUD_WORLD_URLS = JSON.stringify({
  dustfall: "ws://dustfall.example:8787/ws",
  evil: "http://evil.example/ws", // wrong protocol: must be dropped
  offpath: "ws://offpath.example:8787/other", // wrong path: must be dropped
});
process.env.MUD_WORLD_ALIASES = JSON.stringify({
  "The Dustfall Reach": "dustfall",
  ghost: "nowhere", // alias to an unregistered world: must be dropped
});
process.env.MUD_TRAVEL_ALLOW = "ws://legacy.example:8787/ws, not a url";
delete process.env.BOT_LOG;
delete process.env.BOT_BUG;

const bot = await import("./bot.mjs");
const {
  CFG, state, reportedBugs,
  parseConfiguredWsUrl, buildWorldRegistry, buildWorldAliases,
  resolveWorldKey, worldWsUrl, WORLD_WS,
  redactForLog, gatewayEndpoint, sanitizeCommand, extractCommandFromReasoning, validateConfig,
  ingest, applyEvent, buildContext, isLooping, escapeMove, reflex,
  recordPendingAction, checkActionRejection, reportBug, needInventoryRefresh,
  resetInventoryParser,
  recordInventoryRefreshAttempt,
  think, thinkAnthropic, decideAndAct, maybeScheduledTravel, resetTravelSchedule, backdateScheduledTravel,
  buildProvider, buildProviderChain, chainChat, AllProvidersDownError, idleMove,
  resetCircuits, recordFailure, recordSuccess, getCircuit, resetActiveProvider,
  probeHealth, workersAiEndpoint, PROVIDERS,
} = bot;

function resetState() {
  state.loggedIn = false;
  state.worldKey = "home";
  state.room = null;
  state.actions = null;
  state.vitals = null;
  state.affects = null;
  state.equipment = null;
  state.inventory = null;
  state.charCreate = null;
  state.prose = [];
  state.recentEvents = [];
  state.resting = false;
  state.recentCommands = [];
  state.lastRoomId = null;
  state.roomStreak = 0;
  state.lastDecisionRoom = null;
  state.pendingAction = null;
  state.combatSince = 0;
  reportedBugs.clear();
  resetInventoryParser();
  resetCircuits();
  resetActiveProvider();
}

// Swap globalThis.fetch for the duration of one call.
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const okJson = (payload) => ({
  ok: true,
  json: async () => payload,
});

describe("world registry (SSRF guard)", () => {
  test("parseConfiguredWsUrl accepts ws/wss on the home path", () => {
    assert.equal(parseConfiguredWsUrl("ws://a.example:8787/ws"), "ws://a.example:8787/ws");
    assert.equal(parseConfiguredWsUrl("wss://b.example/ws"), "wss://b.example/ws");
  });

  test("parseConfiguredWsUrl rejects non-ws protocols, wrong paths, and garbage", () => {
    assert.equal(parseConfiguredWsUrl("http://a.example/ws"), null);
    assert.equal(parseConfiguredWsUrl("ws://a.example/admin"), null);
    assert.equal(parseConfiguredWsUrl("not a url"), null);
  });

  test("buildWorldRegistry keeps home + valid configured worlds, drops invalid ones", () => {
    const urls = buildWorldRegistry();
    assert.equal(urls.home, "ws://localhost:8787/ws");
    assert.equal(urls.dustfall, "ws://dustfall.example:8787/ws");
    assert.equal(urls.evil, undefined);
    assert.equal(urls.offpath, undefined);
    // legacy MUD_TRAVEL_ALLOW entries are registered by hostname
    assert.equal(urls["legacy.example"], "ws://legacy.example:8787/ws");
  });

  test("buildWorldRegistry ignores malformed MUD_WORLD_URLS JSON", () => {
    const saved = process.env.MUD_WORLD_URLS;
    process.env.MUD_WORLD_URLS = "{not json";
    try {
      const urls = buildWorldRegistry();
      assert.equal(urls.home, "ws://localhost:8787/ws");
      assert.equal(Object.keys(urls).includes("dustfall"), false);
    } finally {
      process.env.MUD_WORLD_URLS = saved;
    }
  });

  test("buildWorldAliases maps aliases only to registered worlds and self-maps keys", () => {
    const aliases = buildWorldAliases(WORLD_WS);
    assert.equal(aliases["The Dustfall Reach"], "dustfall");
    assert.equal(aliases.ghost, undefined);
    assert.equal(aliases.home, "home");
    assert.equal(aliases.dustfall, "dustfall");
  });

  test("resolveWorldKey resolves aliases and identities, null otherwise", () => {
    assert.equal(resolveWorldKey("The Dustfall Reach"), "dustfall");
    assert.equal(resolveWorldKey("dustfall"), "dustfall");
    assert.equal(resolveWorldKey("nowhere"), null);
    assert.equal(resolveWorldKey(""), null);
    assert.equal(resolveWorldKey(42), null);
  });

  test("worldWsUrl returns the configured URL and falls back home for unknown keys", () => {
    assert.equal(worldWsUrl("home"), "ws://localhost:8787/ws");
    assert.equal(worldWsUrl("dustfall"), "ws://dustfall.example:8787/ws");
    assert.equal(worldWsUrl("unregistered"), "ws://localhost:8787/ws");
  });
});

describe("logging and config", () => {
  test("redactForLog strips configured secrets", () => {
    const line = `auth gw-secret-token-1234 sent`;
    assert.equal(redactForLog(line).includes("gw-secret-token-1234"), false);
    assert.equal(redactForLog(line).includes("[redacted]"), true);
  });

  test("gatewayEndpoint builds from account id or explicit base", () => {
    const savedBase = CFG.gatewayBase;
    const savedAccount = CFG.cfAccountId;
    try {
      CFG.gatewayBase = "";
      CFG.cfAccountId = "acct123";
      assert.equal(
        gatewayEndpoint(),
        "https://gateway.ai.cloudflare.com/v1/acct123/skyphusion-llm/compat/chat/completions",
      );
      CFG.gatewayBase = "https://gw.example/compat///";
      assert.equal(gatewayEndpoint(), "https://gw.example/compat/chat/completions");
    } finally {
      CFG.gatewayBase = savedBase;
      CFG.cfAccountId = savedAccount;
    }
  });

  test("validateConfig accepts the ollama default", () => {
    assert.deepEqual(validateConfig({ brain: "ollama" }), []);
  });

  test("validateConfig rejects an unknown brain", () => {
    const errors = validateConfig({ brain: "psychic" });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /unknown BOT_BRAIN/);
  });

  test("validateConfig requires the anthropic key", () => {
    assert.match(validateConfig({ brain: "anthropic", anthropicKey: "" })[0], /ANTHROPIC_API_KEY/);
    assert.deepEqual(validateConfig({ brain: "anthropic", anthropicKey: "sk-x" }), []);
  });

  test("validateConfig requires gateway token and endpoint info", () => {
    const errors = validateConfig({ brain: "gateway", gatewayToken: "", gatewayBase: "", cfAccountId: "" });
    assert.equal(errors.length, 2);
    assert.deepEqual(validateConfig({ brain: "gateway", gatewayToken: "t", gatewayBase: "", cfAccountId: "acct" }), []);
  });
});

describe("command sanitizing", () => {
  test("takes the first non-empty line and strips wrapping", () => {
    assert.equal(sanitizeCommand("\n\n  `north`\n"), "north");
    assert.equal(sanitizeCommand("> **look**"), "look");
    assert.equal(sanitizeCommand('- "attack rat"'), "attack rat");
  });

  test("drops a leading command label and caps length", () => {
    assert.equal(sanitizeCommand("Command: south"), "south");
    assert.equal(sanitizeCommand("action - west"), "west");
    assert.equal(sanitizeCommand("attack " + "x".repeat(200)).length, 120);
  });

  test("empty or non-command input falls back to look", () => {
    assert.equal(sanitizeCommand(""), "look");
    assert.equal(sanitizeCommand("   \n  "), "look");
    assert.equal(sanitizeCommand("I should probably go south because it is safer."), "look");
    assert.equal(sanitizeCommand(".printStackTrace()"), "look");
  });
});

describe("event ingestion", () => {
  beforeEach(resetState);

  test("char.create stores the offered races; malformed payloads are rejected (#41)", () => {
    ingest('@event char.create {"races":["Human","Elf"],"prompt":"race"}');
    assert.deepEqual(state.charCreate, { races: ["Human", "Elf"] });
    state.charCreate = null;
    ingest('@event char.create {"races":[],"prompt":"race"}');
    assert.equal(state.charCreate, null); // empty list is not a menu
    ingest('@event char.create {"races":[1,2],"prompt":"race"}');
    assert.equal(state.charCreate, null); // non-string races rejected
  });

  test("char.vitals ends creation: a stale char.create is cleared (#41)", () => {
    ingest('@event char.create {"races":["Human"],"prompt":"race"}');
    ingest('@event char.vitals {"hp":20,"maxHp":20}');
    assert.equal(state.charCreate, null);
  });

  test("room.info replaces the room and tracks the previous one", () => {
    ingest('@event room.info {"id":"r1","name":"The Pit","exits":["north"]}');
    assert.equal(state.room.id, "r1");
    ingest('@event room.info {"id":"r2","name":"The Ridge","exits":["south"]}');
    assert.equal(state.room.id, "r2");
    assert.equal(state.lastRoomId, "r1");
    assert.deepEqual(state.recentEvents, ["room.info", "room.info"]);
  });

  test("malformed or primitive @event payloads are ignored", () => {
    ingest("@event room.info {broken json");
    ingest('@event room.info "just a string"');
    ingest('@event room.info {"id":42,"name":"bad types"}');
    assert.equal(state.room, null);
  });

  test("prose lines are kept (capped at 40), prompts and blanks are skipped", () => {
    ingest("A rat scurries past.\n>\n> \n\nAnother line.");
    assert.deepEqual(state.prose, ["A rat scurries past.", "Another line."]);
    for (let i = 0; i < 50; i++) ingest(`line ${i}`);
    assert.equal(state.prose.length, 40);
    assert.equal(state.prose.at(-1), "line 49");
  });

  test("non-string and oversized chunks and lines are rejected", () => {
    ingest(12345);
    ingest("x".repeat(70000));
    ingest("y".repeat(20000));
    assert.deepEqual(state.prose, []);
  });

  test("grid.travel to a configured world switches worldKey and resets room state", () => {
    state.room = { id: "r1", name: "The Pit" };
    applyEvent("grid.travel", { to: "The Dustfall Reach", url: "wss://attacker.example/ws" });
    assert.equal(state.worldKey, "dustfall");
    assert.equal(state.room, null);
    // the server-supplied url hint is never dialed; the registry decides
    assert.equal(worldWsUrl(state.worldKey), "ws://dustfall.example:8787/ws");
  });

  test("grid.travel to an unknown world is refused", () => {
    applyEvent("grid.travel", { to: "somewhere-shady", url: "wss://attacker.example/ws" });
    assert.equal(state.worldKey, "home");
  });

  test("applyEvent rejects invalid event names and unknown events flow through", () => {
    applyEvent("bad name!", { id: "r1" });
    applyEvent("combat.round", { damage: 3 });
    assert.equal(state.room, null);
  });

  test("char.vitals, room.actions, char.affects, and char.equipment update state", () => {
    applyEvent("char.vitals", { hp: 12, maxHp: 30, level: 2, inCombat: false });
    assert.equal(state.vitals.hp, 12);
    applyEvent("room.actions", { actions: [{ verb: "free", valence: "virtuous", label: "free captive" }] });
    assert.equal(state.actions.length, 1);
    applyEvent("char.affects", { morality: 5, faction: "ally" });
    assert.equal(state.affects.faction, "ally");
    applyEvent("char.equipment", { weapon: "rusted shiv" });
    assert.equal(state.equipment.weapon, "rusted shiv");
    applyEvent("char.vitals", { hp: "nope", maxHp: 30 });
    assert.equal(state.vitals.hp, 12);
  });
});

describe("context building and loop breaking", () => {
  beforeEach(resetState);

  test("buildContext surfaces room, vitals, actions with valence, and recent prose", () => {
    state.room = {
      id: "r1", name: "Holding Pit", exits: ["north", "east"],
      mobs: [{ name: "guard" }], items: [{ name: "rusty key" }],
      players: [{ name: "testbot" }, { name: "somebody" }],
    };
    state.vitals = { hp: 10, maxHp: 20, level: 2, gold: 5, position: "standing", inCombat: false, poisoned: true };
    state.affects = { faction: "none", addiction: 0 };
    state.equipment = { weapon: "pipe" };
    state.actions = [{ verb: "free", label: "free the captive", valence: "virtuous" }];
    state.recentCommands = ["look"];
    state.prose = ["The guard sneers."];
    const ctx = buildContext();
    assert.match(ctx, /Room: Holding Pit \(r1\)/);
    assert.match(ctx, /Exits: north, east/);
    assert.match(ctx, /Mobs here: guard/);
    assert.match(ctx, /Other players: somebody/);
    assert.match(ctx, /Poisoned: yes/);
    assert.match(ctx, /Wielding: pipe/);
    assert.match(ctx, /free {2}\[virtuous\] {2}-- free the captive/);
    assert.match(ctx, /You just tried: look/);
    assert.match(ctx, /The guard sneers\./);
  });

  test("buildContext includes parsed inventory", () => {
    state.inventory = ["charm", "scrap"];
    const ctx = buildContext();
    assert.match(ctx, /Carrying: charm, scrap/);
  });

  test("ingest parses inventory prose", () => {
    ingest("You carry: rusted shiv, charm.");
    assert.deepEqual(state.inventory, ["rusted shiv", "charm"]);
    ingest("You carry nothing.");
    assert.deepEqual(state.inventory, []);
  });

  test("ingest parses Workers multi-line inventory", () => {
    ingest("You are carrying:");
    ingest("  rusted shiv");
    ingest("  antidote vial (x2)");
    assert.deepEqual(state.inventory, ["rusted shiv", "antidote vial"]);
  });

  test("ingest parses Workers empty inventory", () => {
    ingest("You are carrying nothing.");
    assert.deepEqual(state.inventory, []);
  });

  test("needInventoryRefresh fails open after repeated parse misses", () => {
    state.actions = [{ verb: "sell", label: "sell salvage" }];
    state.inventory = null;
    for (let i = 0; i < 3; i++) {
      assert.equal(needInventoryRefresh(), true);
      recordInventoryRefreshAttempt();
    }
    assert.equal(needInventoryRefresh(), false);
    assert.deepEqual(state.inventory, []);
  });

  test("needInventoryRefresh when sell is offered and inventory unknown", () => {
    state.actions = [{ verb: "sell", label: "sell salvage" }];
    assert.equal(needInventoryRefresh(), true);
    state.inventory = ["scrap"];
    assert.equal(needInventoryRefresh(), false);
  });

  test("buildContext with no state yields no room lines", () => {
    assert.equal(buildContext().includes("Room:"), false);
  });

  test("isLooping only trips on three identical trailing commands", () => {
    state.recentCommands = ["look", "look"];
    assert.equal(isLooping(), false);
    state.recentCommands = ["north", "look", "look", "look"];
    assert.equal(isLooping(), true);
    state.recentCommands = ["look", "north", "look"];
    assert.equal(isLooping(), false);
  });

  test("escapeMove picks a real exit, or looks when there are none", () => {
    state.room = { id: "r1", exits: ["north", "east"] };
    assert.equal(["north", "east"].includes(escapeMove()), true);
    state.room = { id: "r2", exits: [] };
    assert.equal(escapeMove(), "look");
    state.room = null;
    assert.equal(escapeMove(), "look");
  });
});

describe("survival reflexes", () => {
  beforeEach(resetState);

  test("no vitals yet: hand straight to the model", () => {
    assert.equal(reflex(), null);
  });

  test("rides out combat and stamps combatSince", () => {
    state.vitals = { hp: 20, maxHp: 20, inCombat: true };
    assert.equal(reflex(), "WAIT");
    assert.notEqual(state.combatSince, 0);
  });

  test("a combat that never resolves is reported and escaped", () => {
    state.room = { id: "pit", exits: ["north"], mobs: [{ name: "wraith" }] };
    state.vitals = { hp: 20, maxHp: 20, inCombat: true };
    state.combatSince = Date.now() - CFG.combatMaxMs - 1000;
    const move = reflex();
    assert.equal(move, "north");
    assert.equal(state.combatSince, 0);
    assert.equal([...reportedBugs].some((sig) => sig.startsWith("combat-stuck|")), true);
  });

  test("rests when badly hurt, keeps resting, then hands back control", () => {
    state.vitals = { hp: 5, maxHp: 20, inCombat: false };
    assert.equal(reflex(), "rest");
    assert.equal(state.resting, true);
    state.vitals.hp = 10; // below restUntil (0.85 * 20 = 17)
    assert.equal(reflex(), "WAIT");
    state.vitals.hp = 18;
    assert.equal(reflex(), null);
    assert.equal(state.resting, false);
  });
});

describe("bug reporting (QA side-channel)", () => {
  beforeEach(resetState);

  test("reportBug de-dupes identical findings within a run", () => {
    state.room = { id: "r1", name: "Pit" };
    reportBug("noticed", "the same thing");
    reportBug("noticed", "the same thing");
    assert.equal(reportedBugs.size, 1);
  });

  test("an enumerated non-generic verb arms the refusal watch", () => {
    state.room = { id: "r1" };
    state.actions = [{ verb: "free", label: "free the captive" }];
    recordPendingAction("free");
    assert.equal(state.pendingAction.verb, "free");
  });

  test("generic verbs and un-enumerated verbs never arm the watch", () => {
    state.actions = [{ verb: "free", label: "free the captive" }];
    recordPendingAction("north");
    assert.equal(state.pendingAction, null);
    recordPendingAction("juggle");
    assert.equal(state.pendingAction, null);
  });

  test("bare sell does not arm the refusal watch", () => {
    state.actions = [{ verb: "sell", label: "sell salvage" }];
    recordPendingAction("sell");
    assert.equal(state.pendingAction, null);
  });

  test("a direct refusal of an offered verb is a reported affordance bug", () => {
    state.room = { id: "r1", name: "Pit" };
    state.pendingAction = { verb: "free", roomId: "r1", sentAt: Date.now() };
    checkActionRejection("You can't do that here.");
    assert.equal([...reportedBugs].some((sig) => sig.startsWith("action-rejected|")), true);
    assert.equal(state.pendingAction, null);
  });

  test("ambient broadcasts and long narrative prose are not refusals", () => {
    state.pendingAction = { verb: "free", roomId: "r1", sentAt: Date.now() };
    checkActionRejection(">> the wind says you can't win <<");
    checkActionRejection("If you don't think about why the grid hums at night, " +
      "the hum starts thinking about you instead, or so the drifters claim.");
    assert.equal(reportedBugs.size, 0);
    assert.notEqual(state.pendingAction, null);
  });

  test("missing-arg prompts clear the watch without filing action-rejected", () => {
    state.room = { id: "market", name: "Market" };
    state.pendingAction = { verb: "sell", roomId: "market", sentAt: Date.now() };
    checkActionRejection("Sell what?");
    assert.equal(reportedBugs.size, 0);
    assert.equal(state.pendingAction, null);
  });

  test("the refusal watch expires after a few seconds", () => {
    state.pendingAction = { verb: "free", roomId: "r1", sentAt: Date.now() - 5000 };
    checkActionRejection("You can't do that here.");
    assert.equal(reportedBugs.size, 0);
    assert.equal(state.pendingAction, null);
  });
});

describe("brains", () => {
  beforeEach(resetState);

  test("ollama brain returns a sanitized command", async () => {
    const cmd = await withFetch(
      async (url, init) => {
        assert.match(String(url), /chat\/completions$/);
        const body = JSON.parse(init.body);
        assert.equal(body.messages.length, 2);
        return okJson({ choices: [{ message: { content: "  `north`" } }] });
      },
      () => think(),
    );
    assert.equal(cmd, "north");
  });

  test("reasoning models surface deliberation without polluting the command", async () => {
    const cmd = await withFetch(
      async () => okJson({ choices: [{ message: { content: "free", reasoning: "freeing is virtuous..." } }] }),
      () => think(),
    );
    assert.equal(cmd, "free");
  });

  test("reasoning-only models salvage a command from message.reasoning", async () => {
    const cmd = await withFetch(
      async () => okJson({
        choices: [{
          message: {
            content: null,
            reasoning: 'The user said "say north". I will type `north` to move.',
          },
        }],
      }),
      () => think(),
    );
    assert.equal(cmd, "north");
  });

  test("extractCommandFromReasoning prefers the last backtick-wrapped command", () => {
    assert.equal(
      extractCommandFromReasoning("Maybe `look` first, then `south`."),
      "south",
    );
  });

  test("extractCommandFromReasoning picks a labeled choice at the end", () => {
    assert.equal(
      extractCommandFromReasoning("Long analysis...\nChoice: Human"),
      "Human",
    );
  });

  test("extractCommandFromReasoning ignores prose lines", () => {
    assert.equal(
      extractCommandFromReasoning("I should probably go south because it is safer."),
      "",
    );
  });

  test("extractCommandFromReasoning rejects markdown fragments", () => {
    assert.equal(extractCommandFromReasoning("**Pick a Race**:"), "");
  });

  test("extractCommandFromReasoning finds a race pick in deliberation", () => {
    assert.equal(
      extractCommandFromReasoning("Long analysis... I will choose Human for this run."),
      "Human",
    );
  });

  test("a 'bug:' reply files a finding and spends the turn on look", async () => {
    const cmd = await withFetch(
      async () => okJson({ choices: [{ message: { content: "bug: guard is dead but free still fails" } }] }),
      () => think(),
    );
    assert.equal(cmd, "look");
    assert.equal([...reportedBugs].some((sig) => sig.startsWith("noticed|")), true);
  });

  test("a provider error degrades to a canned idle move (single-provider chain)", async () => {
    const cmd = await withFetch(
      async () => ({ ok: false, status: 500, text: async () => "boom" }),
      () => think(),
    );
    assert.equal(cmd, "look");
  });

  test("matchRace finds a race inside a sentence, case-insensitive", () => {
    assert.equal(bot.matchRace("I choose ELF, the hunted one."), "Elf");
    assert.equal(bot.matchRace("dustkin"), "Dustkin");
    assert.equal(bot.matchRace("2"), null);
    assert.equal(bot.matchRace("a shelf full of books"), null); // word boundary, no substring hit
  });

  test("menuRaces parses numbered and bulleted menu lines", () => {
    const prose = "Choose your people:\n  1. Human -- the accepted\n  2) Vatborn -- grown\n  - Rustwight -- port-only\nType a number or a name.";
    assert.deepEqual(bot.menuRaces(prose), ["Human", "Vatborn", "Rustwight"]);
  });

  test("matchRace honors the offered-options list over the static universe", () => {
    assert.equal(bot.matchRace("rustwight please", ["Rustwight"]), "Rustwight");
    assert.equal(bot.matchRace("elf", ["Rustwight"]), null); // this world does not offer it
    assert.equal(bot.RACES.includes("Human"), true);
  });

  test("the compat payload carries the default temperature", async () => {
    const provider = buildProvider("gateway");
    await withFetch(
      async (url, init) => {
        assert.equal(JSON.parse(init.body).temperature, 0.8);
        return okJson({ choices: [{ message: { content: "look" } }] });
      },
      () => provider.chat("prompt"),
    );
  });

  test("BOT_TEMPERATURE=none omits the temperature field (Claude 5 rejects it)", async () => {
    const prev = CFG.temperature;
    CFG.temperature = "none";
    try {
      const provider = buildProvider("gateway");
      await withFetch(
        async (url, init) => {
          assert.equal("temperature" in JSON.parse(init.body), false);
          return okJson({ choices: [{ message: { content: "look" } }] });
        },
        () => provider.chat("prompt"),
      );
    } finally {
      CFG.temperature = prev;
    }
  });

  test("the gateway provider authenticates with the gateway token only", async () => {
    const provider = buildProvider("gateway");
    const raw = await withFetch(
      async (url, init) => {
        assert.match(String(url), /\/compat\/chat\/completions$/);
        assert.match(init.headers["cf-aig-authorization"], /^Bearer /);
        assert.equal("x-api-key" in init.headers, false);
        return okJson({ choices: [{ message: { content: "look" } }] });
      },
      () => provider.chat("prompt"),
    );
    assert.equal(sanitizeCommand(raw), "look");
  });

  test("the anthropic provider speaks the Messages API and extracts the text block", async () => {
    const provider = buildProvider("anthropic");
    const raw = await withFetch(
      async (url, init) => {
        assert.match(String(url), /\/messages$/);
        assert.equal(init.headers["anthropic-version"], "2023-06-01");
        return okJson({ content: [{ type: "tool_use" }, { type: "text", text: "rest" }] });
      },
      () => provider.chat("prompt"),
    );
    assert.equal(sanitizeCommand(raw), "rest");
  });

  test("anthropic HTTP errors throw with the response text", async () => {
    await assert.rejects(
      withFetch(
        async () => ({ ok: false, status: 401, text: async () => "bad key" }),
        () => thinkAnthropic("prompt"),
      ),
      /anthropic 401: bad key/,
    );
  });
});

describe("decision loop", () => {
  beforeEach(resetState);

  test("a healthy bot asks the model and records the command", async () => {
    state.vitals = { hp: 20, maxHp: 20, inCombat: false };
    state.room = { id: "r1", name: "Pit", exits: ["north"] };
    await withFetch(
      async () => okJson({ choices: [{ message: { content: "north" } }] }),
      () => decideAndAct(),
    );
    assert.deepEqual(state.recentCommands, ["north"]);
  });

  test("a brain error falls back to a harmless look", async () => {
    state.vitals = { hp: 20, maxHp: 20, inCombat: false };
    state.room = { id: "r1", name: "Pit", exits: ["north"] };
    await withFetch(
      async () => { throw new Error("network down"); },
      () => decideAndAct(),
    );
    assert.deepEqual(state.recentCommands, ["look"]);
  });

  test("lingering too long in one room forces an escape move without the model", async () => {
    state.vitals = { hp: 20, maxHp: 20, inCombat: false };
    state.room = { id: "r1", name: "Pit", exits: ["east"] };
    state.lastDecisionRoom = "r1";
    state.roomStreak = CFG.roomStreakLimit - 1;
    await withFetch(
      async () => { throw new Error("model must not be consulted"); },
      () => decideAndAct(),
    );
    assert.deepEqual(state.recentCommands, ["east"]);
    assert.equal(state.roomStreak, 0);
  });

  test("a repeating command loop is broken with an escape move", async () => {
    state.vitals = { hp: 20, maxHp: 20, inCombat: false };
    state.room = { id: "r1", name: "Pit", exits: ["west"] };
    state.recentCommands = ["talk", "talk", "talk"];
    await withFetch(
      async () => { throw new Error("model must not be consulted"); },
      () => decideAndAct(),
    );
    assert.equal(state.recentCommands.at(-1), "west");
  });

  test("reflexes pre-empt the model entirely", async () => {
    state.vitals = { hp: 2, maxHp: 20, inCombat: false };
    await withFetch(
      async () => { throw new Error("model must not be consulted"); },
      () => decideAndAct(),
    );
    // rest is a reflex, deliberately not counted toward loop detection
    assert.deepEqual(state.recentCommands, []);
    assert.equal(state.resting, true);
  });

  test("a race named by the model at the menu is honored as the choice (#39)", async () => {
    bot.resetCharCreate();
    state.prose = [
      "Before the Grid will hold your name, choose what you are:",
      "  1) Human -- the Registered",
      "  2) Elf -- the Hunted",
      "Answer with a number or a name.",
    ];
    await withFetch(
      async () => okJson({ choices: [{ message: { content: "I will be an elf." } }] }),
      () => decideAndAct(),
    );
    assert.deepEqual(state.recentCommands, ["Elf"]);
  });

  test("generic replies at the menu retry; three misses roll ONLY the offered races (#39)", async () => {
    bot.resetCharCreate();
    state.prose = [
      "Before the Grid will hold your name, choose what you are:",
      "  1) Human -- the Registered",
      "Answer with a number or a name.",
    ];
    const mock = async () => okJson({ choices: [{ message: { content: "look" } }] });
    await withFetch(mock, () => decideAndAct());
    await withFetch(mock, () => decideAndAct());
    assert.equal(state.recentCommands.length, 0); // two misses: turn kept, nothing sent
    await withFetch(mock, () => decideAndAct());
    // third miss: random fallback, but only from what this world offers
    assert.deepEqual(state.recentCommands, ["Human"]);
  });

  test("a char.create event triggers the creation flow with NO recognizable prompt wording (#41)", async () => {
    bot.resetCharCreate();
    // A free-voice port: nothing matches the legacy prompt regexes, only the event.
    state.prose = ["The rust remembers every shape. Which one walks in yours?"];
    ingest('@event char.create {"races":["Human","Rustwight"],"prompt":"race"}');
    await withFetch(
      async () => okJson({ choices: [{ message: { content: "rustwight, always" } }] }),
      () => decideAndAct(),
    );
    assert.deepEqual(state.recentCommands, ["Rustwight"]);
    assert.equal(state.charCreate, null); // consumed with the choice
  });

  test("event-named races bound the choice; an unoffered race is a miss (#41)", async () => {
    bot.resetCharCreate();
    state.prose = ["Which one walks in yours?"];
    ingest('@event char.create {"races":["Human"],"prompt":"race"}');
    await withFetch(
      async () => okJson({ choices: [{ message: { content: "Elf" } }] }),
      () => decideAndAct(),
    );
    assert.equal(state.recentCommands.length, 0); // miss: Elf is not offered here
    assert.notEqual(state.charCreate, null); // the pending menu survives the miss
  });

  test("the TS Type-a-number prompt with no parsable menu falls back to the static universe (#39)", async () => {
    bot.resetCharCreate();
    state.prose = ["Type a number or a name."];
    const mock = async () => okJson({ choices: [{ message: { content: "worlds" } }] });
    await withFetch(mock, () => decideAndAct());
    await withFetch(mock, () => decideAndAct());
    await withFetch(mock, () => decideAndAct());
    const races = new Set(["Human", "Elf", "Revenant", "Ghoul", "Chromed", "Dustkin", "Vatborn"]);
    assert.equal(state.recentCommands.length, 1);
    assert.ok(races.has(state.recentCommands[0]), `got ${state.recentCommands[0]}`);
  });
});

describe("scheduled federation travel", () => {
  beforeEach(() => {
    resetState();
    resetTravelSchedule();
    CFG.travelIntervalMs = 60_000;
    CFG.travelTargets = ["Dustfall", "The Hollow Grid"];
  });

  test("maybeScheduledTravel returns null when disabled", () => {
    CFG.travelIntervalMs = 0;
    assert.equal(maybeScheduledTravel(), null);
  });

  test("maybeScheduledTravel skips mid-combat", () => {
    state.vitals = { hp: 10, maxHp: 20, inCombat: true };
    assert.equal(maybeScheduledTravel(), null);
  });

  test("maybeScheduledTravel cycles targets after the interval", () => {
    backdateScheduledTravel(61_000);
    assert.equal(maybeScheduledTravel(), "travel Dustfall");
    backdateScheduledTravel(61_000);
    assert.equal(maybeScheduledTravel(), "travel The Hollow Grid");
  });

  test("decideAndAct issues scheduled travel before the model", async () => {
    state.vitals = { hp: 20, maxHp: 20, inCombat: false };
    backdateScheduledTravel(61_000);
    await withFetch(
      async () => { throw new Error("model must not be consulted"); },
      () => decideAndAct(),
    );
    assert.equal(state.recentCommands.at(-1), "travel Dustfall");
  });
});

describe("provider chain + circuit breaker", () => {
  beforeEach(resetState);

  test("buildProviderChain uses BOT_PROVIDERS names when given", () => {
    const chain = buildProviderChain(["ollama", "workersai"], "gateway");
    assert.deepEqual(chain.map((p) => p.name), ["ollama", "workersai"]);
  });

  test("buildProviderChain falls back to the single brain when no names", () => {
    const chain = buildProviderChain([], "gateway");
    assert.deepEqual(chain.map((p) => p.name), ["gateway"]);
  });

  test("buildProviderChain skips unknown provider names", () => {
    const chain = buildProviderChain(["ollama", "psychic", "workersai"], "ollama");
    assert.deepEqual(chain.map((p) => p.name), ["ollama", "workersai"]);
  });

  test("PROVIDERS defaults to the single ollama brain under the test env", () => {
    assert.deepEqual(PROVIDERS.map((p) => p.name), ["ollama"]);
  });

  test("workersAiEndpoint builds from the account id or an explicit base", () => {
    const savedBase = CFG.workersAiBase;
    const savedAcct = CFG.cfAccountId;
    try {
      CFG.workersAiBase = "";
      CFG.cfAccountId = "acct123";
      assert.equal(
        workersAiEndpoint(),
        "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1",
      );
      CFG.workersAiBase = "https://wai.example/ai/v1/";
      assert.equal(workersAiEndpoint(), "https://wai.example/ai/v1");
    } finally {
      CFG.workersAiBase = savedBase;
      CFG.cfAccountId = savedAcct;
    }
  });

  test("the workersai provider posts to the OpenAI-compat endpoint with a bearer token", async () => {
    const savedBase = CFG.workersAiBase;
    const savedTok = CFG.workersAiToken;
    try {
      CFG.workersAiBase = "https://wai.example/ai/v1";
      CFG.workersAiToken = "wai-secret";
      const provider = buildProvider("workersai");
      const raw = await withFetch(
        async (url, init) => {
          assert.equal(String(url), "https://wai.example/ai/v1/chat/completions");
          assert.equal(init.headers.Authorization, "Bearer wai-secret");
          return okJson({ choices: [{ message: { content: "south" } }] });
        },
        () => provider.chat("prompt"),
      );
      assert.equal(sanitizeCommand(raw), "south");
    } finally {
      CFG.workersAiBase = savedBase;
      CFG.workersAiToken = savedTok;
    }
  });

  test("validateConfig flags a workersai chain missing its token and account id", () => {
    const errs = validateConfig({ providerNames: ["ollama", "workersai"], workersAiToken: "", cfAccountId: "", workersAiBase: "" });
    assert.equal(errs.length, 2);
    assert.match(errs.join(" "), /WORKERS_AI_TOKEN/);
    assert.deepEqual(validateConfig({ providerNames: ["ollama", "workersai"], workersAiToken: "t", cfAccountId: "acct" }), []);
  });

  test("probeHealth returns true on a 2xx and false on a network error", async () => {
    const ok = await withFetch(async () => ({ ok: true }), () => probeHealth("http://x/models", {}));
    assert.equal(ok, true);
    const bad = await withFetch(async () => { throw new Error("refused"); }, () => probeHealth("http://x/models", {}));
    assert.equal(bad, false);
  });

  // Fake providers drive the chain deterministically, no network.
  const okProvider = (name, reply) => ({ name, chat: async () => reply, health: null });
  const failProvider = (name) => ({ name, chat: async () => { throw new Error(name + " down"); }, health: null });

  test("chainChat returns the primary reply when it is healthy", async () => {
    const chain = [okProvider("ollama", "north"), okProvider("workersai", "south")];
    assert.equal(await chainChat("p", chain, 1000), "north");
  });

  test("chainChat flips to the fallback when the primary throws", async () => {
    const chain = [failProvider("ollama"), okProvider("workersai", "south")];
    assert.equal(await chainChat("p", chain, 1000), "south");
    assert.equal(getCircuit("ollama").fails, 1);
  });

  test("an open primary circuit is skipped during its cooldown", async () => {
    recordFailure("ollama", 1000);
    recordFailure("ollama", 1000); // cbFails=2 -> openUntil = 1000 + cooldown
    let called = false;
    const primary = { name: "ollama", chat: async () => { called = true; return "north"; }, health: null };
    const chain = [primary, okProvider("workersai", "south")];
    assert.equal(await chainChat("p", chain, 1005), "south");
    assert.equal(called, false);
  });

  test("a half-open primary re-probed healthy reclaims traffic (auto-return)", async () => {
    recordFailure("ollama", 0);
    recordFailure("ollama", 0); // openUntil = CFG.cbCooldownMs
    let healthChecked = false;
    const primary = {
      name: "ollama",
      chat: async () => "north",
      health: async () => { healthChecked = true; return true; },
    };
    const chain = [primary, okProvider("workersai", "south")];
    const past = CFG.cbCooldownMs + 1;
    assert.equal(await chainChat("p", chain, past), "north");
    assert.equal(healthChecked, true);
    assert.equal(getCircuit("ollama").openUntil, 0);
  });

  test("a half-open primary still unhealthy stays on the fallback", async () => {
    recordFailure("ollama", 0);
    recordFailure("ollama", 0);
    const primary = {
      name: "ollama",
      chat: async () => { throw new Error("must not be called"); },
      health: async () => false,
    };
    const chain = [primary, okProvider("workersai", "south")];
    const past = CFG.cbCooldownMs + 1;
    assert.equal(await chainChat("p", chain, past), "south");
    assert.ok(getCircuit("ollama").openUntil > past);
  });

  test("chainChat throws AllProvidersDownError when every provider fails", async () => {
    const chain = [failProvider("ollama"), failProvider("workersai")];
    await assert.rejects(() => chainChat("p", chain, 1000), AllProvidersDownError);
  });

  test("think idles on a canned move when the whole chain is down", async () => {
    const cmd = await withFetch(
      async () => { throw new Error("no route to host"); },
      () => think(),
    );
    assert.equal(cmd, "look");
  });

  test("idleMove is a quiet, non-LLM keep-alive", () => {
    assert.equal(idleMove(), "look");
  });

  test("recordSuccess closes an open circuit", () => {
    recordFailure("ollama", 0);
    recordFailure("ollama", 0);
    assert.ok(getCircuit("ollama").openUntil > 0);
    recordSuccess("ollama");
    assert.equal(getCircuit("ollama").openUntil, 0);
    assert.equal(getCircuit("ollama").fails, 0);
  });
});
