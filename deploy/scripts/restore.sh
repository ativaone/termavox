#!/usr/bin/env bash
# Restores the Termdock database from a backup made by backup.sh (plan §13.5).
#
#   1. Takes a safety backup of the current database (when session-manager is running).
#   2. Stops web and session-manager (Caddy answers 502 meanwhile, if it keeps running).
#   3. Streams the backup into the data volume, checks it with PRAGMA integrity_check and swaps
#      it in. The current app.db and its -wal/-shm files are kept in the volume as
#      app.db.pre-restore-<timestamp>[-wal|-shm]; a stale WAL is never replayed over the backup.
#   4. Starts the same containers again (`docker compose start`: nothing is recreated, so the
#      configuration stays exactly as it was) and waits until web and session-manager are
#      healthy. session-manager applies newer migrations, if any.
#
# deploy/secrets/master_key must be the key in use when the backup was taken: with another key
# the daemon refuses to start (vault key check) and stored credentials stay unreadable.
#
# Usage: deploy/scripts/restore.sh [--yes] BACKUP_FILE
#   --yes  do not ask for confirmation (required when stdin is not a terminal)
#
# Environment (optional, for test stacks such as the release smoke; installs leave it unset):
#   TERMDOCK_BACKUP_DIR        where the safety backup goes instead of deploy/backups/
#   TERMDOCK_COMPOSE_OVERRIDE  a compose file applied on top of deploy/compose.yaml
#   (the stack's project name comes from COMPOSE_PROJECT_NAME, which docker compose reads itself)
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
deploy_dir=$(dirname -- "$script_dir")
backup_dir=${TERMDOCK_BACKUP_DIR:-"$deploy_dir/backups"}

die() {
  printf 'restore: %s\n' "$*" >&2
  exit 1
}

yes=0
file=
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown option: $arg (see --help)" ;;
    *)
      [[ -z "$file" ]] || die "only one backup file can be restored"
      file=$arg
      ;;
  esac
done
[[ -n "$file" ]] || die "usage: restore.sh [--yes] BACKUP_FILE"
[[ -f "$file" && -r "$file" ]] || die "cannot read $file"
[[ "$(head -c 15 -- "$file")" == "SQLite format 3" ]] || die "$file is not a SQLite database"

compose_files=(-f "$deploy_dir/compose.yaml")
if [[ -n "${TERMDOCK_COMPOSE_OVERRIDE:-}" ]]; then
  compose_files+=(-f "$TERMDOCK_COMPOSE_OVERRIDE")
fi
compose() { docker compose "${compose_files[@]}" "$@"; }

running=$(compose ps --status running --services 2>/dev/null || true)
daemon_running=0
if grep -qx session-manager <<<"$running"; then daemon_running=1; fi

cat >&2 <<EOF
This replaces the Termdock database with:
  $file ($(wc -c <"$file" | tr -d ' ') bytes)
web and session-manager stop for the duration: open browser tabs disconnect, protected
sessions are restored when session-manager starts again.
EOF
if ((daemon_running == 0)); then
  printf '\nsession-manager is not running: no safety backup of the current database can be taken\n(the current files are still kept in the volume as app.db.pre-restore-<timestamp>).\n' >&2
fi
if ((yes == 0)); then
  [[ -t 0 ]] || die "stdin is not a terminal; pass --yes to confirm"
  read -r -p 'Type "restore" to continue: ' answer
  [[ "$answer" == "restore" ]] || die "aborted"
fi

if ((daemon_running == 1)); then
  printf 'restore: safety backup of the current database\n' >&2
  safety=$("$script_dir/backup.sh" "$backup_dir")
  printf 'restore: safety backup: %s\n' "$safety" >&2
fi

# Waits until web and session-manager report healthy (`compose start` has no --wait).
wait_healthy() {
  local deadline=$((SECONDS + 180)) svc id status ready
  while ((SECONDS < deadline)); do
    ready=1
    for svc in session-manager web; do
      id=$(compose ps -q "$svc" 2>/dev/null || true)
      status=missing
      if [[ -n "$id" ]]; then
        status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")
      fi
      [[ "$status" == healthy ]] || ready=0
    done
    ((ready == 1)) && return 0
    sleep 2
  done
  return 1
}

stopped=0
swapped=0
on_exit() {
  local code=$?
  if ((code != 0 && stopped == 1 && swapped == 0)); then
    printf 'restore: failed before the swap; starting the services again on the current database\n' >&2
    compose start >&2 || true
  fi
}
trap on_exit EXIT

compose stop web session-manager >&2
stopped=1

stamp=$(date -u +%Y%m%dT%H%M%SZ)
# Runs as the daemon's user (UID 10001) in a one-off session-manager container, from
# /app/packages/db where better-sqlite3 resolves. stdin: the backup. argv[1]: the timestamp.
read -r -d '' restore_js <<'JS' || true
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const Database = require('better-sqlite3');
(async () => {
  const stamp = process.argv[1];
  const dir = process.env.TERMDOCK_DATA_DIR || '/data';
  const db = path.join(dir, 'app.db');
  const incoming = path.join(dir, '.termdock-restore-' + stamp + '.db');
  const removeIncoming = () => {
    for (const s of ['', '-wal', '-shm']) fs.rmSync(incoming + s, { force: true });
  };
  await pipeline(process.stdin, fs.createWriteStream(incoming, { mode: 0o600 }));
  const check = new Database(incoming, { fileMustExist: true });
  const result = check.pragma('integrity_check', { simple: true });
  check.close();
  if (result !== 'ok') {
    removeIncoming();
    throw new Error('integrity_check failed: ' + result);
  }
  console.error('integrity_check: ok');
  for (const s of ['', '-wal', '-shm']) {
    if (fs.existsSync(db + s)) fs.renameSync(db + s, db + '.pre-restore-' + stamp + s);
  }
  fs.renameSync(incoming, db);
  removeIncoming();
  console.error('swapped in; previous files kept as ' + db + '.pre-restore-' + stamp + '[-wal|-shm]');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
JS

printf 'restore: streaming the backup into the data volume\n' >&2
compose run --rm --no-deps -T --workdir /app/packages/db --entrypoint node session-manager \
  -e "$restore_js" "$stamp" <"$file" >&2
swapped=1

printf 'restore: starting the stack again\n' >&2
if ! compose start >&2 || ! wait_healthy; then
  cat >&2 <<EOF
restore: web and session-manager did not become healthy on the restored database.
  Check: docker compose -f deploy/compose.yaml logs session-manager
  A wrong master key shows up as a vault key check failure at boot.
EOF
  if [[ -n "${safety:-}" ]]; then
    printf '  Roll back with: %s --yes %s\n' "$0" "$safety" >&2
  fi
  exit 1
fi
printf 'restore: done; the restored database is live\n' >&2
