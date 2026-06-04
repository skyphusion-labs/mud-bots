"""Probe what actually completes the Packet Wastes 'Learning to Survive' lesson.

The survival room teaches drink water / eat ration / forage (all of which the bot
does, and foraging even succeeds repeatedly), yet any move is refused with
"Not yet! Survival skills first." This logs into a character parked in that room
and tries a battery of candidate completion actions, re-testing the advertised
exits after each, reporting which action (if any) lets the character leave.

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

URL = os.getenv("MUD_SERVER_URL", "wss://74-208-68-248.sslip.io/ws")
_HP_RE = re.compile(r"HP:(-?\d+)/(\d+)")

# Things that might satisfy/advance the survival lesson, in rough order of
# likelihood. Movement is re-tried after each, so these are non-move actions.
CANDIDATES = [
    "status", "score", "skills", "survival", "inventory",
    "search", "examine scrub", "look scrub", "look plants", "get plants",
    "drink water", "eat ration", "eat jerky strip",
    "forage", "forage", "forage",
    "practice survival", "learn survival", "train survival", "train",
    "ask instructor about training", "ask instructor about survival",
    "say done", "talk instructor", "greet instructor",
]


class Probe:
    def __init__(self, username, password):
        self.username, self.password = username, password
        self.ws = None
        self.block = []
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

    async def cmd(self, c, wait=1.6):
        await self.send(c)
        await asyncio.sleep(wait)

    async def try_exit(self):
        """Try advertised exits (+ w/e/n/s) and report if we left the room."""
        start_room = self.room
        for mv in list(self.exits) + ["west", "east", "north", "south", "up", "down"]:
            await self.cmd(mv, 1.4)
            if self.room and self.room != start_room:
                return mv
        return None

    async def run(self):
        self.ws = await websockets.connect(URL, ping_interval=30, ping_timeout=10)
        recv = asyncio.create_task(self.receive_loop())
        try:
            if not await self.login():
                print("LOGIN FAILED"); return
            await self.cmd("look", 2.0)
            print(f"START room={self.room!r} area={self.area!r} exits={self.exits} hp={self.hp}/{self.maxhp}", flush=True)

            mv = await self.try_exit()
            if mv:
                print(f"Already free: left via {mv!r} -> {self.room!r}"); return
            print("Confirmed gated. Trying candidates...", flush=True)

            for cand in CANDIDATES:
                await self.cmd(cand, 1.6)
                resp = " | ".join(self.block[-4:])[:160]
                mv = await self.try_exit()
                tag = f"ESCAPED via {mv!r}" if mv else "still gated"
                print(f"  [{cand:<28}] {tag}   resp: {resp}", flush=True)
                if mv:
                    print(f"\n>>> SURVIVAL GATE RELEASED BY: {cand!r} (then move {mv!r}) -> {self.room!r}", flush=True)
                    return
            print("\nNo candidate released the gate. Likely a server-side flag bug.", flush=True)
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
