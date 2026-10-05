#!/usr/bin/env bash
# Bring this checkout up to date and check it. Run it after every pull, or
# whenever an update comes in. Runs in WSL / Linux / macOS, never from Windows
# (npm there installs Windows binaries that break the app in WSL).
#
#   scripts/update.sh                                 pull, install, settings, database, all checks
#   scripts/update.sh --no-pull                       same without git pull (check local changes)
#   scripts/update.sh --quick                         skip the production build (faster)
#   scripts/update.sh --admin-email you@example.com   put you in ADMIN_EMAILS
#
# Safe to run again and again: installs only when a lockfile, the platform or
# the Node version changed, never overwrites an existing .env, and stops at
# the first failing step with the end of its log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

PULL=1
QUICK=0
ADMIN_EMAIL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull) PULL=0 ;;
    --quick) QUICK=1 ;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 2 ;;
  esac
  shift
done

LOGDIR="${TMPDIR:-/tmp}/agent-social-update"
mkdir -p "$LOGDIR"
STARTED=$(date +%s)

bold() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mnote\033[0m  %s\n' "$*"; }
die() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; exit 1; }

# run "label" cmd...: quiet on success, the end of the log on failure.
run() {
  local label="$1"; shift
  local log="$LOGDIR/$(printf '%s' "$label" | tr -c 'a-zA-Z0-9' '_').log"
  if "$@" >"$log" 2>&1; then
    ok "$label"
  else
    printf '  \033[31mFAIL\033[0m  %s\n' "$label"
    tail -n 40 "$log" | sed 's/^/        /'
    echo "        full log: $log"
    exit 1
  fi
}

rand_hex() { node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"; }
env_get() { grep -E "^$2=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2-; }

# ---------------------------------------------------------------------------
bold "Environment"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) die "Run this inside WSL, not from Windows (npm here would install Windows binaries)." ;;
esac
command -v node >/dev/null || die "node not found: install Node 22 (nvm install 22)"
command -v git >/dev/null || die "git not found"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=6)?0:1)' ||
  die "Node $(node --version) is too old: the site needs 22.6 or newer (nvm install 22)"
ok "node $(node --version), npm $(npm --version)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' ||
  warn "Node 22.13+ silences npm's engine warnings (nvm install 22 && nvm alias default 22)"

# ---------------------------------------------------------------------------
if [ "$PULL" = 1 ]; then
  bold "Pull"
  BEFORE=$(git rev-parse HEAD)
  git pull --ff-only --quiet || die "git pull failed (local changes in the way, or the branch diverged). Commit or stash, then run again."
  AFTER=$(git rev-parse HEAD)
  if [ "$BEFORE" = "$AFTER" ]; then
    ok "already up to date ($(git rev-parse --short HEAD) on $(git branch --show-current))"
  else
    ok "$(git rev-list --count "$BEFORE..$AFTER") new commit(s):"
    git log --oneline "$BEFORE..$AFTER" | head -n 20 | sed 's/^/        /'
  fi
fi

# ---------------------------------------------------------------------------
bold "Dependencies"
# Reinstall when the lockfile, the OS/CPU or the Node ABI changed.
install_deps() {
  local dir="$1"
  local stamp="$dir/node_modules/.update-stamp"
  local want
  want="$(uname -s)-$(uname -m)-abi$(node -p 'process.versions.modules')-$(sha1sum "$dir/package-lock.json" | cut -c1-12)"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
    ok "$dir: up to date"
    return
  fi
  run "$dir: npm ci" bash -c "cd '$dir' && npm ci --no-audit --no-fund --loglevel=error"
  echo "$want" >"$stamp"
}
install_deps "."
install_deps "site"

# ---------------------------------------------------------------------------
bold "Settings"
if [ ! -f worker/.env ]; then
  sed "s/^WORKER_TOKEN=.*/WORKER_TOKEN=$(rand_hex)/" worker/.env.example >worker/.env
  ok "worker/.env created (add GEMINI_API_KEY or ANTHROPIC_API_KEY to turn AI drafting on)"
else
  ok "worker/.env exists"
fi
WORKER_TOKEN=$(env_get worker/.env WORKER_TOKEN)

if [ ! -f site/.env.local ]; then
  cat >site/.env.local <<EOF
# Created by scripts/update.sh. Git-ignored: never commit it (the repo is public).

