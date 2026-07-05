#!/usr/bin/env python3
"""
Packet Wastes onboarder - register + create + tutorial, hands-off.

Takes a connection from a blank slate to a tutorial-completed, ready-to-play
character in one run, by answering the deterministic prompts the server sends:

  1. Registration (the 'new' branch):
       username (or "new")        -> new
       Choose your username       -> <username>
       Choose your password       -> <password>
       Repeat your password       -> <password>
       Email Address (optional)   -> (blank)
       Are you using a screen reader? -> n
       Would you like to create a new user/login named X? -> y

  2. Character creation:
       Which race will you be?    -> <race number>
       What is your gender?       -> <gender number>
       What will your character be known as? -> <name>
       Choose the name X?         -> yes
       [keep]/[reroll]/[back]     -> keep
       Pick stat set 1, 2, or 3   -> <stat set>
       Which class will you take? -> <class number>
       Create this character?     -> yes

  3. Tutorial: follow the instructors' spoken instructions (GMCP Comm.Channel),
     which are imperative "type X" / "head X" lines, until we leave the
     Tutorial area. Reuses tutorial.extract_command.

On success it writes the credentials to a JSON file (default: the username) so
the mapper/bot can log in. Re-run with different --username to mint more.

Usage:
    python3 onboard.py --username ai_map1 --password 'S0me-Pass!'
    python3 onboard.py --username ai_map1 --password ... --race 3 --class 14 --use-llm
"""

import argparse
import asyncio
import json
import logging
import os
import random
import re
import string
from pathlib import Path
from typing import Optional

import websockets

from mapper import parse_gmcp, strip_ansi
from mud_security import log_connect, log_outbound, write_creds_json
from tutorial import extract_command, _PRAISE  # reuse the tested tutorial parsing

LOG = logging.getLogger("onboard")

# Reasonable, low-drama defaults. All overridable on the command line.
#   race 3  = Sunblasted  ("Hardened baseline survivor of the Mojave")
#   class 14 = Wastes Runner ("Scout, smuggler and long-haul survivor") - fits a mapper
DEFAULT_RACE = 3
DEFAULT_GENDER = 1
DEFAULT_STAT_SET = 1
DEFAULT_CLASS = 14


def random_name() -> str:
    base = random.choice(["Drifter", "Wanderer", "Nomad", "Strider", "Husk",
                           "Cinder", "Vagrant", "Rover", "Scrapper", "Ghost"])
    return f"{base}{random.randint(100, 999)}"


