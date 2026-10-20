#!/usr/bin/env bash
# Rotates the vault master key of a Compose install (plan §10.2): every stored credential is
# re-encrypted under a new key, and session-manager starts again on it.
#
#   1. Generates deploy/secrets/master_key.new: 32 random bytes, base64, group 10001, mode 0440,
#      as init-secrets.sh does.
#   2. Stops session-manager. Protected sessions are restored when it starts again; unprotected
#      ones end. web keeps running.
#   3. Runs `vault rotate` in a one-off session-manager container (the same image, user and data
#      volume; the current and the new key mounted read-only). It verifies the current key,
#      writes a backup next to the database (/data/pre-rotate-<UTC timestamp>.db), and
#      re-encrypts every credential and the vault key check in one transaction: all or nothing.
#   4. On success: keeps the old key as deploy/secrets/master_key.old (mode 0400), installs the
#      new key as master_key, copies the backup to deploy/backups/, and starts session-manager,
#      which verifies the new key at boot. On failure: the database and master_key stay as they
#      were, session-manager starts again on the current key, and the script exits non-zero.
#
# Keep master_key.old until session-manager works with the new key, then delete it together
# with the pre-rotate backup (only the old key opens it; so do older backups, see the install
# guide). The script refuses to run while master_key.new or master_key.old exists.
#
# Usage: deploy/scripts/rotate-master-key.sh [--yes]
#   --yes  do not ask for confirmation (required when stdin is not a terminal)
#
# Environment (optional, for test stacks such as the release smoke; installs leave it unset):
#   TERMDOCK_SECRETS_DIR       the secrets directory instead of deploy/secrets/
#   TERMDOCK_BACKUP_DIR        where the pre-rotate backup is copied instead of deploy/backups/
#   TERMDOCK_COMPOSE_OVERRIDE  compose files applied on top of deploy/compose.yaml, in order,
#                              separated by ":" (one file, or e.g. a.yaml:b.yaml)
#   (the stack's project name comes from COMPOSE_PROJECT_NAME, which docker compose reads itself)
set -euo pipefail
umask 077

readonly CONTAINER_GID=10001
# Where the one-off container sees the new key: beside the compose secret it replaces.
readonly NEW_KEY_IN_CONTAINER=/run/secrets/master_key.new

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
deploy_dir=$(dirname -- "$script_dir")
compose_file="$deploy_dir/compose.yaml"
secrets_dir=${TERMDOCK_SECRETS_DIR:-"$deploy_dir/secrets"}
backup_dir=${TERMDOCK_BACKUP_DIR:-"$deploy_dir/backups"}
key="$secrets_dir/master_key"
new_key="$key.new"
old_key="$key.old"

die() {
  printf 'rotate-master-key: %s\n' "$*" >&2
  exit 1
}

say() {
  printf 'rotate-master-key: %s\n' "$*" >&2
}

yes=0
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $arg (see --help)" ;;
  esac
done

command -v openssl >/dev/null 2>&1 || die "openssl is required"
command -v docker >/dev/null 2>&1 || die "docker is required"

compose_files=(-f "$compose_file")
if [[ -n "${TERMDOCK_COMPOSE_OVERRIDE:-}" ]]; then
  IFS=: read -r -a compose_overrides <<<"$TERMDOCK_COMPOSE_OVERRIDE"
  for override in "${compose_overrides[@]}"; do
    if [[ -n "$override" ]]; then compose_files+=(-f "$override"); fi
  done
fi
compose() { docker compose "${compose_files[@]}" "$@"; }

# `vault rotate` in a one-off container; extra arguments go to the CLI (e.g. --dry-run).
run_rotate() {
  compose run --rm --no-deps -T --volume "$new_key:$NEW_KEY_IN_CONTAINER:ro" \
    --entrypoint node session-manager src/cli/vault-rotate.ts \
    --old-key-file /run/secrets/master_key --new-key-file "$NEW_KEY_IN_CONTAINER" "$@"
}

[[ -f "$key" ]] || die "no master key at $key (run deploy/scripts/init-secrets.sh first)"
if [[ -e "$old_key" ]]; then
  die "$old_key exists: an earlier rotation kept the old key there.
  Once session-manager works with the current key, delete it (and that rotation's
  $backup_dir/pre-rotate-*.db, which only the old key opens), then run this again."
