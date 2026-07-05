#!/usr/bin/env python3
"""
Packet Wastes tutorial runner - onboards a character past the tutorial gate.

New characters spawn into a tutorial where movement and most commands are
DISABLED until completion. The Sight Instructor tells you exactly what to do,
and on this MUD that instruction arrives as clean structured data:

    !!GMCP(Comm.Channel {"channel":"say","sender":"Sight Instructor",
                         "source":"mob","text":"type look and hit enter ..."})

So this routine listens for the instructor's speech, extracts the command it's
telling you to type, sends it, and repeats until the character leaves the
Tutorial area. It is NOT a hardcoded step list (the full tutorial wasn't
captured); it follows whatever the instructor says.

Strategies, in order:
  1. Deterministic: pull the command out of "type X ..." or "go/move/walk <dir>".
  2. Optional --use-llm: hand anything it can't parse to the local model.
  3. Stuck: if it can't act on an instruction, it logs the instructor's exact
     words and stops, so you can see the step and finish it by hand.

Completion is detected when a Room.Info reports an area other than "Tutorial"
(primary) or the instructor announces completion (fallback).

This handles LOGIN to an existing account. It does NOT create accounts (that
dialog wasn't captured). Create the account by hand once, then run this to clear
the tutorial.

Usage:
    MUD_USERNAME=ai_borg MUD_PASSWORD=... python3 tutorial.py
    python3 tutorial.py --creds creds.json --use-llm
"""

import argparse
import asyncio
import logging
import os
import re
from pathlib import Path
from typing import Optional

import websockets

# Reuse the GMCP parser/ANSI strip from the mapper (single source of truth).
from mapper import parse_gmcp, strip_ansi
from mud_security import log_connect, log_outbound, log_username_login, write_creds_json

LOG = logging.getLogger("tutorial")

_DIRS = ("north", "south", "east", "west", "up", "down",
         "northeast", "northwest", "southeast", "southwest",
         "ne", "nw", "se", "sw")

_TYPE_CMD = re.compile(
    r"\btyp(?:e|ing)\s+(.+?)(?:\s+and\s+hit\s+enter|\s+to\b|\s+and\b|[.!,]|$)", re.I
)
_GO_DIR = re.compile(
    r"\b(?:go|move|walk|head|proceed|continue|travel|run|step)\s+"
    r"(?:to\s+the\s+|towards?\s+the\s+|through\s+the\s+|out\s+the\s+)?"
    r"(" + "|".join(_DIRS) + r")\b",
    re.I,
)

# Progression phrasing that names a direction via a "route" noun instead of an
# imperative verb, e.g. "The passage west leads to communication training."
# Deliberately STRICT: only strong route nouns (not "exit"/"door", which show up
# in look-lesson flavor like "there is an exit to the east"), and the direction
# must sit immediately next to the noun, so "exit to the east" can never match.
_DIR_NOUNS = (
    r"passage|passageway|corridor|tunnel|hallway|archway|"
    r"stairway|stairwell|stairs|ramp|path"
)
_NOUN_DIR = re.compile(
    r"\b(?:" + _DIR_NOUNS + r")\s+(" + "|".join(_DIRS) + r")\b", re.I,
)
_DIR_NOUN = re.compile(
    r"\b(" + "|".join(_DIRS) + r")\s+(?:" + _DIR_NOUNS + r"|leads|continues|opens)\b", re.I,
)
_PRAISE = re.compile(r"\b(good job|well done|correct|excellent|nicely done|perfect)\b", re.I)
_COMPLETE = re.compile(
    r"(tutorial (?:complete|is (?:now )?(?:complete|over|done))|"
    r"completed the tutorial|commands?.{0,20}enabled|graduat)", re.I,
)


