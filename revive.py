"""One-shot revival driver for a character stuck dead in the Shadow Realm.

Packet Wastes sends a killed (protected) character to a 'Waiting room' in the
Shadow Realm with the message "too weak to leave - rest until your wounds
close." There is no 'resurrect' verb; you recover HP and then walk out. This
logs in, reports vitals, runs a recovery sequence, and reports whether the
character escaped back into a normal area. Pure protocol, no LLM.

    MUD_USERNAME=... MUD_PASSWORD=... python3 revive.py
    python3 revive.py --creds bot_identity.json
"""
import argparse
import asyncio
import json
import os
import re
import sys

import websockets

from mapper import parse_gmcp, strip_ansi

# HP is reported in the prompt line, e.g. "[... HP:-10/30 MP:0/50]", not GMCP.
_HP_RE = re.compile(r"HP:(-?\d+)/(\d+)")

URL = os.getenv("MUD_SERVER_URL", "wss://74-208-68-248.sslip.io/ws")


class Reviver:
    def __init__(self, username, password):
        self.username = username
        self.password = password
        self.ws = None
        self.block = []          # recent clean prose lines
        self.in_game = False
        self.hp = self.maxhp = None
        self.room = None
        self.area = None
        self.exits = []

    async def send(self, cmd):
        self.block = []
        print(">>> ********", flush=True)
        await self.ws.send(cmd)

    def _note(self, message):
        for pkg, data in parse_gmcp(message):
            if pkg in ("Char", "Game", "Char.Info"):
                self.in_game = True
            if pkg == "Char.Vitals" and isinstance(data, dict):
                if "hp" in data:
                    self.hp = data.get("hp")
                self.maxhp = data.get("maxhp", self.maxhp)
            if pkg == "Room.Info" and isinstance(data, dict) and "num" in data:
                self.in_game = True
                self.room = data.get("name")
                self.area = data.get("area")
                self.exits = list((data.get("exits") or {}).keys())
        clean = strip_ansi(message)
        m = None
        for hit in _HP_RE.finditer(clean):
            m = hit  # take the last (most recent) prompt in the chunk
        if m:
            self.hp, self.maxhp = int(m.group(1)), int(m.group(2))
        for line in clean.splitlines():
            s = line.strip()
            if s and not s.startswith(("!!GMCP(", "!!MUSIC", "TEXTMASK")):
                self.block.append(s)

    async def receive_loop(self):
        try:
            async for message in self.ws:
                if isinstance(message, bytes):
                    message = message.decode("utf-8", errors="replace")
                self._note(message)
        except websockets.ConnectionClosed:
            pass

    async def login(self):
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

    def status(self):
        return f"[room={self.room!r} area={self.area!r} hp={self.hp}/{self.maxhp} exits={self.exits}]"

    async def cmd(self, c, wait=2.0):
        await self.send(c)
        await asyncio.sleep(wait)
        # echo any salient response lines
        for line in self.block[-8:]:
            low = line.lower()
            if any(k in low for k in ("too weak", "rest", "recover", "wound", "shadow",
                                      "not recognized", "can't", "cannot", "leave",
                                      "stand", "wake", "alive", "rise", "stagger",
                                      "you are", "feel")):
                print(f"    | {line}", flush=True)

    async def run(self):
        self.ws = await websockets.connect(URL, ping_interval=30, ping_timeout=10)
        recv = asyncio.create_task(self.receive_loop())
        try:
            if not await self.login():
                print("LOGIN FAILED", flush=True)
                return
            print("Logged in.", flush=True)
            await self.cmd("look", 2.5)
            print("START:", self.status(), flush=True)

            # If we're already alive and out of the shadow realm, nothing to do.
            if self.hp is not None and self.hp > 0 and self.area and "shadow" not in self.area.lower():
                print(f"Already alive in {self.area!r}; no revive needed.", flush=True)
                return

            # The 'Guide' NPC heals a downed character back from the edge slowly
            # over real time while connected. Idle (send `wait`) and poll HP for up
            # to ~30 min for it to cross above 0 -> no longer downed.
            print("Idling for the Guide to revive (HP > 0); this is slow...", flush=True)
            for i in range(180):
                if self.hp is not None and self.hp > 0:
                    print(f"  REVIVED: HP={self.hp}/{self.maxhp} after ~{i*10}s", flush=True)
                    break
                await self.send("wait")       # pass time; healing is time-based
                await asyncio.sleep(10)
                if i % 6 == 0:
                    print(f"  t={i*10:>4}s HP={self.hp}/{self.maxhp}", flush=True)
            else:
                print(f"  Still downed after ~30 min (HP={self.hp}/{self.maxhp}); giving up this cycle.", flush=True)
                return

            # No longer downed: stand up, then leave the shadow realm. Once the
            # Guide has healed you "enough to travel" the server spawns a portal:
            #   "A shimmering portal to the world of the living appears!
            #    Type shimmering portal to step through."
            # Prefer that portal, but keep recall (which still works) and any
            # advertised exit as fallbacks so a slow portal never traps us.
            await self.cmd("stand", 2.5)
            print("  after stand", self.status(), flush=True)

            def out_of_shadow():
                return bool(self.area) and "shadow" not in self.area.lower()

            def portal_ready():
                return any("shimmering portal" in s.lower()
                           or "recovered enough to travel" in s.lower()
                           for s in self.block[-20:])

            # The portal only appears once fully recovered (time-based), so idle
            # and poll for up to ~5 min. Step through it the moment it shows; in
            # the meantime try recall every so often, which also leaves the realm.
            for i in range(30):
                if out_of_shadow():
                    break
                if portal_ready():
                    await self.cmd("shimmering portal", 2.5)
                    print("  after shimmering portal", self.status(), flush=True)
                    if out_of_shadow():
                        break
                if i % 3 == 0:
                    await self.cmd("recall", 2.0)
                    print("  after recall", self.status(), flush=True)
                    if out_of_shadow():
                        break
                await self.send("wait")          # pass time; healing is time-based
                await asyncio.sleep(9.0)
                await self.cmd("look", 1.5)

            # Last resort: walk out through any advertised exit or common verb.
            if not out_of_shadow():
                for mv in list(self.exits) + ["recall", "out", "leave", "north", "south", "east", "west", "up", "down"]:
                    await self.cmd(mv, 1.5)
                    if out_of_shadow():
                        print(f"ESCAPED via {mv!r}", flush=True)
                        break

            print("FINAL:", self.status(), flush=True)
            if out_of_shadow():
                print(f"ESCAPED the shadow realm -> {self.area} / {self.room}", flush=True)
            else:
                print("Still in the shadow realm; may need another exit verb.", flush=True)
        finally:
            recv.cancel()
            await self.ws.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--creds")
    args = ap.parse_args()
    user = os.getenv("MUD_USERNAME")
    pw = os.getenv("MUD_PASSWORD")
    if args.creds:
        d = json.load(open(args.creds))
        user = user or d.get("username")
        pw = pw or d.get("password")
    if not user or not pw:
        sys.exit("Need MUD_USERNAME/MUD_PASSWORD or --creds.")
    asyncio.run(Reviver(user, pw).run())


if __name__ == "__main__":
    main()