class Onboarder:
    def __init__(self, cfg: dict, args):
        self.url = cfg["server_url"]
        self.username = cfg["username"]
        self.password = cfg["password"]
        self.name = cfg["name"]
        self.args = args

        self.ws = None
        self.block: list[str] = []     # recent clean prose (creation prompts live here)
        self.says: list[str] = []      # instructor instructions (tutorial phase)
        self.area: Optional[str] = None
        self.was_in_tutorial = False
        self.wrongdir = False
        self.done = False

        # Ordered creation prompt handlers: (key, substring, response).
        # Keyed so a redisplayed prompt isn't answered twice.
        self.prompts = [
            ("reg_new",      'username (or "new")',          "new"),
            ("reg_user",     "choose your username",          self.username),
            ("reg_pass",     "choose your password",          self.password),
            ("reg_pass2",    "your password",                 self.password),
            ("reg_email",    "email address",                 ""),
            ("reg_reader",   "screen reader",                 "n"),
            ("reg_confirm",  "would you like to create a new user", "y"),
            ("cc_start",     "type start to begin",           "start"),
            ("cc_race",      "which race will you be",        str(args.race)),
            ("cc_gender",    "what is your gender",            str(args.gender)),
            ("cc_name",      "known as (name)",               self.name),
            ("cc_namecfm",   "choose the name",               "yes"),
            ("cc_desc",      "keep/reroll/back",              "keep"),
            ("cc_stats",     "pick stat set",                 str(args.stat_set)),
            ("cc_class",     "which class",                   str(args.char_class)),
            ("cc_create",    "create this character",         "yes"),
        ]
        self.answered: set = set()

        self.llm = None
        if args.use_llm:
            from openai import OpenAI
            base = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
            self.llm = OpenAI(api_key=os.getenv("OLLAMA_API_KEY", "ollama"), base_url=base)
            self.model = os.getenv("MUD_MODEL", "qwen3:30b-a3b-instruct-2507")

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
                if "!!GMCP(Room.WrongDir" in message:
                    self.wrongdir = True
                clean = strip_ansi(message)
                for line in clean.splitlines():
                    s = line.strip()
                    if s and not s.startswith(("!!GMCP(", "!!MUSIC", "TEXTMASK", "!!SOUND")):
                        self.block.append(s)
                        # Surface prompt-like lines so we can see exact wording.
                        if s.endswith((":", "?")) or "[" in s or "/" in s:
                            LOG.info(f"<<< {s}")
                self.block = self.block[-40:]
        except websockets.ConnectionClosed:
            LOG.warning("Connection closed")
        except Exception as e:
            LOG.error(f"Receive error: {e}")

    def _handle_gmcp(self, pkg: str, data) -> None:
        if pkg == "Room.Info" and isinstance(data, dict):
            self.area = data.get("area", self.area)
            if self.area and self.area.lower() == "tutorial":
                self.was_in_tutorial = True
        elif pkg == "Comm.Channel" and isinstance(data, dict):
            if data.get("source") == "mob" and data.get("text"):
                self.says.append(data["text"])

    # ---- creation phase ---------------------------------------------------

    def _next_creation_response(self) -> Optional[tuple[str, str]]:
        """Scan recent prose (newest first) for an unanswered creation prompt."""
        recent = [ln.lower() for ln in self.block[-12:]]
        for line in reversed(recent):
            for key, sub, resp in self.prompts:
                if key in self.answered:
                    continue
                if sub in line:
                    return key, resp
        return None

    # ---- tutorial phase ---------------------------------------------------

    def _llm_command(self, text: str) -> Optional[str]:
        if not self.llm:
            return None
        try:
            resp = self.llm.chat.completions.create(
                model=self.model, max_tokens=20,
                messages=[{"role": "user", "content": (
                    "You are completing a MUD tutorial. The instructor said:\n"
                    f'"{text}"\nReply with ONLY the MUD command to type next.'
                )}],
            )
            cmd = resp.choices[0].message.content.strip().splitlines()[0].strip("\"'`")
            return cmd if cmd and len(cmd.split()) <= 4 else None
        except Exception as e:
            LOG.debug(f"LLM fallback failed: {e}")
            return None

    def _completed(self) -> bool:
        return self.was_in_tutorial and bool(self.area) and self.area.lower() != "tutorial"

    # ---- main loop --------------------------------------------------------

    async def run(self) -> bool:
        if not await self.connect():
            return False
        receiver = asyncio.create_task(self.receive_loop())
        try:
            phase = "create"
            ptr = 0
            last_acted = None
            unknown = 0
            idle = 0
            steps = 0

            while not self.done and steps < self.args.max_steps:
                await asyncio.sleep(0.5)

                if self._completed():
                    LOG.info(f"Tutorial complete. Now in area: {self.area!r}")
                    self.done = True
                    break

                recent = "\n".join(self.block[-6:]).lower()
                if "kick them" in recent and "kick" not in self.answered:
                    await self.send("y")
                    self.answered.add("kick")
                    continue

                # CREATION: answer registration / character-creation prompts.
                if phase == "create":
                    # New v1.5 step: allocate +1 stat point(s), one at a time. This
                    # prompt repeats per point, so it can't use the one-shot table.
                    # Clear block after answering so the same display can't double-fire;
                    # we only re-answer when the server re-emits the prompt.
                    tail = " ".join(self.block[-4:]).lower()
                    if "add +1 to which stat" in tail:
                        await self.send(self.args.boost_stat)
                        self.block = []
                        steps += 1
                        await asyncio.sleep(self.args.pace)
                        continue
                    nxt = self._next_creation_response()
                    if nxt:
                        key, resp = nxt
                        await self.send(resp)
                        self.answered.add(key)
                        steps += 1
                        # Once we've confirmed creation, the tutorial begins.
                        if key == "cc_create":
                            phase = "tutorial"
                        await asyncio.sleep(self.args.pace)
                        continue
                    # If instructors start talking, we've reached the tutorial.
                    if self.says or (self.area and self.area.lower() == "tutorial"):
                        phase = "tutorial"
                    else:
                        continue

                # TUTORIAL: follow instructor instructions.
                if self.wrongdir:
                    # Last move bounced (e.g. post-combat 'west'); allow a retry.
                    self.wrongdir = False
                    last_acted = None

                if ptr >= len(self.says):
                    idle += 1
                    if idle >= self.args.idle_limit:
                        await self.send("look")
                        idle = 0
                    continue
                idle = 0

                text = self.says[ptr]
                ptr += 1
                if _PRAISE.search(text):
                    last_acted = None
                    continue
                if text == last_acted:
                    continue

                cmd = extract_command(text)
                if cmd is None and self.llm:
                    cmd = self._llm_command(text)
                if cmd:
                    LOG.info(f"Instructor: {text!r} -> {cmd!r}")
                    await self.send(cmd)
                    last_acted = text
                    steps += 1
                    # Progress was made, so the run is not stuck: only count
                    # CONSECUTIVE unparseable lines. Tutorials intersperse purely
                    # informational flavor ("You can also use tell <name> ...")
                    # between real instructions, and those must flow past, not
                    # accumulate toward the stuck-abort across the whole tutorial.
                    unknown = 0
                    await asyncio.sleep(self.args.pace)
                else:
                    unknown += 1
                    LOG.warning(f"Can't parse an action from: {text!r}")
                    if unknown >= self.args.unknown_limit:
                        LOG.error("Stuck on an instruction I can't act on. "
                                  "Finish by hand or rerun with --use-llm. Stopping.")
                        return False

            return self._completed()
        finally:
            receiver.cancel()
            if self.ws:
                await self.ws.close()