def extract_command(text: str) -> Optional[str]:
    """Deterministically pull an actionable command from instructor speech."""
    m = _TYPE_CMD.search(text)
    if m:
        cmd = m.group(1).strip().strip("\"'`")
        # Guard against capturing a whole sentence if 'type' was used loosely.
        if 1 <= len(cmd.split()) <= 4:
            return cmd
    m = _GO_DIR.search(text)
    if m:
        return m.group(1).lower()
    # "Try the look command again" / "inspect ... with the look command"
    m = re.search(r"\bthe\s+(\w+)\s+command\b", text, re.I)
    if m:
        return m.group(1).lower()
    # "the most important command: help. Try it now." The instructor names the
    # command explicitly after a colon; the generic "the <word> command" pattern
    # above misses it because of the intervening adjectives, so the bot never
    # typed 'help', the nav lesson never completed, and its west gate stayed
    # locked (wedging the bot in the final tutorial room).
    m = re.search(r"\bcommand:\s*[\"'`]?(\w+)", text, re.I)
    if m:
        return m.group(1).lower()
    # Descriptive progression: "The passage west leads on", "the west passage".
    m = _NOUN_DIR.search(text)
    if m:
        return m.group(1).lower()
    m = _DIR_NOUN.search(text)
    if m:
        return m.group(1).lower()
    return None


# Commands the tutorial can plausibly ask for. Used to vet the LLM fallback so a
# working model can't derail the on-rails tutorial by emitting random movement
# for a flavor line it shouldn't have been handed in the first place.
_TUTORIAL_VERBS = {
    "look", "status", "inventory", "experience", "conditions", "score", "skills",
    "equip", "wear", "wield", "hold", "remove", "attack", "kill", "get", "take",
    "drink", "eat", "use", "say", "emote", "quest", "help",
    "north", "south", "east", "west", "up", "down",
    "northeast", "northwest", "southeast", "southwest", "ne", "nw", "se", "sw",
}


def safe_tutorial_command(cmd: Optional[str]) -> Optional[str]:
    """Accept an LLM-proposed tutorial command only if it starts with a known verb."""
    if not cmd:
        return None
    cmd = cmd.strip().strip("\"'`")
    if not cmd or len(cmd.split()) > 4:
        return None
    return cmd if cmd.split()[0].lower() in _TUTORIAL_VERBS else None


def resolve_model(client, requested: str, logger: Optional[logging.Logger] = None) -> str:
    """Resolve a requested model name against what the ollama server actually has.

    ollama tags models with a quant suffix ('qwen3:30b-a3b-instruct-2507-q4_K_M').
    Passing the friendly stem ('qwen3:30b-a3b-instruct-2507') makes ollama's
    OpenAI endpoint answer 404. We list installed models and prefix-match so the
    friendly name resolves to the real tag. If the server is unreachable we return
    the requested name unchanged and let the real call surface the error.
    """
    log = logger or LOG
    try:
        available = [m.id for m in client.models.list().data]
    except Exception as e:
        log.warning(f"Could not list models from server ({e}); using {requested!r} as-is.")
        return requested
    if not available or requested in available:
        return requested
    # Prefix match in either direction: friendly stem -> full tag, or vice versa.
    matches = [m for m in available if m.startswith(requested) or requested.startswith(m)]
    if matches:
        if len(matches) > 1:
            log.warning(f"Model {requested!r} matches multiple tags {matches}; using {matches[0]!r}.")
        else:
            log.warning(f"Model {requested!r} not found exactly; using installed tag {matches[0]!r}.")
        return matches[0]
    log.error(
        f"Model {requested!r} is not installed on the server. Available: {available}. "
        f"Pull it (`ollama pull {requested}`) or set MUD_MODEL to one of the above."
    )
    return requested


