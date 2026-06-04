"""Render a crawled Packet Wastes map (map.json from mapper.py) as a PNG.

Each room carries grid coordinates ("Area, x, y, z") and exits (direction ->
room id), so we plot rooms at their (x, -y) position, draw a line for every exit
that lands on another mapped room, and color nodes by area. Pure geometry, no
LLM. Requires matplotlib.

    python3 render_map.py samples/map_world.json samples/map_world.png
"""
import json
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D


def parse_coords(s):
    if not s:
        return None
    parts = [p.strip() for p in str(s).split(",")]
    try:
        return tuple(int(p) for p in parts[-3:])  # x, y, z
    except ValueError:
        return None


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "map_world.json"
    out = sys.argv[2] if len(sys.argv) > 2 else "map_world.png"
    m = json.load(open(path))
    rooms = m.get("rooms", m)

    pos = {}            # room id (int) -> (x, y, z)
    meta = {}           # room id (int) -> room dict
    for rid, r in rooms.items():
        xyz = parse_coords(r.get("coords"))
        if xyz is not None:
            pos[int(rid)] = xyz
            meta[int(rid)] = r
    if not pos:
        print("No rooms with coordinates to plot.")
        return

    fig, ax = plt.subplots(figsize=(18, 18))

    # Exit edges (drawn first, under the nodes).
    for rid, (x, y, z) in pos.items():
        for _dir, tgt in (meta[rid].get("exits") or {}).items():
            t = pos.get(int(tgt)) if str(tgt).lstrip("-").isdigit() else None
            if t is not None:
                ax.plot([x, t[0]], [-y, -t[1]], color="#b0b0b0", lw=0.6, zorder=1)

    # Nodes colored by area.
    areas = sorted({meta[i].get("area") or "?" for i in pos})
    cmap = plt.get_cmap("tab20")
    acolor = {a: cmap(i % 20) for i, a in enumerate(areas)}
    xs, ys, cs = [], [], []
    for rid, (x, y, z) in pos.items():
        xs.append(x); ys.append(-y); cs.append(acolor[meta[rid].get("area") or "?"])
    ax.scatter(xs, ys, c=cs, s=55, zorder=2, edgecolors="black", linewidths=0.4)

    # Mark the start room.
    start = m.get("start")
    if isinstance(start, dict):
        start = start.get("num")
    if start is not None and int(start) in pos:
        sx, sy, _ = pos[int(start)]
        ax.scatter([sx], [-sy], s=240, marker="*", color="gold",
                   edgecolors="black", linewidths=0.8, zorder=3, label="start")

    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title(f"Packet Wastes - {len(pos)} rooms mapped (zero-LLM GMCP crawl)",
                 fontsize=16)
    handles = [Line2D([0], [0], marker="o", color="w", markerfacecolor=acolor[a],
                      markeredgecolor="black", label=a, markersize=9) for a in areas]
    ax.legend(handles=handles, loc="upper right", fontsize=9, framealpha=0.9)

    plt.tight_layout()
    plt.savefig(out, dpi=130, bbox_inches="tight")
    print(f"Saved {out}: {len(pos)} rooms, {len(areas)} area(s)")


if __name__ == "__main__":
    main()
