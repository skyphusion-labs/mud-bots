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

    def load_json(self, data: dict) -> None:
        """Seed the map from a previously saved to_json() dict (for --resume), so
        coverage accumulates across deaths, reconnects, and separate runs."""
        if self.start is None:
            self.start = data.get("start")
        for num_s, rd in (data.get("rooms") or {}).items():
            try:
                num = int(num_s)
            except (TypeError, ValueError):
                continue
            room = self.rooms.get(num) or Room(num=num)
            room.name = rd.get("name", room.name)
            room.area = rd.get("area", room.area)
            room.environment = rd.get("environment", room.environment)
            room.coords = rd.get("coords", room.coords)
            room.exits = {d: int(v) for d, v in (rd.get("exits") or {}).items()}
            room.deltas = rd.get("deltas", room.deltas) or {}
            room.npcs = rd.get("npcs", room.npcs) or []
            room.visited = bool(rd.get("visited", room.visited))
            self.rooms[num] = room
        # Make sure every known exit destination exists as a node to target.
        for r in list(self.rooms.values()):
            for dest in r.exits.values():
                self.rooms.setdefault(dest, Room(num=dest))

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
    # Login / character-select prompts (mirrors bot.py's GameParser.PATTERNS).
    _LOGIN = {
        "kick": re.compile(r"already (?:logged in|connected)|kick them", re.I),
        "confirm_password": re.compile(r"confirm password", re.I),
        "new_password": re.compile(r"create a new password|new password", re.I),
        "race": re.compile(r"choose.*race|select.*race|pick.*race", re.I),
        "klass": re.compile(r"choose.*class|select.*class|pick.*class", re.I),
        "name": re.compile(r"enter a name|character name|name for your|by number or name", re.I),
        "press_enter": re.compile(r"press.*enter", re.I),
        "password": re.compile(r"enter your password|password:", re.I),
        "username": re.compile(r'enter your username|username.*?:|\(or "new"\)', re.I),
    }

    def __init__(self, config: dict, args):
        self.url = config["server_url"]
        self.username = config["username"]
        self.password = config["password"]
        self.race = config.get("race", "")
        self.char_class = config.get("char_class", "")
        self.char_name = config.get("char_name", "")
        self.args = args

        self.ws = None
        self.in_game = False
        self.world = WorldMap()
        self.current: Optional[int] = None

        self.block: list[str] = []           # clean prose since last command
        self.room_event = asyncio.Event()    # set when a Room.Info arrives
        self.last_room_num: Optional[int] = None
        self.last_live_room: Optional[int] = None  # last non-Shadow room (the death site)

        # Survival state. Desert zones (Whispering Dunes/Mojave) tick thirst and
        # starvation that crush stats and eventually kill the crawler; we drink/
        # eat to clear them. The map checkpoints every --save-every rooms, so
        # staying alive just means more continuous coverage.
        self.hp: Optional[int] = None
        self.hp_max: Optional[int] = None
        self.affects: set[str] = set()              # active affect names, lowercased
        self.drinks: list[str] = ["canteen"]        # drinkable keywords (refined from GMCP)
        self.foods: list[str] = ["bark", "fungus"]  # edible keywords (refined from GMCP)
        self._last_drink = 0.0
        self._last_eat = 0.0

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
        # Survival telemetry. Arrives either as the big "Char" package (nested
        # Vitals/Affects/Inventory) or as incremental "Char.Vitals"/"Char.Affects".
        if pkg == "Char" and isinstance(data, dict):
            self._update_vitals(data.get("Vitals"))
            self._update_affects(data.get("Affects"))
            self._update_inventory(data.get("Inventory"))
        elif pkg == "Char.Vitals":
            self._update_vitals(data)
        elif pkg == "Char.Affects":
            self._update_affects(data)
        elif pkg == "Char.Inventory":
            self._update_inventory(data)
        if pkg == "Room.Info" and isinstance(data, dict) and "num" in data:
            self.in_game = True
            room = self.world.upsert(data)
            self.current = room.num
            self.last_room_num = room.num
            # Remember the last live room so we can name the death site when the
            # server later dumps us in the Shadow Realm.
            if "shadow" not in (room.area or "").lower():
                self.last_live_room = room.num
            self.room_event.set()

    def _update_vitals(self, data) -> None:
        if isinstance(data, dict):
            if data.get("hp") is not None:
                self.hp = data.get("hp")
            if data.get("hp_max") is not None:
                self.hp_max = data.get("hp_max")

    def _update_affects(self, data) -> None:
        # GMCP pushes the full current affect set, so replace wholesale; a
        # cleared affect simply stops appearing.
        if isinstance(data, dict):
            self.affects = {str(k).lower() for k in data}

    def _update_inventory(self, data) -> None:
        # Harvest drinkable/edible keywords from the backpack so we can target
        # them by name, e.g. "Founder's Canteen" -> "canteen".
        if not isinstance(data, dict):
            return
        bp = data.get("Backpack")
        items = bp.get("items") if isinstance(bp, dict) else None
        if not isinstance(items, list):
            return
        drinks, foods = [], []
        for it in items:
            if not isinstance(it, dict):
                continue
            name = (it.get("name") or "").strip()
            if not name:
                continue
            kw = name.split()[-1].lower()
            t = (it.get("type") or "").lower()
            if t == "drink" and kw not in drinks:
                drinks.append(kw)
            elif t == "food" and kw not in foods:
                foods.append(kw)
        if drinks:
            self.drinks = drinks
        if foods:
            self.foods = foods

    async def maybe_survive(self) -> None:
        """Drink/eat to clear thirst/starvation so survival ticks don't cripple
        stats (or kill the crawler). No-op unless a Thirsty/Starving affect is
        actually showing; rate-limited by --survive-cooldown."""
        if self.args.no_survive:
            return
        now = asyncio.get_event_loop().time()
        if (self.drinks and now - self._last_drink > self.args.survive_cooldown
                and any(a in self.affects for a in ("thirsty", "dehydrated", "parched"))):
            kw = self.drinks[0]
            LOG.info(f"survival: thirsty -> drink {kw}")
            await self.send(f"drink {kw}")
            self._last_drink = now
            await asyncio.sleep(self.args.pace)
        if (self.foods and now - self._last_eat > self.args.survive_cooldown
                and any(a in self.affects for a in ("starving", "hungry", "famished"))):
            kw = self.foods[0]
            LOG.info(f"survival: starving -> eat {kw}")
            await self.send(f"eat {kw}")
            self._last_eat = now
            await asyncio.sleep(self.args.pace)

    async def wait_for_room(self, timeout: float) -> Optional[int]:
        """Wait for the next Room.Info; return its num (or None on timeout)."""
        self.room_event.clear()
        try:
            await asyncio.wait_for(self.room_event.wait(), timeout)
            return self.last_room_num
        except asyncio.TimeoutError:
            return None

    # ---- login ------------------------------------------------------------

    def _in_real_room(self) -> bool:
        """True once we are in an actual playable room, not the post-login Void
        staging room (num -1, area 'Nowhere')."""
        if self.current is None or self.current < 0:
            return False
        r = self.world.rooms.get(self.current)
        return r is not None and (r.area or "").lower() not in ("", "nowhere")

    def _login_reply(self, recent: str) -> Optional[str]:
        """Pick the answer for whatever login/character-select prompt is showing.
        Order matters: creation/select prompts before the generic user/pass."""
        P = self._LOGIN
        if P["kick"].search(recent):
            return "y"
        if P["confirm_password"].search(recent) or P["new_password"].search(recent):
            return self.password
        if P["race"].search(recent):
            return self.race
        if P["klass"].search(recent):
            return self.char_class
        if P["name"].search(recent):
            return self.char_name
        if P["press_enter"].search(recent):
            return ""
        if P["password"].search(recent):
            return self.password
        if P["username"].search(recent):
            return self.username
        return None

    async def login(self) -> bool:
        """Answer username/password and the character-select prompts (race/class/
        name from the identity) until we are in a real room. A persistent
        character is re-selected; the Void staging room does not count as in-game."""
        deadline = asyncio.get_event_loop().time() + 90
        last = None
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.5)
            if self._in_real_room():
                return True
            recent = "\n".join(self.block[-10:])
            reply = self._login_reply(recent)
            if reply is not None and (reply, recent) != last:
                LOG.info(f"login: answering prompt -> {reply!r}")
                await self.send(reply)
                last = (reply, recent)
                await asyncio.sleep(0.7)
        return self._in_real_room()

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
        stuck = 0          # consecutive recovery attempts with no reachable frontier
        since_retry = 0    # moves since we last re-opened blocked edges
        while True:
            if moves >= self.args.max_moves or self.world.stats()["rooms_visited"] >= self.args.max_rooms:
                LOG.warning("Hit safety cap; stopping.")
                break

            # If we died mid-crawl the server dumps us in the Shadow Realm. Bail
            # so the supervisor can revive (revive.py) and relaunch with --resume.
            cur = self.world.rooms.get(self.current)
            if cur and "shadow" in (cur.area or "").lower():
                died = self.world.rooms.get(self.last_live_room) if self.last_live_room is not None else None
                if died is not None:
                    LOG.warning(
                        f"In the Shadow Realm (died?). Death site: [{died.num}] "
                        f"{died.name} (area={died.area!r}). Exiting for the supervisor to revive."
                    )
                else:
                    LOG.warning("In the Shadow Realm (died?). Exiting for the supervisor to revive.")
                break

            # Stay alive in survival zones before deciding where to step next.
            await self.maybe_survive()

            frontier = self.world.frontier()
            if not frontier:
                LOG.info("No reachable unvisited rooms left. Graph exhausted from here.")
                break

            # Nearest reachable frontier room from where we stand.
            target, best = None, None
            for t in frontier:
                p = self.world.find_path(self.current, t)
                if p is not None and (best is None or len(p) < len(best)):
                    best, target = p, t

            if best is None:
                # Frontier rooms exist but none reachable from here: a dead-end, a
                # one-way drop, or edges we marked blocked. Try to break out before
                # giving up -- first re-open blocked edges, then recall to a hub.
                if stuck == 0 and self.world.failed_edges:
                    LOG.info("Frontier unreachable; clearing blocked edges to retry them.")
                    self.world.failed_edges.clear()
                    stuck += 1
                    continue
                if stuck <= self.args.recall_tries and await self.recall_home():
                    LOG.info(f"Frontier unreachable; recalled to a hub (try {stuck}).")
                    stuck += 1
                    continue
                LOG.warning(f"{len(frontier)} unvisited rooms remain but none reachable; stopping.")
                break
            stuck = 0

            for direction in best:
                origin = self.current
                await self.send(direction)
                moves += 1
                arrived = await self.wait_for_room(self.args.max_wait)
                if arrived is None or arrived == origin:
                    # Move didn't take (blocked / one-way / in combat / disabled).
                    self.world.failed_edges.add((origin, direction))
                    LOG.debug(f"Edge {origin} --{direction}--> failed; marking blocked.")
                    break
                await asyncio.sleep(self.args.pace)

            # Periodically re-open blocked edges: a door, a guard, or a transient
            # "can't move while in combat" may have cleared since we first hit it.
            since_retry += len(best)
            if self.args.retry_blocked_every and since_retry >= self.args.retry_blocked_every:
                if self.world.failed_edges:
                    LOG.info(f"Retrying {len(self.world.failed_edges)} previously-blocked edges.")
                    self.world.failed_edges.clear()
                since_retry = 0

            s = self.world.stats()
            if s["rooms_visited"] % self.args.save_every == 0:
                self.save()
            LOG.info(
                f"{s['rooms_visited']} visited, {s['rooms_known']} known, "
                f"{s['open_frontier']} frontier"
            )

    async def recall_home(self) -> bool:
        """Recall to a hub (town) and re-establish position; True if we moved.
        Lets the crawl escape a dead-end or one-way drop the BFS can't path out of."""
        origin = self.current
        await self.send("recall")
        arrived = await self.wait_for_room(self.args.max_wait)
        if arrived is None:
            await self.send("look")
            arrived = await self.wait_for_room(self.args.max_wait)
        await asyncio.sleep(self.args.pace)
        return arrived is not None and arrived != origin

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
    data: dict = {}
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
        # Used to answer the post-login character-select / creation prompts.
        "race": data.get("race", ""),
        "char_class": data.get("class", ""),
        "char_name": data.get("character_name", ""),
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
    ap.add_argument("--resume", action="store_true",
                    help="load the existing --output map and continue crawling its frontier")
    ap.add_argument("--retry-blocked-every", type=int, default=250,
                    help="moves between re-opening blocked edges to retry them (0 = never)")
    ap.add_argument("--recall-tries", type=int, default=3,
                    help="recall-to-hub attempts when the frontier is unreachable from here")
    ap.add_argument("--survive-cooldown", type=float, default=8.0,
                    help="seconds between auto drink/eat attempts while thirsty/starving")
    ap.add_argument("--no-survive", action="store_true",
                    help="disable auto drink/eat (let the crawler take survival damage)")
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="[%(asctime)s] [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    config = load_creds(args)
    mapper = GMCPMapper(config, args)
    if args.resume and Path(args.output).exists():
        try:
            mapper.world.load_json(json.loads(Path(args.output).read_text()))
            st = mapper.world.stats()
            LOG.info(f"Resumed {args.output}: {st['rooms_visited']} visited, "
                     f"{st['rooms_known']} known, {st['open_frontier']} frontier")
        except Exception as e:
            LOG.warning(f"Could not resume {args.output}: {e}")
    try:
        asyncio.run(mapper.run())
    except KeyboardInterrupt:
        mapper.save()
        print("\nInterrupted; partial map saved.")


if __name__ == "__main__":
    main()
