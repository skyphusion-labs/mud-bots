#!/usr/bin/env python3
"""
Probe the Packet Wastes tutorial "Learning to Fight" gate (room 1000000002).

The Combat Instructor says "head west to complete your training," but `west`
returns Room.WrongDir, and any other exit triggers "Not so hasty! Lets finish up
here before you leave the area." That message implies a completion trigger we
haven't hit. This script drives the tutorial to the fight room like the bot does,
then tries a battery of candidate "completion" commands, re-testing `west` after
each one to see what (if anything) unlocks the gate.

It is read-mostly and deterministic: no LLM. Login only (account must exist).

    MUD_USERNAME=ai_borg MUD_PASSWORD=... python3 probe_fightroom.py
    python3 probe_fightroom.py --creds bot_identity.json
"""

import argparse
import asyncio
import json
import logging
import os
from pathlib import Path

import websockets

from mapper import parse_gmcp, strip_ansi
from tutorial import extract_command

LOG = logging.getLogger("probe")

FIGHT_ROOM = 1000000002

# Candidate "finish up here" completion actions, tried one at a time. After each,
# we re-issue `west` and check whether we left the fight room.
CANDIDATES = [
    # combat / dummy follow-ups
    "kill dummy", "attack dummy", "get all", "loot dummy", "search dummy",
    "examine dummy", "look dummy", "skin dummy",
    # training verbs
    "train", "practice", "learn",
    # acknowledge / finish verbs
    "done", "finish", "finish training", "complete", "complete training",
    "graduate", "ready", "continue",
    # instructor interaction
    "list", "say done", "greet Combat Instructor", "talk Combat Instructor",
    "ask Combat Instructor about training", "ask Combat Instructor about west",
    # housekeeping the gate might want
    "rest", "stand", "sheathe", "remove rebar", "score",
]