class TutorialRunner:
    def __init__(self, config: dict, args):
        self.url = config["server_url"]
        self.username = config["username"]
        self.password = config["password"]
        self.model = config.get("model", "")
        self.args = args

        self.ws = None
        self.in_game = False
        self.area: Optional[str] = None
        self.was_in_tutorial = False
        self.says: list[str] = []     # instructor instruction texts, in order
        self.block: list[str] = []    # clean prose, for login detection
        self.done = False

        self.llm = None
        if args.use_llm:
            from openai import OpenAI  # lazy: only imported if actually using it
            base = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
            self.llm = OpenAI(api_key=os.getenv("OLLAMA_API_KEY", "ollama"), base_url=base)
            self.model = config.get("model", "") or os.getenv(
                "MUD_MODEL", "qwen3:30b-a3b-instruct-2507-q4_K_M"
            )

    # ---- connection -------------------------------------------------------

    async def connect(self) -> bool:
        log_connect(LOG, self.url)
        try:
            self.ws = await websockets.connect(self.url, ping_interval=30, ping_timeout=10)
            return True
        except Exception as e:
            LOG.error(f"Connection failed: {e}")
            return False

    async def send(self, command: str) -> None:
        self.block = []
        log_outbound(LOG, command, password=self.password)
        await self.ws.send(command)

    async def receive_loop(self) -> None:
        try:
            async for message in self.ws:
                if isinstance(message, bytes):
                    message = message.decode("utf-8", errors="replace")
                for pkg, data in parse_gmcp(message):
                    self._handle_gmcp(pkg, data)
                clean = strip_ansi(message)
                for line in clean.splitlines():
                    s = line.strip()
                    if s and not s.startswith(("!!GMCP(", "!!MUSIC", "TEXTMASK")):
                        self.block.append(s)
                        if _COMPLETE.search(s):
                            self.done = True
        except websockets.ConnectionClosed:
            LOG.warning("Connection closed")
        except Exception as e:
            LOG.error(f"Receive error: {e}")

    def _handle_gmcp(self, pkg: str, data) -> None:
        if pkg in ("Char", "Char.Info", "Game"):
            self.in_game = True
        elif pkg == "Room.Info" and isinstance(data, dict):
            self.in_game = True
            self.area = data.get("area", self.area)
            if self.area and self.area.lower() == "tutorial":
                self.was_in_tutorial = True
        elif pkg == "Comm.Channel" and isinstance(data, dict):
            if data.get("source") == "mob" and data.get("text"):
                self.says.append(data["text"])

    # ---- login ------------------------------------------------------------

    async def login(self) -> bool:
        deadline = asyncio.get_event_loop().time() + 60
        sent_user = sent_pass = False
        while asyncio.get_event_loop().time() < deadline and not self.in_game:
            await asyncio.sleep(0.5)
            recent = "\n".join(self.block[-6:]).lower()
            if "kick them" in recent:
                await self.send("y")
                await asyncio.sleep(0.6)
                continue
            if not sent_user and "username" in recent:
                await self.send(self.username)
                sent_user = True
                await asyncio.sleep(0.6)
            elif sent_user and not sent_pass and "password" in recent:
                await self.send(self.password)
                sent_pass = True
                await asyncio.sleep(0.6)
        return self.in_game

    # ---- llm fallback -----------------------------------------------------

    def _llm_command(self, text: str) -> Optional[str]:
        if not self.llm:
            return None
        try:
            resp = self.llm.chat.completions.create(
                model=self.model,
                max_tokens=20,
                messages=[{
                    "role": "user",
                    "content": (
                        "You are completing a MUD tutorial. The instructor said:\n"
                        f'"{text}"\n'
                        "Reply with ONLY the single MUD command to type next, nothing else."
                    ),
                }],
            )
            cmd = resp.choices[0].message.content.strip().splitlines()[0]
            return safe_tutorial_command(cmd)
        except Exception as e:
            LOG.debug(f"LLM fallback failed: {e}")
            return None

    # ---- tutorial loop ----------------------------------------------------

    def _completed(self) -> bool:
        if self.done:
            return True
        # Primary signal: we were in the tutorial and have now left its area.
        if self.was_in_tutorial and self.area and self.area.lower() != "tutorial":
            return True
        return False

    async def run_tutorial(self) -> bool:
        # Nudge the first room/instruction.
        await self.send("look")
        await asyncio.sleep(1.5)

        pointer = 0
        last_acted = None
        unknown = 0
        last_unknown = None
        idle_ticks = 0
        steps = 0

        while not self._completed() and steps < self.args.max_steps:
            await asyncio.sleep(0.5)

            if pointer >= len(self.says):
                idle_ticks += 1
                # If nothing new for a while, re-issue 'look' to prompt the instructor.
                if idle_ticks >= self.args.idle_limit:
                    LOG.debug("Idle; nudging with 'look'.")
                    await self.send("look")
                    idle_ticks = 0
                continue

            idle_ticks = 0
            text = self.says[pointer]
            pointer += 1

            if _PRAISE.search(text):
                LOG.info(f"Instructor: progress ({text!r})")
                last_acted = None
                continue

            if text == last_acted:
                continue  # repeat nudge of an instruction we already executed

            cmd = extract_command(text)
            if cmd is None and self.llm:
                cmd = self._llm_command(text)

            if cmd:
                LOG.info(f"Instructor: {text!r} -> doing: {cmd!r}")
                await self.send(cmd)
                last_acted = text
                unknown = 0
                last_unknown = None
                steps += 1
                await asyncio.sleep(self.args.pace)
            else:
                # Only treat a *repeating* un-parseable line as "stuck": the
                # instructor is waiting on us. One-off flavor ("Welcome to the
                # training pocket.") just flows past and must not trip the cap.
                if text == last_unknown:
                    unknown += 1
                else:
                    unknown = 1
                    last_unknown = text
                LOG.warning(f"Can't parse an action from instructor step: {text!r}")
                if unknown >= self.args.unknown_limit:
                    LOG.error(
                        "Stuck on a repeating instruction I can't act on (see warnings above). "
                        "Finish this step by hand, or rerun with --use-llm. Stopping."
                    )
                    return False

        if self._completed():
            LOG.info(f"Tutorial complete. Now in area: {self.area!r}")
            return True
        LOG.warning("Hit step cap without a completion signal; stopping.")
        return False

    async def run(self) -> bool:
        if not await self.connect():
            return False
        receiver = asyncio.create_task(self.receive_loop())
        ok = False
        try:
            log_username_login(LOG, self.username)
            if not await self.login():
                LOG.error("Login failed (never reached in-game state).")
                return False
            LOG.info("In game. Running tutorial.")
            ok = await self.run_tutorial()
        finally:
            receiver.cancel()
            if self.ws:
                await self.ws.close()
        return ok


