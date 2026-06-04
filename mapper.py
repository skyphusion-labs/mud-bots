#!/usr/bin/env python3
"""
Packet Wastes MUD Mapper - GMCP-native, exact, zero-LLM.

Packet Wastes speaks GMCP: it emits !!GMCP(Room.Info {...}) blocks containing a
unique room number, an exits map (direction -> destination room number), and
per-exit dx/dy/dz coordinate deltas. So mapping is not guesswork. We read the
server's own room IDs and walk the graph it hands us.

Exploration is BFS over the known graph: from the current room, find the nearest
room we know an edge into but haven't visited, path to it through visited rooms,
step in, record its Room.Info, repeat. Because every room reports its own num,
we always know exactly where we are; no description-hashing, no reversibility
assumption, no backtrack reconciliation.

Standalone: no bot.py import, no openai, no model. Just the protocol.

IMPORTANT - the tutorial gate:
  New characters spawn in a tutorial where movement and most commands are
  DISABLED until the tutorial is completed. This mapper cannot crawl a character
  that is still in the tutorial. Complete the tutorial by hand once per account,
  then run this against that (post-tutorial) account.

Credentials:
  The account must already exist and have finished the tutorial. Provide creds
  via env (MUD_USERNAME / MUD_PASSWORD) or --creds path/to/creds.json
  ({"username": "...", "password": "..."}).

Output: map.json
"""

import argparse
import asyncio
import json
import logging
import os
import re
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

import websockets

LOG = logging.getLogger("mapper")

# =============================================================================
# Wire helpers
# =============================================================================

_ANSI = re.compile(r"\x1b\[[0-9;]*[mABCDEFGHJKSTfn]|\x1b\].*?\x07")


def strip_ansi(text: str) -> str:
    return _ANSI.sub("", text)


def parse_gmcp(text: str) -> list[tuple[str, object]]:
    """Extract (package, data) pairs from !!GMCP(Package {json}) markers.

    Uses a balanced brace/bracket scan so deeply nested Room.Info payloads parse
    correctly (a naive regex stops at the first closing brace and fails).
    """
    out: list[tuple[str, object]] = []
    i, marker = 0, "!!GMCP("
    while True:
        idx = text.find(marker, i)
        if idx == -1:
            break
        j = idx + len(marker)
        k = j
        while k < len(text) and text[k] not in " \t{[":
            k += 1
        pkg = text[j:k].strip()
        while k < len(text) and text[k] in " \t":
            k += 1
        if k >= len(text) or text[k] not in "{[":
            i = j
            continue
        openc = text[k]
        closec = "}" if openc == "{" else "]"
        depth, in_str, esc, end = 0, False, False, k
        for m in range(k, len(text)):
            c = text[m]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == openc:
                    depth += 1
                elif c == closec:
                    depth -= 1
                    if depth == 0:
                        end = m
                        break
        try:
            out.append((pkg, json.loads(text[k:end + 1])))
        except Exception as e:
            LOG.debug(f"GMCP parse failed for {pkg}: {e}")
        i = end + 1
    return out


# =============================================================================
# Map model
# =============================================================================

@dataclass
class Room:
    num: int
    name: str = ""
    area: str = ""
    environment: str = ""
    coords: str = ""
    exits: dict = field(default_factory=dict)    # direction -> destination num
    deltas: dict = field(default_factory=dict)   # direction -> [dx, dy, dz]
    npcs: list = field(default_factory=list)
    visited: bool = False


