#!/usr/bin/env bash
# Sets a new temporary password for a Termdock user and prints it (plan D-36). For when no admin
# can sign in, e.g. the only admin forgot their password; otherwise an admin resets passwords on
# the user's admin page.
#
# The user signs in with the temporary password and must then choose a new one. Every sign-in of
# the user ends and their open terminals disconnect; their sessions keep running. The reset is
# audited (auth.password_reset, without an actor). TOTP is left as it is.
#
# Usage: deploy/scripts/reset-password.sh <username>
# Runs `reset-password` inside the running session-manager container. The temporary password is
# printed once, on stdout.
#
# Environment (optional, for test stacks such as the release smoke; installs leave it unset):
#   TERMDOCK_COMPOSE_OVERRIDE  a compose file applied on top of deploy/compose.yaml
#   (the stack's project name comes from COMPOSE_PROJECT_NAME, which docker compose reads itself)
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
deploy_dir=$(dirname -- "$script_dir")

die() {
  printf 'reset-password: %s\n' "$*" >&2
  exit 1
}

case "${1:-}" in
  -h | --help)
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
    exit 0
    ;;
esac
(($# == 1)) || die "exactly one username is required (see --help)"

compose_files=(-f "$deploy_dir/compose.yaml")
if [[ -n "${TERMDOCK_COMPOSE_OVERRIDE:-}" ]]; then
  compose_files+=(-f "$TERMDOCK_COMPOSE_OVERRIDE")
fi
compose() { docker compose "${compose_files[@]}" "$@"; }

compose ps --status running --services 2>/dev/null | grep -qx session-manager ||
  die "session-manager is not running (start the stack first)"

compose exec -T session-manager node src/cli/reset-password.ts -- "$1"
