#!/usr/bin/env bash
# Self-sustaining world mapper for Packet Wastes.
#
# Loops forever: revive (if the character died and is downed in the Shadow
# Realm, idle until it can leave, then portal/recall out) -> map (crawl the
# GMCP room graph with mapper.py --resume until death, disconnect, or the
# reachable graph is exhausted). Every life resumes the same map file, so
# coverage only ever grows. This is the "how far can we map" harness.
#
# Config via env:
#   MUD_IDENTITY_FILE  creds json with username/password (default ai_map2_identity.json)
#   MAP_OUTPUT         map file to accumulate into        (default map_world.json)
# Run detached:  setsid ./supervise_map.sh &
set -u
cd "$(dirname "$0")"

IDENT="${MUD_IDENTITY_FILE:-ai_map2_identity.json}"
OUT="${MAP_OUTPUT:-map_world.json}"
PY=.venv/bin/python
TAG="${TAG:-map_$(basename "$IDENT" .json)}"
SLOG="supervise_$TAG.log"
MLOG="mapper_$TAG.log"
RLOG="revive_$TAG.log"

log() { echo "[$(date '+%F %T')] $*" >> "$SLOG"; }
log "=== map supervisor start (identity=$IDENT, out=$OUT) ==="

while true; do
    # --- REVIVE phase (no-op if alive and out of the Shadow Realm) ---
    log "revive phase"
    $PY revive.py --creds "$IDENT" >> "$RLOG" 2>&1
    log "revive phase done"

    # --- MAP phase: crawl until the character dies / drops / runs out of frontier ---
    log "starting mapper"
    MUD_IDENTITY_FILE="$IDENT" \
        $PY mapper.py --creds "$IDENT" --resume --output "$OUT" >> "$MLOG" 2>&1
    rc=$?
    log "mapper exited (rc=$rc); looping back to revive"
    sleep 5
done
