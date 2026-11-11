#!/usr/bin/env bash
# Puts the board's reporter on this machine, or takes it away. Runs as root, from a copy of this folder.
# Every command can run again.
#
#   install.sh install <owner/name> [machine]   with the token on standard input
#   install.sh status
#   install.sh remove
#
# <owner/name> is the environment, and [machine] the name its configuration knows this machine by,
# this machine's short host name by default. The token is a fine-grained one, limited to that
# repository, with "Variables: write" and nothing else: it is read from standard input, so that it is
# never on a command line, and stored where only root reads it. An install without one keeps the token
# already stored.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
readonly LIBEXEC=/usr/local/libexec/board-report
readonly UNITS=/etc/systemd/system
readonly CONFIG=/etc/board-report
readonly UNIT_FILES=(board-report.service board-report.timer)

die() {
  echo "install.sh: $*" >&2
  exit 1
}
[ "$(id -u)" = 0 ] || die "run as root"
command -v curl >/dev/null || die "curl is needed"
command -v systemctl >/dev/null || die "systemd is needed"

# Writes stdin to a file with a mode, replacing it only when it changed.
put() {
  local file=$1 mode=${2:-644} tmp
  tmp=$(mktemp)
  cat >"$tmp"
  if [ -f "$file" ] && cmp -s "$tmp" "$file"; then
    chmod "$mode" "$file"
    rm -f "$tmp"
  else
    install -D -m "$mode" "$tmp" "$file"
    rm -f "$tmp"
  fi
}

variable_of() { printf 'BOARD_HOST_%s' "$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; }

cmd_install() {
  local environment=${1:-} name=${2:-$(hostname -s)} token=''
  [[ $environment =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "expected the environment as owner/name, got '$environment'"
  [[ $name =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "the machine's name is lowercase letters, digits and dashes: '$name'"
  if [ ! -t 0 ]; then token=$(head -c 400 | tr -d '\r\n '); fi
  if [ -n "$token" ]; then
    # A classic token reaches every repository its owner can: only a fine-grained one, limited to the environment.
    [[ $token =~ ^github_pat_[A-Za-z0-9_]{20,255}$ ]] || die "the token must be a fine-grained one (github_pat_...)"
  elif [ ! -s "$CONFIG/token" ]; then
    die "no token: give it on standard input"
  fi

  install -d -m 755 "$CONFIG"
  if [ -n "$token" ]; then printf '%s\n' "$token" | put "$CONFIG/token" 600; fi
  printf 'BOARD_ENV=%s\nBOARD_HOST=%s\n' "$environment" "$name" | put "$CONFIG/environment" 644
  put "$LIBEXEC" 755 <"$here/report.sh"
  local unit
  for unit in "${UNIT_FILES[@]}"; do put "$UNITS/$unit" <"$here/units/$unit"; done
  systemctl daemon-reload
  systemctl enable --now board-report.timer >/dev/null 2>&1
  # The first reading now, rather than at the timer's next turn. A run in progress carries on.
  systemctl start --no-block board-report.service
  echo "board-report done: $name writes $(variable_of "$name") to $environment every minute"
}

cmd_status() {
  echo "-- board-report"
  if [ ! -f "$UNITS/board-report.service" ]; then
    echo "not installed"
    return 0
  fi
  # shellcheck disable=SC1091
  . "$CONFIG/environment" 2>/dev/null || true
  echo "writes $(variable_of "${BOARD_HOST:-?}") to ${BOARD_ENV:-?}; timer: $(systemctl is-active board-report.timer || true)"
  local sent=/var/lib/board-report/sent
  if [ -s "$sent" ]; then
    local at status
    read -r at status <"$sent"
    echo "last sent $(($(date +%s) - at)) s ago, GitHub answered $status"
  else
    echo "nothing sent yet"
  fi
  journalctl -q --no-pager -u board-report.service -p warning -n 3 --since -1h 2>/dev/null || true
}

cmd_remove() {
  local unit
  # The board stops showing this machine: its variable goes, with the token that could write it.
  local api=${REPORT_API:-https://api.github.com}
  [[ $api == https://api.github.com || $api =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || die "REPORT_API is GitHub's"
  if [ -s "$CONFIG/token" ] && [ -s "$CONFIG/environment" ]; then
    (
      # shellcheck disable=SC1091
      . "$CONFIG/environment"
      variable=$(variable_of "$BOARD_HOST")
      status=$(printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\r\n' <"$CONFIG/token")" |
        curl -s --max-time 20 -o /dev/null -w '%{http_code}' -K - -X DELETE -H 'Accept: application/vnd.github+json' \
          "$api/repos/$BOARD_ENV/actions/variables/$variable" || true)
      case $status in
        204 | 404) ;;
        *) echo "the variable $variable stays in $BOARD_ENV (GitHub answered ${status:-nothing}): remove it in the repository's settings" ;;
      esac
    )
  fi
  systemctl disable --now board-report.timer >/dev/null 2>&1 || true
  systemctl stop board-report.service >/dev/null 2>&1 || true
  for unit in "${UNIT_FILES[@]}"; do rm -f "$UNITS/$unit"; done
  rm -f "$LIBEXEC"
  rm -rf "$CONFIG" /var/lib/board-report /var/lib/private/board-report
  systemctl daemon-reload
  systemctl reset-failed 'board-report*' >/dev/null 2>&1 || true
  echo "board-report removed"
}

command=${1:-}
shift || true
case "$command" in
  install) cmd_install "$@" ;;
  status) cmd_status ;;
  remove) cmd_remove ;;
  *) die "expected install, status or remove, got '$command'" ;;
esac
