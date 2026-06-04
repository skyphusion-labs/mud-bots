#!/usr/bin/env python3
"""
Register a FRESH Packet Wastes account (types "new" at the login prompt and walks
the creation dialog), to test whether a brand-new v1.5 character gets a working
tutorial — unlike the stale pre-refactor `ai_borg`.

The creation dialog wasn't captured before, so this responder is adaptive: it
reacts to prompt keywords and logs the full (de-ANSI'd) transcript so we can see
exactly what the server asks. On success it writes creds to --out and exits.

    python3 register.py --out new_identity.json
"""

import argparse
import asyncio
import json
import logging
import random
import string
from pathlib import Path

import websockets

from mapper import parse_gmcp, strip_ansi

LOG = logging.getLogger("register")

RACES = ["human", "mutant", "ghoul", "wasteling", "salt born", "android"]
CLASSES = ["scavenger", "nomad", "wastelander", "drifter", "raider", "fixer"]


class Registrar:
    def __init__(self, url, out):
        self.url, self.out = url, out
        self.ws = None
        self.in_game = False
        self.area = None
        self.block: list[str] = []
        # generated identity
        self.username = "ai_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
        self.password = "Aa1!" + "".join(random.choices(string.ascii_letters + string.digits, k=12))
        self.charname = random.choice(
            ["Rax", "Vex", "Kael", "Dust", "Mira", "Bolt", "Cinder", "Wraith"]
        ) + str(random.randint(10, 99))
        self.race = random.choice(RACES)
        self.cls = random.choice(CLASSES)
        # one-shot guards
        self.sent = set()
        self._dedupe = {}   # per-prompt-signature -> last response, blocks loops

    async def connect(self):
        self.ws = await websockets.connect(self.url, ping_interval=30, ping_timeout=10)

    async def send(self, cmd, tag):
        LOG.info(f">>> [{tag}] {cmd!r}")
        await self.ws.send(cmd)

    async def recv_loop(self):
        try:
            async for msg in self.ws:
                if isinstance(msg, bytes):
                    msg = msg.decode("utf-8", errors="replace")
                for pkg, data in parse_gmcp(msg):
                    if pkg in ("Char", "Char.Info", "Game"):
                        self.in_game = True
                    if pkg == "Room.Info" and isinstance(data, dict):
                        self.in_game = True
                        self.area = data.get("area", self.area)
                clean = strip_ansi(msg)
                for line in clean.splitlines():
                    s = line.strip()
                    if s and not s.startswith(("!!GMCP(", "!!MUSIC", "!!SOUND", "TEXTMASK")):
                        self.block.append(s)
                        LOG.debug(f"<<< {s}")
        except websockets.ConnectionClosed:
            LOG.warning("connection closed")

    def recent(self, n=5):
        return "\n".join(self.block[-n:]).lower()

    async def fire_once(self, key, cmd, tag, settle=0.8):
        if key in self.sent:
            return
        self.sent.add(key)
        await self.send(cmd, tag)
        await asyncio.sleep(settle)

    async def drive(self):
        deadline = asyncio.get_event_loop().time() + 90
        while asyncio.get_event_loop().time() < deadline and not self.in_game:
            await asyncio.sleep(0.5)
            r = self.recent()

            # Step 0: choose to create an account.
            if "new" not in self.sent and ('(or "new")' in r or "or 'new'" in r or 'username' in r):
                await self.fire_once("new", "new", "create-account")
                continue

            # Account already exists? (shouldn't, fresh name) — bail visibly.
            if "already" in r and "taken" in r and "name2" not in self.sent:
                self.username = "ai_" + "".join(random.choices(string.ascii_lowercase, k=7))
                await self.send(self.username, "retry-username")
                self.sent.add("name2")
                await asyncio.sleep(0.8)
                continue

            # Screen-reader prompt: answer NO so the normal ANSI UI is kept.
            if "screen reader" in r and "screenreader" not in self.sent:
                await self.fire_once("screenreader", "n", "screen-reader-no")
                continue

            # Press-enter intro screens -> blank line. Yes/no -> default yes.
            # Both are deduped per-prompt so an unchanged prompt can't loop.
            sig = r[-80:]
            if "press" in r and "enter" in r and self._dedupe.get(sig) != "":
                self._dedupe[sig] = ""
                await self.send("", "press-enter"); await asyncio.sleep(0.6); continue
            if ("[y/n]" in r or "(y/n)" in r or "are you sure" in r) and self._dedupe.get(sig) != "y":
                self._dedupe[sig] = "y"
                await self.send("y", "yes-no"); await asyncio.sleep(0.6); continue

            # Email (send a clearly-bot address if required).
            if "email" in r and "email" not in self.sent:
                await self.fire_once("email", f"{self.username}@example.invalid", "email")
                continue

            # Password confirm vs. new password.
            if ("confirm" in r or "again" in r or "re-enter" in r or "retype" in r
                    or "verify" in r or "repeat" in r) and "pass-confirm" not in self.sent:
                await self.fire_once("pass-confirm", self.password, "password-confirm")
                continue
            if ("new password" in r or "create a" in r or "choose a password" in r or "password" in r) \
                    and "pass" not in self.sent:
                await self.fire_once("pass", self.password, "new-password")
                continue

            # Desired username (after "new").
            if "new" in self.sent and "name" not in self.sent and \
                    ("username" in r or "desired" in r or "account name" in r or "pick a name" in r):
                await self.fire_once("name", self.username, "desired-username")
                continue

            # Character name.
            if ("character name" in r or "name for your" in r or "name your character" in r or
                    "what is your name" in r or "what shall" in r) and "charname" not in self.sent:
                await self.fire_once("charname", self.charname, "character-name")
                continue

            # Race / class menus.
            if ("race" in r) and "race" not in self.sent:
                await self.fire_once("race", self.race, "race")
                continue
            if ("class" in r) and "class" not in self.sent:
                await self.fire_once("class", self.cls, "class")
                continue
            if ("sex" in r or "gender" in r) and "sex" not in self.sent:
                await self.fire_once("sex", "other", "sex")
                continue

        return self.in_game

    async def run(self):
        await self.connect()
        receiver = asyncio.create_task(self.recv_loop())
        try:
            ok = await self.drive()
            if ok:
                ident = {
                    "username": self.username, "password": self.password,
                    "character_name": self.charname, "race": self.race, "class": self.cls,
                    "backstory": "Fresh v1.5 test character.",
                }
                Path(self.out).write_text(json.dumps(ident, indent=2))
                LOG.info(f"SUCCESS: registered {self.username!r} (area={self.area}); creds -> {self.out}")
            else:
                LOG.error("did not reach in-game state; see transcript above to extend the responder")
                LOG.error(f"last lines:\n" + "\n".join(self.block[-12:]))
            return ok
        finally:
            receiver.cancel()
            if self.ws:
                await self.ws.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="new_identity.json")
    ap.add_argument("--url", default="wss://74-208-68-248.sslip.io/ws")
    ap.add_argument("--log-level", default="DEBUG")
    args = ap.parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper()),
                        format="[%(asctime)s] %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("websockets").setLevel(logging.WARNING)
    ok = asyncio.run(Registrar(args.url, args.out).run())
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