# TEMPORARY local mode: database in site/.local-db/ (PGlite), local login.
DB_MODE=local
LOCAL_AUTH_SECRET=$(rand_hex)

# Who may sign in to /admin (comma separated).
ADMIN_EMAILS=${ADMIN_EMAIL:-admin@example.com}

# Same value as in worker/.env.
WORKER_TOKEN=$WORKER_TOKEN

# Kill switch: nothing is handed to the worker for publishing unless "true".
SOCIAL_PUBLISHING_ENABLED=false

# Operator company name(s), comma separated, for the "no legal name" check.
SOCIAL_LEGAL_NAMES=

SITE_BASE_URL=http://localhost:3000
EOF
  ok "site/.env.local created (local mode)"
else
  ok "site/.env.local exists"
  if [ -n "$ADMIN_EMAIL" ]; then
    node -e '
      const fs = require("node:fs"); const [file, email] = process.argv.slice(1);
      let text = fs.readFileSync(file, "utf8");
      const m = text.match(/^ADMIN_EMAILS=(.*)$/m);
      const list = (m ? m[1] : "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s && s !== "admin@example.com");
      if (!list.includes(email.toLowerCase())) list.push(email.toLowerCase());
      const line = "ADMIN_EMAILS=" + list.join(",");
      text = m ? text.replace(/^ADMIN_EMAILS=.*$/m, line) : text.trimEnd() + "\n" + line + "\n";
      fs.writeFileSync(file, text);' site/.env.local "$ADMIN_EMAIL"
    ok "ADMIN_EMAILS now includes $ADMIN_EMAIL"
  fi
fi

[ "$(env_get site/.env.local WORKER_TOKEN)" = "$WORKER_TOKEN" ] ||
  warn "WORKER_TOKEN differs between worker/.env and site/.env.local: the worker will get 401 until they match"
case "$(env_get site/.env.local ADMIN_EMAILS)" in
  "" | admin@example.com) warn "ADMIN_EMAILS is still the placeholder: run scripts/update.sh --admin-email you@example.com" ;;
esac
if [ -z "$(env_get worker/.env GEMINI_API_KEY)" ] && [ -z "$(env_get worker/.env ANTHROPIC_API_KEY)" ]; then
  warn "no AI key in worker/.env: the worker will not write drafts (the fake generator still works)"
fi

# ---------------------------------------------------------------------------
bold "Database"
SERVER_RUNNING=0
if [ "$(env_get site/.env.local DB_MODE)" = "local" ]; then
  log="$LOGDIR/db_migrate.log"
  (cd site && npm run -s db:migrate) >"$log" 2>&1
  code=$?
  if [ $code -eq 0 ]; then
    sed 's/^/        /' "$log"
    ok "local database ready (site/.local-db)"
  elif [ $code -eq 3 ]; then
    SERVER_RUNNING=1
    warn "the site is running and holds the database: restart npm run dev to apply new migrations"
  else
    printf '  \033[31mFAIL\033[0m  local database\n'; tail -n 40 "$log" | sed 's/^/        /'; exit 1
  fi
else
  ok "Supabase mode: migrations apply with 'npx supabase db reset' / 'supabase start' in site/"
fi

# ---------------------------------------------------------------------------
bold "Checks: worker"
run "worker: typecheck" bash -c "cd worker && npx --no-install tsc --noEmit"
run "worker: tests" bash -c "cd worker && npm test"

bold "Checks: site"
run "site: typecheck" bash -c "cd site && npm run -s typecheck"
run "site: lint" bash -c "cd site && npm run -s lint"
run "site: tests" bash -c "cd site && npm test"
grep -E '^# (pass|fail) ' "$LOGDIR/site__tests.log" | tr '\n' ' ' | sed 's/^/        /'; echo
if [ "$QUICK" = 1 ]; then
  warn "production build skipped (--quick)"
elif [ "$SERVER_RUNNING" = 1 ]; then
  warn "production build skipped while npm run dev runs (stop it for the full check)"
else
  run "site: production build" bash -c "cd site && npm run -s build"
fi

# ---------------------------------------------------------------------------
bold "Done in $(($(date +%s) - STARTED))s: everything passed"
cat <<'EOF'
  Run it:
    site     cd site && npm run dev                 -> http://localhost:3000/login
    worker   cd worker && npm run dev               (second terminal)
  First time only (with the site stopped):
    cd site && npm run admin:create -- --email you@example.com
  Without an AI key: cd site && npm run social:fake-generator -- --once
EOF
