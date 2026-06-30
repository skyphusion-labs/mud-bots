#!/usr/bin/env bash
# Deploy the mud-bots fleet: rsync the repo to each GPU box and restart its bot
# services. Runs from anywhere with SSH access to the boxes -- a laptop, or
# a CI host via the 'mudbots-deploy' key. Idempotent; safe to re-run.
#
# SSH note: the deploy host needs key-based SSH reach to each target box. If
# public :22 is closed, run from a host on the boxes' private network. Set
# MUDBOTS_HOSTS to your target boxes.
#
# Usage:  ./deploy.sh                # all configured boxes (MUDBOTS_HOSTS)
#         ./deploy.sh <box>         # one box
#
# Per-box bots are systemd --user units (linger on): we restart whatever
# hollowbot@*, discordbot, and pwbot instances are enabled there. Code,
# character identities, the Python venv and logs all live under ~/dev/bots on the
# box; we never sync secrets or state back (see EXCLUDES), and --delete only
# prunes tracked code, not those excluded paths.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$#" -gt 0 ]; then BOXES=("$@"); else BOXES=(${MUDBOTS_HOSTS:-}); fi

EXCLUDES=(
  --exclude .git --exclude __pycache__ --exclude .claude
  --exclude .venv --exclude '*.log' --exclude '*.jsonl'
  --exclude samples --exclude '*_identity.json' --exclude bot_identity.json
)
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
# Jenkins passes a deploy key via MUDBOTS_SSH_KEY (withCredentials); a laptop run
# leaves it unset and uses the user's ssh-agent / default key.
[ -n "${MUDBOTS_SSH_KEY:-}" ] && SSH_OPTS+=(-i "$MUDBOTS_SSH_KEY")
RSH="ssh ${SSH_OPTS[*]}"

for host in "${BOXES[@]}"; do
  echo ">>> [$host] rsync code"
  rsync -az -e "$RSH" --delete "${EXCLUDES[@]}" "$REPO_DIR"/ "ubuntu@$host:/home/ubuntu/dev/bots/"

  echo ">>> [$host] rolling-restart bot services"
  ssh "${SSH_OPTS[@]}" "ubuntu@$host" 'bash -s' <<'REMOTE'
export XDG_RUNTIME_DIR="/run/user/$(id -u)"   # systemctl --user needs this over SSH

# Install/update discord bot node_modules when package-lock.json is present
if [ -f ~/dev/bots/discord/package-lock.json ]; then
  echo "  npm ci (discord/)"
  (cd ~/dev/bots/discord && npm ci --omit=dev --silent)
fi

units=$(systemctl --user list-units --no-legend --plain 'hollowbot@*.service' 'pwbot.service' 'discordbot.service' 2>/dev/null | awk '{print $1}')
if [ -z "$units" ]; then echo "  no bot units found"; exit 0; fi
for u in $units; do systemctl --user restart "$u"; sleep 2; done   # one at a time, keep the world populated
echo "  restarted:" $units
echo -n "  active:   "; systemctl --user is-active $units | paste -sd' '
REMOTE
done
echo ">>> fleet deploy complete"