def main() -> None:
    ap = argparse.ArgumentParser(description="Packet Wastes account onboarder")
    ap.add_argument("--username", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--name", default=None, help="character name (default: random)")
    ap.add_argument("--race", type=int, default=DEFAULT_RACE)
    ap.add_argument("--gender", type=int, default=DEFAULT_GENDER)
    ap.add_argument("--stat-set", type=int, default=DEFAULT_STAT_SET)
    ap.add_argument("--char-class", type=int, default=DEFAULT_CLASS)
    ap.add_argument("--boost-stat", default="con",
                    help="stat to put the v1.5 '+1' allocation point(s) into")
    ap.add_argument("--out", default=None, help="creds JSON output (default: <username>.json)")
    ap.add_argument("--use-llm", action="store_true",
                    help="hand un-parseable tutorial steps to the local model")
    ap.add_argument("--pace", type=float, default=1.0)
    ap.add_argument("--max-steps", type=int, default=80)
    ap.add_argument("--idle-limit", type=int, default=20)
    ap.add_argument("--unknown-limit", type=int, default=12)
    ap.add_argument("--server-url", default=os.getenv("MUD_SERVER_URL", "wss://74-208-68-248.sslip.io/ws"))
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="[%(asctime)s] [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    name = args.name or random_name()
    cfg = {"server_url": args.server_url, "username": args.username,
           "password": args.password, "name": name}

    runner = Onboarder(cfg, args)
    ok = asyncio.run(runner.run())

    if ok:
        out = Path(args.out or f"{args.username}.json")
        write_creds_json(out, {
            "username": args.username,
            "character_name": name,
        })
        LOG.info(
            f"Onboarded '{name}'. Credentials written to {out} "
            "(password omitted; set MUD_PASSWORD or pass --password on the CLI)."
        )
        LOG.info(f"Now run: python3 mapper.py --creds {out}")
    else:
        LOG.error("Onboarding did not complete. See logs above.")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