# =============================================================================
# Entry point
# =============================================================================

def load_creds(args) -> dict:
    user = os.getenv("MUD_USERNAME")
    pw = os.getenv("MUD_PASSWORD")
    if args.creds:
        data = __import__("json").loads(Path(args.creds).read_text())
        user = user or data.get("username")
        pw = pw or data.get("password")
    if not user or not pw:
        raise SystemExit(
            "No credentials. Set MUD_USERNAME and MUD_PASSWORD, or pass --creds creds.json. "
            "Create the account by hand first; this clears the tutorial, it doesn't register."
        )
    return {
        "server_url": os.getenv("MUD_SERVER_URL", "wss://74-208-68-248.sslip.io/ws"),
        "username": user,
        "password": pw,
        "model": os.getenv("MUD_MODEL", ""),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Packet Wastes tutorial runner")
    ap.add_argument("--creds", help="JSON file with username/password")
    ap.add_argument("--use-llm", action="store_true",
                    help="hand un-parseable instructions to the local model")
    ap.add_argument("--pace", type=float, default=1.0, help="seconds between actions")
    ap.add_argument("--max-steps", type=int, default=60, help="safety cap on actions")
    ap.add_argument("--idle-limit", type=int, default=20,
                    help="idle half-second ticks before re-nudging with 'look'")
    ap.add_argument("--unknown-limit", type=int, default=3,
                    help="un-parseable instructions tolerated before stopping")
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="[%(asctime)s] [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    config = load_creds(args)
    if args.use_llm:
        from openai import OpenAI

        base = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
        client = OpenAI(api_key=os.getenv("OLLAMA_API_KEY", "ollama"), base_url=base)
        requested = config.get("model") or os.getenv(
            "MUD_MODEL", "qwen3:30b-a3b-instruct-2507-q4_K_M"
        )
        config["model"] = resolve_model(client, requested, LOG)
    runner = TutorialRunner(config, args)
    ok = asyncio.run(runner.run())
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
