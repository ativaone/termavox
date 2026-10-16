#!/usr/bin/env bash
# Generates the Docker secrets Termdock needs (plan §13.2) into deploy/secrets/, the directory
# deploy/compose.yaml reads them from:
#
#   master_key      vault key: 32 random bytes, base64 (session-manager only)
#   internal_token  internal API bearer token: 64 hex chars (web + session-manager)
#   ws_secret       WebSocket ticket HMAC key: 64 hex chars (web + session-manager)
#   auth_secret     Better Auth signing secret: 64 hex chars (web only)
#
# Permissions: compose mounts each file into the containers as is (owner, group and mode come
# from the host file), and both images run as UID/GID 10001. Every file therefore ends up
# owned by you, group 10001, mode 0440: the containers read it through the group, other host
# users cannot read it. Setting group 10001 needs root unless you belong to that group; the
# script tries, in order: a plain chgrp, a throwaway root container from the pinned Node base
# image (you need the Docker daemon for Termdock anyway), then sudo.
#
# Usage: deploy/scripts/init-secrets.sh [--force]
#   --force  replace existing secret files. Replacing master_key makes every stored credential
#            unreadable (the daemon refuses to start with a different key).
#
# Environment (optional, for test stacks such as the release smoke; installs leave it unset):
#   TERMDOCK_SECRETS_DIR  write the secrets there instead of deploy/secrets/
set -euo pipefail
umask 077

readonly CONTAINER_GID=10001
readonly NAMES=(master_key internal_token ws_secret auth_secret)

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
deploy_dir=$(dirname -- "$script_dir")
secrets_dir=${TERMDOCK_SECRETS_DIR:-"$deploy_dir/secrets"}

die() {
  printf 'init-secrets: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

force=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $arg (see --help)" ;;
  esac
done

command -v openssl >/dev/null 2>&1 || die "openssl is required"

mkdir -p -- "$secrets_dir"
chmod 0700 -- "$secrets_dir"

existing=()
for name in "${NAMES[@]}"; do
  if [[ -e "$secrets_dir/$name" ]]; then existing+=("$name"); fi
done
if ((${#existing[@]} > 0)); then
  if ((force == 0)); then
    die "refusing to overwrite existing secrets in $secrets_dir: ${existing[*]}
  Pass --force to replace them. Replacing master_key makes every stored credential unreadable."
  fi
  printf 'init-secrets: --force: replacing %s\n' "${existing[*]}" >&2
fi

files=()
for name in "${NAMES[@]}"; do
  target="$secrets_dir/$name"
  tmp="$secrets_dir/.$name.tmp.$$"
  case "$name" in
    master_key) openssl rand -base64 32 >"$tmp" ;; # 32 bytes, as the vault expects
    *) openssl rand -hex 32 >"$tmp" ;;             # 256 bits, 64 characters
  esac
  # Rename over the old file: works even when the old one is read-only (0440).
  mv -f -- "$tmp" "$target"
  files+=("$target")
done

# Run with sudo: hand the files back to the invoking user so they stay readable for backups.
if [[ $EUID -eq 0 && -n "${SUDO_UID:-}" ]]; then
  chown -- "$SUDO_UID" "$secrets_dir" "${files[@]}"
fi

set_group() {
  if chgrp -- "$CONTAINER_GID" "${files[@]}" 2>/dev/null; then
    return 0
  fi
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    local image
    image=$(sed -n 's/^FROM \(node:[^ ]*@sha256:[0-9a-f]\{64\}\).*/\1/p' \
      "$deploy_dir/docker/session-manager.Dockerfile" | head -n 1)
    if [[ -n "$image" ]]; then
      printf 'init-secrets: setting group %s through a throwaway root container (%s)\n' \
        "$CONTAINER_GID" "${image%%@*}" >&2
      local in_container=()
      for f in "${files[@]}"; do in_container+=("/secrets/$(basename -- "$f")"); done
      if docker run --rm --network none --user 0:0 --entrypoint chgrp \
        --volume "$secrets_dir:/secrets" "$image" "$CONTAINER_GID" "${in_container[@]}"; then
        return 0
      fi
    fi
  fi
  if command -v sudo >/dev/null 2>&1 && [[ -t 0 ]]; then
    printf 'init-secrets: setting group %s needs root; running sudo chgrp\n' "$CONTAINER_GID" >&2
    sudo chgrp -- "$CONTAINER_GID" "${files[@]}" && return 0
  fi
  return 1
}

if ! set_group; then
  cat >&2 <<EOF
init-secrets: the secrets were created, but they are not readable by the containers yet:
group $CONTAINER_GID could not be set (needs root). Finish with:

  sudo chgrp $CONTAINER_GID $secrets_dir/*
  chmod 0440 $secrets_dir/*

Until then the files stay owner-only (0600) and the services fail to start.
EOF
  exit 2
fi
chmod 0440 -- "${files[@]}"

owner=$(id -un "${SUDO_UID:-$(id -u)}")
cat <<EOF
init-secrets: wrote ${NAMES[*]} to $secrets_dir
  (owner $owner, group $CONTAINER_GID, mode 0440; directory mode 0700)

IMPORTANT: back up $secrets_dir/master_key somewhere safe and separate from the database
backups. Losing it means losing every stored credential.
EOF
