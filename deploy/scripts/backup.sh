#!/usr/bin/env bash
# Online backup of the Termdock database (plan §13.5). Safe while everything is running:
# SQLite's `VACUUM INTO` writes a consistent, compacted copy inside the session-manager
# container (node + better-sqlite3), `PRAGMA integrity_check` verifies it, and the copy is
# streamed to a timestamped file on the host.
#
# The backup holds password hashes and encrypted credentials, never the master key: back up
# deploy/secrets/master_key separately (a database backup is useless without it).
#
# Usage: deploy/scripts/backup.sh [DEST_DIR]
#   DEST_DIR  host directory for the backup (default: deploy/backups; created with mode 0700)
# Prints the path of the new file (mode 0600) on stdout; progress goes to stderr.
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
deploy_dir=$(dirname -- "$script_dir")

die() {
  printf 'backup: %s\n' "$*" >&2
  exit 1
}

case "${1:-}" in
  -h | --help)
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
    exit 0
    ;;
esac
(($# <= 1)) || die "too many arguments (see --help)"
dest_dir=${1:-"$deploy_dir/backups"}

compose() { docker compose -f "$deploy_dir/compose.yaml" "$@"; }

compose ps --status running --services 2>/dev/null | grep -qx session-manager ||
  die "session-manager is not running (start the stack first)"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
remote="/data/.termdock-backup-$stamp.db"
mkdir -p -m 0700 -- "$dest_dir"
out="$dest_dir/termdock-$stamp.db"
[[ ! -e "$out" ]] || die "$out already exists"

cleanup() {
  compose exec -T session-manager rm -f -- "$remote" "$remote-wal" "$remote-shm" \
    >/dev/null 2>&1 || true
  rm -f -- "$out.partial"
}
trap cleanup EXIT

# Runs inside the container from /app/packages/db, where better-sqlite3 resolves.
# argv[1]: the in-volume path of the copy.
read -r -d '' backup_js <<'JS' || true
const path = require('node:path');
const Database = require('better-sqlite3');
const out = process.argv[1];
const src = path.join(process.env.TERMDOCK_DATA_DIR || '/data', 'app.db');
const db = new Database(src, { fileMustExist: true, timeout: 10000 });
try {
  db.prepare('VACUUM INTO ?').run(out);
} finally {
  db.close();
}
const copy = new Database(out, { fileMustExist: true });
const result = copy.pragma('integrity_check', { simple: true });
copy.close();
if (result !== 'ok') {
  console.error('integrity_check failed: ' + result);
  process.exit(1);
}
console.error('integrity_check: ok');
JS

printf 'backup: VACUUM INTO %s (inside session-manager)\n' "$remote" >&2
compose exec -T --workdir /app/packages/db session-manager node -e "$backup_js" "$remote" >&2

compose exec -T session-manager cat -- "$remote" >"$out.partial"
[[ "$(head -c 15 -- "$out.partial")" == "SQLite format 3" ]] ||
  die "the copied file is not a SQLite database"
mv -- "$out.partial" "$out"

printf 'backup: wrote %s (%s bytes)\n' "$out" "$(wc -c <"$out" | tr -d ' ')" >&2
printf '%s\n' "$out"