class Probe:
    def __init__(self, url, user, pw):
        self.url, self.user, self.pw = url, user, pw
        self.ws = None
        self.in_game = False
        self.area = None
        self.room_num = None
        self.says: list[str] = []          # instructor texts, in order
        self.block: list[str] = []         # clean prose for login detection
        self.capture: list[str] = []       # clean lines since last reset
        self.wrongdir_for = None           # last dir the server bounced
        self.capturing = False

    async def connect(self):
        self.ws = await websockets.connect(self.url, ping_interval=30, ping_timeout=10)

    async def send(self, cmd):
        self.wrongdir_for = None
        LOG.info(f">>> {cmd}")
        await self.ws.send(cmd)

    def _reset_capture(self):
        self.capture = []
        self.wrongdir_for = None
        self.capturing = True

    async def recv_loop(self):
        try:
            async for msg in self.ws:
                if isinstance(msg, bytes):
                    msg = msg.decode("utf-8", errors="replace")
                for pkg, data in parse_gmcp(msg):
                    if pkg == "Room.Info" and isinstance(data, dict):
                        self.in_game = True
                        self.area = data.get("area", self.area)
                        if data.get("num") is not None:
                            self.room_num = data["num"]
                    elif pkg in ("Char", "Char.Info", "Game"):
                        self.in_game = True
                    elif pkg == "Comm.Channel" and isinstance(data, dict):
                        if data.get("source") == "mob" and data.get("text"):
                            self.says.append(data["text"].strip())
                if '!!GMCP(Room.WrongDir' in msg:
                    # pull the quoted dir
                    a = msg.find('Room.WrongDir')
                    seg = msg[a:a + 40]
                    self.wrongdir_for = seg.split('"')[1] if '"' in seg else "?"
                clean = strip_ansi(msg)
                for line in clean.splitlines():
                    s = line.strip()
                    if s and not s.startswith(("!!GMCP(", "!!MUSIC", "!!SOUND", "TEXTMASK")):
                        self.block.append(s)
                        if self.capturing:
                            self.capture.append(s)
        except websockets.ConnectionClosed:
            LOG.warning("connection closed")

    async def login(self):
        deadline = asyncio.get_event_loop().time() + 60
        sent_user = sent_pass = False
        while asyncio.get_event_loop().time() < deadline and not self.in_game:
            await asyncio.sleep(0.5)
            recent = "\n".join(self.block[-6:]).lower()
            if "kick them" in recent:
                await self.send("y"); await asyncio.sleep(0.6); continue
            if not sent_user and "username" in recent:
                await self.send(self.user); sent_user = True; await asyncio.sleep(0.6)
            elif sent_user and not sent_pass and "password" in recent:
                await self.send(self.pw); sent_pass = True; await asyncio.sleep(0.6)
        return self.in_game

    async def drive_to_gate(self, max_steps=40):
        """Follow instructor commands until we're in the fight room and the
        instructor tells us to 'head west to complete' (the gate)."""
        await self.send("look"); await asyncio.sleep(1.5)
        pointer = 0
        last = None
        idle = 0
        steps = 0
        while steps < max_steps:
            await asyncio.sleep(0.5)
            if pointer >= len(self.says):
                idle += 1
                if idle >= 12:
                    idle = 0; await self.send("look")
                continue
            idle = 0
            text = self.says[pointer]; pointer += 1
            low = text.lower()
            # The gate line — stop driving, hand off to the probe.
            if "complete your training" in low or ("head west" in low and self.room_num == FIGHT_ROOM):
                LOG.info(f"Reached gate. Instructor: {text!r} (room {self.room_num}, area {self.area})")
                return True
            if text == last:
                continue
            cmd = extract_command(text)
            if cmd:
                # Don't let the driver walk us OUT via west; that's the gate.
                if cmd == "west" and self.room_num == FIGHT_ROOM:
                    LOG.info("Driver hit the west gate.")
                    return True
                LOG.info(f"[drive] instructor {text!r} -> {cmd!r}")
                await self.send(cmd); last = text; steps += 1
                await asyncio.sleep(2.2)
        LOG.warning(f"Did not reach gate in {max_steps} steps (room {self.room_num}).")
        return self.room_num == FIGHT_ROOM

    async def try_west(self):
        """Send west; return ('moved'|'wrongdir'|'gated'|'silent', detail)."""
        self._reset_capture()
        await self.send("west")
        await asyncio.sleep(2.5)
        self.capturing = False
        if self.room_num != FIGHT_ROOM or (self.area and self.area.lower() != "tutorial"):
            return "moved", f"room={self.room_num} area={self.area}"
        if self.wrongdir_for == "west":
            return "wrongdir", "Room.WrongDir west"
        gate = [l for l in self.capture if "finish up" in l.lower() or "not so hasty" in l.lower()]
        if gate:
            return "gated", gate[0]
        return "silent", " | ".join(self.capture[-2:]) or "(no response)"

    async def ensure_dummy_dead(self):
        """If a training dummy is alive, kill it so combat state can't be the gate."""
        self._reset_capture()
        await self.send("attack dummy")
        await asyncio.sleep(3.0)
        self.capturing = False
        LOG.info(f"[combat] {' | '.join(self.capture[-3:]) or '(no response)'}")

    async def run_probe(self):
        # Baseline: confirm the gate is shut.
        verdict, detail = await self.try_west()
        LOG.info(f"[baseline] west -> {verdict}: {detail}")
        if verdict == "moved":
            LOG.info("!! west already works — no completion action needed.")
            return True

        await self.ensure_dummy_dead()
        verdict, detail = await self.try_west()
        LOG.info(f"[after re-attack] west -> {verdict}: {detail}")
        if verdict == "moved":
            LOG.info("!! SOLVED: killing the dummy again opened west.")
            return True

        for cand in CANDIDATES:
            if self.room_num != FIGHT_ROOM:
                LOG.info(f"Left the fight room (now {self.room_num}); stopping.")
                return True
            self._reset_capture()
            await self.send(cand)
            await asyncio.sleep(2.5)
            self.capturing = False
            resp = " | ".join(self.capture[-3:]) or "(no response)"
            instr_before = len(self.says)
            verdict, detail = await self.try_west()
            instr_new = self.says[instr_before:]
            note = f"  instr:{instr_new}" if instr_new else ""
            LOG.info(f"[try {cand!r}] resp: {resp}{note}")
            LOG.info(f"         then west -> {verdict}: {detail}")
            if verdict == "moved":
                LOG.info(f"!! SOLVED: {cand!r} opened the west gate -> room {self.room_num} area {self.area}")
                return True
        LOG.warning("Exhausted all candidate completion actions; west still gated.")
        return False

    async def run(self):
        await self.connect()
        receiver = asyncio.create_task(self.recv_loop())
        try:
            if not await self.login():
                LOG.error("login failed"); return False
            LOG.info(f"In game. room={self.room_num} area={self.area}")
            if not await self.drive_to_gate():
                LOG.error("could not reach the fight-room gate"); return False
            return await self.run_probe()
        finally:
            receiver.cancel()
            if self.ws:
                await self.ws.close()


def load_creds(args):
    user = os.getenv("MUD_USERNAME")
    pw = os.getenv("MUD_PASSWORD")
    if args.creds:
        d = json.loads(Path(args.creds).read_text())
        user = user or d.get("username"); pw = pw or d.get("password")
    if not user or not pw:
        raise SystemExit("need creds: MUD_USERNAME/MUD_PASSWORD or --creds file.json")
    return user, pw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--creds")
    ap.add_argument("--url", default=os.getenv("MUD_SERVER_URL", "wss://74-208-68-248.sslip.io/ws"))
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper()),
                        format="[%(asctime)s] %(message)s", datefmt="%H:%M:%S")
    user, pw = load_creds(args)
    ok = asyncio.run(Probe(args.url, user, pw).run())
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
