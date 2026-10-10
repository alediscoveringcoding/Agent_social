#!/usr/bin/env bash
# Start the local stack in WSL/Linux: the site (Next.js dev server, PGlite local
# mode, http://localhost:3000) and the worker (drafts with the real AI provider
# from worker/.env; publishing stays off while WORKER_DRY_RUN=true).
# Ctrl+C stops both.
#
#   bash scripts/dev-local.sh               site + worker
#   bash scripts/dev-local.sh --site-only   site only (use the fake worker/generator)
#
# From Windows: wsl.exe -e bash /mnt/r/Repos/Agent_social/scripts/dev-local.sh
# First time on a machine: bash scripts/update.sh --no-pull --admin-email you@example.com
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --site-only) SITE_ONLY=true ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

fail() { echo "dev-local: $*" >&2; exit 1; }

# npm and node only in Linux: a Windows install writes incompatible binaries.
[ "$(uname -s)" = "Linux" ] || fail "run this in WSL/Linux, not in Windows (Git Bash, PowerShell)."

# A non-interactive shell does not read .bashrc, so load nvm when it is there.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
command -v node >/dev/null || fail "node not found. Install Node 22.6+ (nvm install 22)."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=6)?0:1)' \
  || fail "Node $(node -v) is too old; 22.6+ is required."

[ -f "$ROOT/site/.env.local" ] || fail "site/.env.local is missing. Run: bash scripts/update.sh --no-pull --admin-email you@example.com"
[ -d "$ROOT/site/node_modules" ] || fail "site/node_modules is missing. Run: cd site && npm ci"
if ! $SITE_ONLY; then
  [ -f "$ROOT/worker/.env" ] || fail "worker/.env is missing. Copy worker/.env.example and fill it in."
  [ -d "$ROOT/node_modules" ] || fail "node_modules is missing. Run in the repo root: npm ci"
fi

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
port_busy 3000 && fail "port 3000 is in use: the site is already running (or another app). Stop it first."
if ! $SITE_ONLY && port_busy 8787; then fail "port 8787 is in use: a worker is already running. Stop it first."; fi

env_value() { grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r'; }
echo "Publishing: SOCIAL_PUBLISHING_ENABLED=$(env_value "$ROOT/site/.env.local" SOCIAL_PUBLISHING_ENABLED)"
$SITE_ONLY || echo "Worker:     WORKER_DRY_RUN=$(env_value "$ROOT/worker/.env" WORKER_DRY_RUN) (true = nothing is posted)"

PIDS=()
NAMES=()
# $! is the setsid job itself (the sed in the process substitution is a separate
# process), and setsid execs npm in place, so $! is the pid of the child to watch.
start() { # name, dir, command: own session so Ctrl+C stops npm and its children
  local name="$1" dir="$2"; shift 2
  setsid bash -c 'cd "$1" && shift && exec "$@"' _ "$dir" "$@" \
    > >(sed -u "s/^/[$name] /") 2>&1 &
  PIDS+=("$!")
  NAMES+=("${name%% *}")
}
STOPPING=false
stop() {
  $STOPPING && return 0
  STOPPING=true
  trap '' INT TERM # a second Ctrl+C must not interrupt the shutdown
  echo; echo "Stopping..."
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  echo "Stopped."
}
on_signal() { stop; exit 130; }
trap on_signal INT TERM
trap stop EXIT

start "site  " "$ROOT/site" npm run dev
for _ in $(seq 1 120); do port_busy 3000 && break; sleep 1; done
port_busy 3000 || fail "the site did not start within 120 s (see the [site] lines above)."

$SITE_ONLY || start "worker" "$ROOT/worker" npm run dev

echo
echo "Site:   http://localhost:3000/admin/social (login: http://localhost:3000/login)"
$SITE_ONLY || echo "Worker: health on http://localhost:8787; drafts requested in Genereaza appear in Ciorne"
echo "Ctrl+C stops everything."
echo
# Block until either child exits; then stop everything with a non-zero code.
while :; do
  wait -n "${PIDS[@]}" 2>/dev/null || true
  for i in "${!PIDS[@]}"; do
    if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
      echo "dev-local: ${NAMES[$i]} stopped; stopping everything." >&2
      exit 1 # the EXIT trap runs stop
    fi
  done
done
