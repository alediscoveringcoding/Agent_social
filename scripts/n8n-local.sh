#!/usr/bin/env bash
# Run n8n (workflow automation) in WSL/Linux, without Docker, next to the site.
# n8n only talks to the site's automation API: it creates generation requests
# (drafts), reads events and logs runs. It never approves or publishes.
#
#   bash scripts/n8n-local.sh            start n8n at http://127.0.0.1:5678 (Ctrl+C stops it)
#   bash scripts/n8n-local.sh --import   import every workflow in n8n/workflows, then exit
#   bash scripts/n8n-local.sh --help
#
# n8n data (database, encrypted credentials) lives in ~/.agent-social-n8n, never
# in this repository. Stop n8n before --import; importing replaces workflows
# that have the same id (edits made in the editor are lost) and leaves them
# inactive. Steps and costs: n8n/README.md.
# From Windows: wsl.exe -e bash /mnt/r/Repos/Agent_social/scripts/n8n-local.sh
set -euo pipefail

# Pinned: the newest release that is at least 14 days old (1.123.82, 2026-09-25)
# and runs on Node 22. Every n8n 2.x from 2.9 on needs Node 22.16+ and the
# current ones Node 24, which this machine does not have. The workflows in
# n8n/workflows only use node versions that exist in this release.
N8N_VERSION="1.123.82"
PORT=5678

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMPORT=false
for arg in "$@"; do
  case "$arg" in
    --import) IMPORT=true ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

fail() { echo "n8n-local: $*" >&2; exit 1; }

# npm and node only in Linux: a Windows install writes incompatible binaries.
[ "$(uname -s)" = "Linux" ] || fail "run this in WSL/Linux, not in Windows (Git Bash, PowerShell)."

# A non-interactive shell does not read .bashrc, so load nvm when it is there.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
command -v node >/dev/null || fail "node not found. Install Node 22 (nvm install 22)."
command -v npx >/dev/null || fail "npx not found. It comes with npm; reinstall Node 22 (nvm install 22)."
# n8n $N8N_VERSION declares node >=20.19 <=24.x.
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a>20&&a<=24)||(a===20&&b>=19)?0:1)' \
  || fail "Node $(node -v) is not supported by n8n $N8N_VERSION (needs 20.19 up to 24.x). Use Node 22: nvm install 22 && nvm use 22."

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if port_busy "$PORT"; then
  fail "port $PORT is in use: n8n is probably already running (open http://127.0.0.1:$PORT) or another app holds it. Stop it first."
fi

# Everything n8n writes goes to the user folder in $HOME, not into this checkout.
export N8N_USER_FOLDER="$HOME/.agent-social-n8n"
mkdir -p "$N8N_USER_FOLDER"
chmod 700 "$N8N_USER_FOLDER" 2>/dev/null || true
cd "$N8N_USER_FOLDER"

# Local only: reachable from this machine (WSL forwards localhost to Windows).
export N8N_HOST=127.0.0.1
export N8N_PORT="$PORT"
export N8N_LISTEN_ADDRESS=127.0.0.1
export N8N_PROTOCOL=http
export N8N_SECURE_COOKIE=false # http on loopback; the cookie would not stick otherwise
export GENERIC_TIMEZONE=Europe/Bucharest
export TZ=Europe/Bucharest
# No telemetry, update checks, hiring banner or template calls.
export N8N_DIAGNOSTICS_ENABLED=false
export N8N_VERSION_NOTIFICATIONS_ENABLED=false
export N8N_PERSONALIZATION_ENABLED=false
export N8N_HIRING_BANNER_ENABLED=false
export N8N_TEMPLATES_ENABLED=false
# Task runners are off by default in 1.123; the Code nodes run in-process and read
# workflow static data (the events cursor). Revisit this on an upgrade to n8n 2.
export N8N_RUNNERS_ENABLED=false
# Code nodes cannot read this process's environment; keep the settings file private.
export N8N_BLOCK_ENV_ACCESS_IN_NODE=true
export N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true
# Keep the database small: the events workflow runs every 5 minutes.
export EXECUTIONS_DATA_PRUNE=true
export EXECUTIONS_DATA_MAX_AGE=168

if $IMPORT; then
  [ -d "$ROOT/n8n/workflows" ] || fail "$ROOT/n8n/workflows is missing."
  ls "$ROOT"/n8n/workflows/*.json >/dev/null 2>&1 || fail "no workflow files in $ROOT/n8n/workflows."
  echo "Importing the workflows in n8n/workflows with n8n $N8N_VERSION (the first run downloads n8n: several minutes)..."
  if ! npx --yes "n8n@$N8N_VERSION" import:workflow --separate --input="$ROOT/n8n/workflows"; then
    echo >&2
    echo "n8n-local: the import failed. If the message says it could not find the owner, start n8n once" >&2
    echo "(bash scripts/n8n-local.sh), create the owner account in the browser, stop it with Ctrl+C and run --import again." >&2
    exit 1
  fi
  cat <<EOF

Imported (inactive). Next:
  bash scripts/n8n-local.sh        start n8n, then open http://127.0.0.1:$PORT
  If a node still shows a missing credential after you create them, stop n8n and run --import again
  (it matches credentials by name), before you edit the Config nodes.
EOF
  exit 0
fi

port_busy 3000 || echo "note: nothing answers on port 3000 yet: start the site (bash scripts/dev-local.sh --site-only); the workflows call it."

cat <<EOF
n8n $N8N_VERSION  ->  http://127.0.0.1:$PORT   (data: $N8N_USER_FOLDER)
The first start downloads n8n and takes several minutes. Next steps:
  1. Open the URL and create the owner account (it stays on this machine).
  2. Credentials -> Create credential, with exactly these names:
       Header Auth  "Agent Social automation"  header name: Authorization
                    value: Bearer <N8N_AUTOMATION_TOKEN from site/.env.local>
       SMTP         "Agent Social SMTP"        your mail server, user and password
  3. Open each workflow, edit its Config node, check the credential on the HTTP and Send Email nodes.
  4. Turn on the Active toggle of the workflows you want (all are inactive after the import).
Workflows run only while this terminal runs. Ctrl+C stops n8n. Guide: n8n/README.md
EOF

exec npx --yes "n8n@$N8N_VERSION" start