class WorldMap:
    def __init__(self):
        self.rooms: dict[int, Room] = {}
        self.start: Optional[int] = None
        self.failed_edges: set = set()  # (num, direction) we tried and couldn't traverse

    def upsert(self, data: dict) -> Room:
        """Record (or update) a room from a Room.Info GMCP payload."""
        num = data["num"]
        room = self.rooms.get(num)
        if room is None:
            room = Room(num=num)
            self.rooms[num] = room
            if self.start is None:
                self.start = num
        room.name = data.get("name", room.name)
        room.area = data.get("area", room.area)
        room.environment = data.get("environment", room.environment)
        room.coords = data.get("coords", room.coords)
        room.exits = dict(data.get("exits", room.exits))
        v2 = data.get("exitsv2", {})
        if v2:
            room.deltas = {
                d: [info.get("dx", 0), info.get("dy", 0), info.get("dz", 0)]
                for d, info in v2.items()
            }
        npcs = data.get("Contents", {}).get("Npcs", [])
        if npcs:
            room.npcs = [n.get("name", "?") for n in npcs]
        room.visited = True
        # Make sure destination rooms exist as (unvisited) nodes so we can target them.
        for dest in room.exits.values():
            self.rooms.setdefault(dest, Room(num=dest))
        return room

    def frontier(self) -> set:
        """Destination room nums we know an edge into but haven't visited."""
        f = set()
        for r in self.rooms.values():
            if not r.visited:
                continue
            for d, dest in r.exits.items():
                if (r.num, d) in self.failed_edges:
                    continue
                if dest in self.rooms and not self.rooms[dest].visited:
                    f.add(dest)
        return f

    def find_path(self, start: int, goal: int) -> Optional[list[str]]:
        """BFS through VISITED rooms to a direction-path that ends entering goal."""
        q = deque([(start, [])])
        seen = {start}
        while q:
            node, path = q.popleft()
            room = self.rooms.get(node)
            if room is None or (not room.visited and node != start):
                continue
            for d, dest in room.exits.items():
                if (node, d) in self.failed_edges:
                    continue
                if dest == goal:
                    return path + [d]
                if dest not in seen and dest in self.rooms and self.rooms[dest].visited:
                    seen.add(dest)
                    q.append((dest, path + [d]))
        return None

    def stats(self) -> dict:
        visited = [r for r in self.rooms.values() if r.visited]
        return {
            "rooms_visited": len(visited),
            "rooms_known": len(self.rooms),
            "open_frontier": len(self.frontier()),
        }

    def to_json(self) -> dict:
        return {
            "generated": datetime.now().isoformat(),
            "start": self.start,
            "stats": self.stats(),
            "rooms": {
                str(r.num): {
                    "name": r.name,
                    "area": r.area,
                    "environment": r.environment,
                    "coords": r.coords,
                    "exits": r.exits,
                    "deltas": r.deltas,
                    "npcs": r.npcs,
                    "visited": r.visited,
                }
                for r in self.rooms.values()
            },
        }


# =============================================================================
# Mapper
# =============================================================================