fi
if [[ -e "$new_key" ]]; then
  die "$new_key exists: an earlier rotation did not finish. Find out which key the
  database uses, with session-manager stopped:
    docker compose -f $compose_file stop session-manager
    docker compose -f $compose_file run --rm --no-deps -T \\
      --volume $new_key:$NEW_KEY_IN_CONTAINER:ro --entrypoint node session-manager \\
      src/cli/vault-rotate.ts --dry-run \\
      --old-key-file /run/secrets/master_key --new-key-file $NEW_KEY_IN_CONTAINER
  Exit status 0 or 4: the database still uses master_key. Delete $new_key,
  start session-manager again and run this script again.
  Exit status 3 (\"already uses the new key\"): the database uses master_key.new. Finish by hand:
    ln $key $old_key && mv $new_key $key && chmod 0400 $old_key
    docker compose -f $compose_file start session-manager"
fi
[[ -n "$(compose ps --all --quiet session-manager 2>/dev/null)" ]] ||
  die "there is no session-manager container: start the stack once first (docker compose -f $compose_file up -d)"

cat >&2 <<EOF
This rotates the vault master key: every stored credential is re-encrypted under a new key.
session-manager stops meanwhile: open terminals disconnect, protected sessions are restored
when it starts again, unprotected sessions end.
EOF
if ((yes == 0)); then
  [[ -t 0 ]] || die "stdin is not a terminal; pass --yes to confirm"
  read -r -p 'Type "rotate" to continue: ' answer
  [[ "$answer" == "rotate" ]] || die "aborted"
fi

# Group 10001 on the new key, as init-secrets.sh does it: a plain chgrp, a throwaway root
# container from the pinned base image (no network), then sudo.
set_group() {
  local file=$1 image
  if chgrp -- "$CONTAINER_GID" "$file" 2>/dev/null; then
    return 0
  fi
  if docker info >/dev/null 2>&1; then
    image=$(sed -n 's/^FROM \(node:[^ ]*@sha256:[0-9a-f]\{64\}\).*/\1/p' \
      "$deploy_dir/docker/session-manager.Dockerfile" | head -n 1)
    if [[ -n "$image" ]]; then
      say "setting group $CONTAINER_GID through a throwaway root container (${image%%@*})"
      if docker run --rm --network none --user 0:0 --entrypoint chgrp \
        --volume "$secrets_dir:/secrets" "$image" "$CONTAINER_GID" "/secrets/$(basename -- "$file")"; then
        return 0
      fi
    fi
  fi
  if command -v sudo >/dev/null 2>&1 && [[ -t 0 ]]; then
    say "setting group $CONTAINER_GID needs root; running sudo chgrp"
    sudo chgrp -- "$CONTAINER_GID" "$file" && return 0
  fi
  return 1
}

# Waits until session-manager reports healthy (`compose start` has no --wait).
wait_healthy() {
  local deadline=$((SECONDS + 180)) id status
  while ((SECONDS < deadline)); do
    id=$(compose ps --quiet session-manager 2>/dev/null || true)
    status=missing
    if [[ -n "$id" ]]; then
      status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing)
    fi
    [[ "$status" == healthy ]] && return 0
    sleep 2
  done
  return 1
}

# Where things stand, for the exit trap: generated → stopped → rotated → swapped → done.
stage=init
tmp=
report=$(mktemp)
on_exit() {
  local code=$?
  rm -f -- "$report" ${tmp:+"$tmp"}
  ((code == 0)) && return 0
  case $stage in
    generated)
      # Never used: nothing else changed.
      rm -f -- "$new_key"
      ;;
    stopped)
      cat >&2 <<EOF
rotate-master-key: interrupted while vault rotate ran: the database may use either key, so
$new_key is kept. Run this script again for the steps that tell which key it uses.
EOF
      compose start session-manager >&2 || true
      ;;
    rotated)
      cat >&2 <<EOF
rotate-master-key: the database now uses $new_key, but the key files were not swapped.
Finish by hand:
  ln $key $old_key && mv $new_key $key && chmod 0400 $old_key
  docker compose -f $compose_file start session-manager
EOF
      ;;
    swapped)
      cat >&2 <<EOF
rotate-master-key: interrupted after the swap: the database and $key use the new key,
$old_key holds the old one. Start session-manager with:
  docker compose -f $compose_file start session-manager
EOF
      ;;
  esac
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

# ── 1. the new key ───────────────────────────────────────────────────────────
tmp="$secrets_dir/.master_key.new.tmp.$$"
openssl rand -base64 32 >"$tmp" # 32 bytes, as the vault expects
# A hard link creates the name exclusively: an existing master_key.new is never overwritten.
if ! ln -- "$tmp" "$new_key" 2>/dev/null; then
  rm -f -- "$tmp"
  die "cannot create $new_key"
fi
rm -f -- "$tmp"
stage=generated
# Run with sudo: hand the file back to the invoking user, like the other secrets.
if [[ $EUID -eq 0 && -n "${SUDO_UID:-}" ]]; then
  chown -- "$SUDO_UID" "$new_key"
fi
if ! set_group "$new_key"; then
  die "group $CONTAINER_GID could not be set on $new_key (needs root), so the containers
  could not read it. Run this script with sudo or as a member of group $CONTAINER_GID.
  Nothing was changed."
fi
chmod 0440 -- "$new_key"

