"""Definitively test what completes Packet Wastes' 'Learning to Survive' lesson.

The tutorial RESETS to 'Learning to Look' on every login, so progress only holds
within one continuous session. This logs in, follows the instructor through the
tutorial to the survival room, performs the taught skills (drink/eat/forage),
then tries a battery of candidate actions, re-testing the forward exit (west)
after each, to find what (if anything) releases the gate. If nothing does, the
survival gate is a server-side bug like the original combat west-gate.

    python3 forage_probe.py --creds ai_map2_identity.json
"""
import argparse
import asyncio
import json
import os
import re
import sys

import websockets

from mapper import parse_gmcp, strip_ansi
from tutorial import extract_command

URL = os.getenv("MUD_SERVER_URL", "wss://74-208-68-248.sslip.io/ws")
_HP_RE = re.compile(r"HP:(-?\d+)/(\d+)")
_SAY_RE = re.compile(r'says,\s*["“]([^"”]+)["”]')

# Tried in the survival room, re-testing the exit after each.
CANDIDATES = [
    "drink water", "eat ration", "forage", "forage", "forage",
    "search", "examine scrub", "get all", "look scrub",
    "status", "score", "skills", "survival", "inventory",
    "practice survival", "learn survival", "train",
    "ask instructor about training", "say done", "rest", "stand",
]


class Probe:
    def __init__(self, username, password):
        self.username, self.password = username, password
        self.ws = None
        self.block = []
        self.says = []
        self.in_game = False
        self.room = None
        self.area = None
        self.exits = []
        self.hp = self.maxhp = None

    async def send(self, c):
        self.block = []
        await self.ws.send(c)

    def _note(self, message):
        for pkg, data in parse_gmcp(message):
            if pkg in ("Char", "Game", "Char.Info"):
                self.in_game = True
            if pkg == "Room.Info" and isinstance(data, dict) and "num" in data:
                self.in_game = True
                self.room = data.get("name")
                self.area = data.get("area")
                self.exits = list((data.get("exits") or {}).keys())
        clean = strip_ansi(message)
        for hit in _HP_RE.finditer(clean):
            self.hp, self.maxhp = int(hit.group(1)), int(hit.group(2))
        for t in _SAY_RE.findall(clean):
            t = t.strip()
            if not self.says or self.says[-1] != t:
                self.says.append(t)
        for line in clean.splitlines():
            s = line.strip()
            if s and not s.startswith(("!!GMCP(", "!!MUSIC", "TEXTMASK")):
                self.block.append(s)

    async def receive_loop(self):
        try:
            async for m in self.ws:
                if isinstance(m, bytes):
                    m = m.decode("utf-8", "replace")
                self._note(m)
        except websockets.ConnectionClosed:
            pass

    async def login(self):
        deadline = asyncio.get_event_loop().time() + 60
        su = sp = False
        while asyncio.get_event_loop().time() < deadline and not self.in_game:
            await asyncio.sleep(0.5)
            recent = "\n".join(self.block[-6:]).lower()
            if "kick them" in recent:
                await self.send("y"); await asyncio.sleep(0.6); continue
            if not su and "username" in recent:
                await self.send(self.username); su = True; await asyncio.sleep(0.6)
            elif su and not sp and "password" in recent:
                await self.send(self.password); sp = True; await asyncio.sleep(0.6)
        return self.in_game

    async def cmd(self, c, wait=1.4):
        await self.send(c)
        await asyncio.sleep(wait)

    async def navigate_to_survival(self, max_steps=80):
        """Follow the instructor until we reach 'Learning to Survive'."""
        ptr = 0
        idle = 0
        for _ in range(max_steps):
            if self.room and "survive" in self.room.lower():
                return True
            if ptr < len(self.says):
                text = self.says[ptr]; ptr += 1
                cmd = extract_command(text)
                if cmd:
                    await self.cmd(cmd)
                    idle = 0
                    continue
            # no new actionable instruction: look, and if quiet a while, nudge west
            idle += 1
            await self.cmd("look")
            if idle >= 4 and "west" in [e.lower() for e in self.exits]:
                await self.cmd("west"); idle = 0
        return bool(self.room and "survive" in self.room.lower())

    async def try_west(self):
        start = self.room
        await self.cmd("west", 1.4)
        return self.room and self.room != start

    async def run(self):
        self.ws = await websockets.connect(URL, ping_interval=30, ping_timeout=10)
        recv = asyncio.create_task(self.receive_loop())
        try:
            if not await self.login():
                print("LOGIN FAILED"); return
            await self.cmd("look", 2.0)
            print(f"Login room={self.room!r} area={self.area!r}", flush=True)

            if not await self.navigate_to_survival():
                print(f"Could not reach survival room (stuck at {self.room!r}). Aborting.", flush=True)
                return
            print(f"Reached survival: room={self.room!r} exits={self.exits} hp={self.hp}/{self.maxhp}", flush=True)

            if await self.try_west():
                print(f"Survival exit was already open -> {self.room!r}"); return
            print("Gated (west refused). Trying candidate completion actions...", flush=True)

            for cand in CANDIDATES:
                await self.cmd(cand, 1.6)
                resp = " | ".join(self.block[-3:])[:150]
                if await self.try_west():
                    print(f"\n>>> GATE RELEASED BY {cand!r} -> moved west to {self.room!r}", flush=True)
                    return
                print(f"  [{cand:<26}] still gated | {resp}", flush=True)
            print("\nVERDICT: no action released the survival gate -> server-side bug "
                  "(all taught skills done, correct exit gated, no completion path).", flush=True)
        finally:
            recv.cancel()
            await self.ws.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--creds")
    a = ap.parse_args()
    u = os.getenv("MUD_USERNAME"); p = os.getenv("MUD_PASSWORD")
    if a.creds:
        d = json.load(open(a.creds)); u = u or d.get("username"); p = p or d.get("password")
    if not u or not p:
        sys.exit("Need creds.")
    asyncio.run(Probe(u, p).run())


if __name__ == "__main__":
    main()
