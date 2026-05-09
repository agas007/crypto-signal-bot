#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$SCRIPT_DIR}"
PM2_APP_NAME="${PM2_APP_NAME:-crypto-bot}"

cd "$REPO_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repository: $REPO_DIR" >&2
  exit 1
fi

BRANCH="${BRANCH:-$(git branch --show-current)}"

if [[ -z "$BRANCH" ]]; then
  echo "Unable to determine current branch. Set BRANCH=main (or your branch name)." >&2
  exit 1
fi

echo "[deploy] repo: $REPO_DIR"
echo "[deploy] branch: $BRANCH"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "[deploy] working tree is dirty; refusing to pull." >&2
  echo "[deploy] commit/stash local changes first, or override manually if you know what you're doing." >&2
  exit 1
fi

git fetch origin "$BRANCH"
git pull --ff-only origin "$BRANCH"

if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_APP_NAME" --update-env
else
  echo "[deploy] PM2 app '$PM2_APP_NAME' not found; starting it from server.js" >&2
  pm2 start server.js --name "$PM2_APP_NAME" --update-env
fi

pm2 save

echo "[deploy] done"