# ── 2. stop the daemon ───────────────────────────────────────────────────────
say "stopping session-manager"
compose stop session-manager >&2
stage=stopped

# ── 3. re-encrypt ────────────────────────────────────────────────────────────
say "re-encrypting the vault in a one-off session-manager container"
set +e
run_rotate | tee "$report" >&2
code=${PIPESTATUS[0]}
set -e

restart_on_current_key() {
  say "starting session-manager again on the current key"
  compose start session-manager >&2 || return 1
  wait_healthy
}

if ((code == 0)); then
  stage=rotated
else
  # Trust the database, not the exit status: a dry run tells which key its key check matches.
  say "vault rotate failed (exit status $code); checking which key the database uses"
  set +e
  run_rotate --dry-run >&2
  check=$?
  set -e
  case $check in
    0 | 4)
      rm -f -- "$new_key"
      stage=done
      restart_on_current_key || say "warning: session-manager did not become healthy; check its logs"
      die "the rotation failed (exit status $code) and nothing was changed: the database and
  $key are as before."
      ;;
    3)
      say "the database already uses the new key: finishing the rotation"
      stage=rotated
      ;;
    *)
      stage=done
      restart_on_current_key || true
      die "the rotation failed (exit status $code) and the check failed too (exit status $check):
  it is not clear which key the database uses, so $new_key is kept.
  Read the messages above, then run this script again for the steps that tell which key it uses."
      ;;
  esac
fi

# ── 4. swap the key files ────────────────────────────────────────────────────
# A hard link keeps the old key while master_key is replaced in one rename: at every moment
# master_key exists, holding the old key until the database's new one takes its place.
ln -- "$key" "$old_key"
mv -f -- "$new_key" "$key"
chmod 0400 -- "$old_key"
stage=swapped

# The pre-rotate backup, out of the volume, where restore.sh can take it.
backup_in_volume=$(sed -n 's/^backup: //p' "$report" | tail -n 1)
host_backup=
if [[ "$backup_in_volume" =~ ^/data/pre-rotate-[0-9]{8}T[0-9]{6}Z\.db$ ]]; then
  mkdir -p -m 0700 -- "$backup_dir"
  host_backup="$backup_dir/$(basename -- "$backup_in_volume")"
  if [[ ! -e "$host_backup" ]] &&
    (set -o noclobber && compose run --rm --no-deps -T --entrypoint cat session-manager \
      "$backup_in_volume" >"$host_backup.partial") &&
    [[ "$(head -c 15 -- "$host_backup.partial")" == "SQLite format 3" ]]; then
    mv -- "$host_backup.partial" "$host_backup"
  else
    rm -f -- "$host_backup.partial"
    say "warning: could not copy $backup_in_volume out of the data volume"
    host_backup=
  fi
fi
if [[ -n "$host_backup" ]]; then
  restore_from=$host_backup
else
  restore_from="<the backup, copied out first with: docker compose -f $compose_file cp session-manager:${backup_in_volume:-/data/pre-rotate-<timestamp>.db} $backup_dir/>"
fi
rollback=$(
  cat <<EOF
To roll back to the old key (this also discards changes made after the rotation):
  docker compose -f $compose_file stop session-manager
  mv $key $secrets_dir/master_key.rotated
  mv $old_key $key && chmod 0440 $key
  $script_dir/restore.sh --yes $restore_from
EOF
)

# ── 5. start on the new key ──────────────────────────────────────────────────
say "starting session-manager with the new key"
if ! compose start session-manager >&2 || ! wait_healthy; then
  stage=done
  cat >&2 <<EOF
rotate-master-key: session-manager did not become healthy with the new key.
  Check: docker compose -f $compose_file logs session-manager
$rollback
EOF
  exit 1
fi
stage=done

{
  printf 'rotate-master-key: done; session-manager runs with the new master key.\n'
  printf '  new key:  %s\n  old key:  %s (mode 0400)\n' "$key" "$old_key"
  [[ -z "$host_backup" ]] || printf '  backup:   %s\n' "$host_backup"
  [[ -z "$backup_in_volume" ]] || printf '  backup in the data volume: %s\n' "$backup_in_volume"
  printf '\nBack up the new %s somewhere safe, separate from the database backups, in place\n' "$key"
  printf 'of the old copy. Check that sessions connect, then delete the old key and the backups\n'
  printf '(only the old key opens them):\n'
  printf '  rm %s%s\n' "$old_key" "${host_backup:+ $host_backup}"
  [[ -z "$backup_in_volume" ]] ||
    printf '  docker compose -f %s exec session-manager rm -f %s\n' "$compose_file" "$backup_in_volume"
  printf 'Older backups (backup.sh files, app.db.pre-restore-* in the volume) also open with\n'
  printf 'the old key: delete them, or keep them as safe as the old key.\n'
  printf '\n%s\n' "$rollback"
} >&2
