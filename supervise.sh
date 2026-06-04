#!/usr/bin/env bash
# Self-sustaining LLM player for Packet Wastes.
#
# Loops forever: revive (if the character is downed in the Shadow Realm, idle
# until the Guide heals it and recall to town) -> play (run bot.py and let the
# LLM run wild in the open world) -> on death, stop and revive again.
#
# Config via env: MUD_IDENTITY_FILE (default bot_identity.json = Strider868),
# MUD_MODEL. Run detached:  setsid ./supervise.sh &
set -u
cd "$(dirname "$0")"

IDENT="${MUD_IDENTITY_FILE:-bot_identity.json}"
MODEL="${MUD_MODEL:-qwen3:30b-a3b-instruct-2507-q4_K_M}"
PY=.venv/bin/python
# Per-identity tag so multiple supervisors don't clobber each other's logs.
TAG="${TAG:-$(basename "$IDENT" .json)}"
SLOG="supervise_$TAG.log"
PLOG="play_$TAG.log"
RLOG="revive_$TAG.log"
BUG="bug_reports_$TAG.jsonl"

log() { echo "[$(date '+%F %T')] $*" >> "$SLOG"; }

log "=== supervisor start (identity=$IDENT, tag=$TAG) ==="
while true; do
    # --- REVIVE phase (no-op if already alive and out of the shadow realm) ---
    log "revive phase"
    $PY revive.py --creds "$IDENT" >> "$RLOG" 2>&1
    log "revive phase done"

    # --- PLAY phase: LLM runs wild until the character dies ---
    log "starting play bot"
    env MUD_MODEL="$MODEL" MUD_IDENTITY_FILE="$IDENT" MUD_BUG_FILE="$BUG" \
        $PY bot.py > "$PLOG" 2>&1 &
    BOT=$!

    # Watch for death (the Shadow Realm waiting room text) or the bot exiting.
    while kill -0 "$BOT" 2>/dev/null; do
        if grep -qiE 'too weak to leave|already dead|\[Shadow Realm\]' "$PLOG"; then
            log "death detected -> stopping bot to revive"
            kill "$BOT" 2>/dev/null
            wait "$BOT" 2>/dev/null
            break
        fi
        sleep 20
    done
    log "play phase ended; looping back to revive"
    sleep 3
done