class GMCPMapper:
    def __init__(self, config: dict, args):
        self.url = config["server_url"]
        self.username = config["username"]
        self.password = config["password"]
        self.args = args

        self.ws = None
        self.in_game = False
        self.world = WorldMap()
        self.current: Optional[int] = None

        self.block: list[str] = []           # clean prose since last command
        self.room_event = asyncio.Event()    # set when a Room.Info arrives
        self.last_room_num: Optional[int] = None

    # ---- connection -------------------------------------------------------

    async def connect(self) -> bool:
        LOG.info(f"Connecting to {self.url}")
        try:
            self.ws = await websockets.connect(self.url, ping_interval=30, ping_timeout=10)
            return True
        except Exception as e:
            LOG.error(f"Connection failed: {e}")
            return False

    async def send(self, command: str) -> None:
        self.block = []
        await self.ws.send(command)

    async def receive_loop(self) -> None:
        try:
            async for message in self.ws:
                if isinstance(message, bytes):
                    message = message.decode("utf-8", errors="replace")
                # GMCP first (structured truth)
                for pkg, data in parse_gmcp(message):
                    self._handle_gmcp(pkg, data)
                # Then keep clean prose for login detection / debug only
                clean = strip_ansi(message)
                for line in clean.splitlines():
                    s = line.strip()
                    if s and not s.startswith(("!!GMCP(", "!!MUSIC", "TEXTMASK")):
                        self.block.append(s)
        except websockets.ConnectionClosed:
            LOG.warning("Connection closed")
        except Exception as e:
            LOG.error(f"Receive error: {e}")

    def _handle_gmcp(self, pkg: str, data) -> None:
        if pkg in ("Char", "Char.Info", "Game"):
            self.in_game = True
        elif pkg == "Room.Info" and isinstance(data, dict) and "num" in data:
            self.in_game = True
            room = self.world.upsert(data)
            self.current = room.num
            self.last_room_num = room.num
            self.room_event.set()

    async def wait_for_room(self, timeout: float) -> Optional[int]:
        """Wait for the next Room.Info; return its num (or None on timeout)."""
        self.room_event.clear()
        try:
            await asyncio.wait_for(self.room_event.wait(), timeout)
            return self.last_room_num
        except asyncio.TimeoutError:
            return None

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

    # ---- crawl ------------------------------------------------------------

    async def crawl(self) -> None:
        # Establish the starting room.
        await self.send("look")
        await self.wait_for_room(self.args.max_wait)
        if self.current is None:
            LOG.error("No Room.Info after 'look'. Is GMCP enabled / are we in-game?")
            return

        start = self.world.rooms[self.current]
        LOG.info(f"Start: [{start.num}] {start.name} (area={start.area!r})")

        # Tutorial gate: movement is disabled, so refuse to spin uselessly.
        if start.area.lower() == "tutorial" or "tutorial" in (start.environment or "").lower():
            LOG.error(
                "This character is in the TUTORIAL, where movement is disabled. "
                "Complete the tutorial by hand once, then run the mapper against "
                "that account. Aborting crawl (nothing to map here)."
            )
            return

        moves = 0
        while True:
            if moves >= self.args.max_moves or self.world.stats()["rooms_visited"] >= self.args.max_rooms:
                LOG.warning("Hit safety cap; stopping.")
                break

            frontier = self.world.frontier()
            if not frontier:
                LOG.info("No reachable unvisited rooms left.")
                break

            # Nearest reachable frontier room from where we stand.
            target, best = None, None
            for t in frontier:
                p = self.world.find_path(self.current, t)
                if p is not None and (best is None or len(p) < len(best)):
                    best, target = p, t
            if best is None:
                LOG.warning(f"{len(frontier)} unvisited rooms exist but none reachable from here; stopping.")
                break

            for direction in best:
                origin = self.current
                await self.send(direction)
                moves += 1
                arrived = await self.wait_for_room(self.args.max_wait)
                if arrived is None or arrived == origin:
                    # Move didn't take (blocked / one-way / disabled). Don't retry it.
                    self.world.failed_edges.add((origin, direction))
                    LOG.debug(f"Edge {origin} --{direction}--> failed; marking blocked.")
                    break
                await asyncio.sleep(self.args.pace)

            s = self.world.stats()
            if s["rooms_visited"] % self.args.save_every == 0:
                self.save()
            LOG.info(
                f"{s['rooms_visited']} visited, {s['rooms_known']} known, "
                f"{s['open_frontier']} frontier"
            )

    # ---- output -----------------------------------------------------------

    def save(self) -> None:
        Path(self.args.output).write_text(json.dumps(self.world.to_json(), indent=2))
        s = self.world.stats()
        LOG.info(f"Saved {self.args.output}: {s['rooms_visited']} rooms")

    async def run(self) -> None:
        if not await self.connect():
            return
        receiver = asyncio.create_task(self.receive_loop())
        try:
            LOG.info(f"Logging in as {self.username}")
            if not await self.login():
                LOG.error("Login failed (never reached in-game state).")
                return
            LOG.info("In game. Starting crawl.")
            await self.crawl()
        finally:
            self.save()
            receiver.cancel()
            if self.ws:
                await self.ws.close()
            s = self.world.stats()
            LOG.info(f"Done. {s['rooms_visited']} rooms mapped, {s['open_frontier']} frontier left.")


# =============================================================================
# Entry point
# =============================================================================

def load_creds(args) -> dict:
    user = os.getenv("MUD_USERNAME")
    pw = os.getenv("MUD_PASSWORD")
    if args.creds:
        data = json.loads(Path(args.creds).read_text())
        user = user or data.get("username")
        pw = pw or data.get("password")
    if not user or not pw:
        raise SystemExit(
            "No credentials. Set MUD_USERNAME and MUD_PASSWORD, or pass --creds creds.json "
            '({"username":"...","password":"..."}). The account must have finished the tutorial.'
        )
    return {
        "server_url": os.getenv("MUD_SERVER_URL", "wss://74-208-68-248.sslip.io/ws"),
        "username": user,
        "password": pw,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="GMCP-native Packet Wastes mapper")
    ap.add_argument("--creds", help="JSON file with username/password")
    ap.add_argument("--output", default="map.json")
    ap.add_argument("--pace", type=float, default=0.6, help="seconds between moves")
    ap.add_argument("--max-wait", type=float, default=4.0, help="seconds to wait for a Room.Info")
    ap.add_argument("--max-rooms", type=int, default=5000)
    ap.add_argument("--max-moves", type=int, default=50000)
    ap.add_argument("--save-every", type=int, default=10)
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="[%(asctime)s] [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    config = load_creds(args)
    mapper = GMCPMapper(config, args)
    try:
        asyncio.run(mapper.run())
    except KeyboardInterrupt:
        mapper.save()
        print("\nInterrupted; partial map saved.")


if __name__ == "__main__":
    main()
